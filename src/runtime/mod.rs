//! Application-owned editor sessions, independent of the Tauri IPC adapter.
//!
//! The shell runs these synchronous methods on its blocking pool. Each session
//! exclusively owns its core, wire context and derived preview controller. No
//! future or lock is held by the UI event loop.
mod files;
mod watch;

#[cfg(test)]
mod tests;

use celestite_core::{
    editor::{EditorCore, EditorOptions, ExternalChangePolicy},
    error::{EditorError, EditorResult, ErrorCode},
    fs::{EntryKind, FileEntry, WriteMode, native::FsVault},
    instance::{InstanceIdentity, Vault},
    preview::{
        PreviewResource, PreviewResourceKind, PreviewResourceRequest, PreviewTask,
        native::{Context, PackageResources},
        sessions::PreviewController,
    },
    protocol::editor::EditorAdapter,
};
use files::LocalFiles;
use futures_lite::future::block_on;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
    time::{SystemTime, UNIX_EPOCH},
};
use watch::WatchService;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum OpenSource {
    #[default]
    Default,
    Directory {
        path: String,
    },
    Remote {
        identity: InstanceIdentity,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionDescriptor {
    pub(crate) handle: String,
    pub(crate) identity: InstanceIdentity,
    pub(crate) root: Option<String>,
}

type Editor = EditorCore<Arc<LocalFiles>, Arc<FsVault>>;

struct Owner {
    editor: Option<Editor>,
    adapter: EditorAdapter,
    preview: PreviewController,
}
struct Session {
    descriptor: SessionDescriptor,
    packages: Option<PackageResources>,
    files: Option<Arc<LocalFiles>>,
    watches: Option<Arc<WatchService>>,
    owner: Mutex<Owner>,
}
impl Session {
    fn owner(&self) -> EditorResult<MutexGuard<'_, Owner>> {
        let owner = lock(&self.owner)?;
        if owner.editor.is_none() {
            return Err(EditorError::new(
                ErrorCode::Closed,
                "Desktop session is closed",
                &self.descriptor.handle,
            ));
        }
        Ok(owner)
    }
    fn watch_packages(&self, roots: &BTreeSet<PathBuf>) -> EditorResult<()> {
        let Some(watches) = &self.watches else {
            return Ok(());
        };
        for package in roots {
            let mut path = package.clone();
            let mut seen = BTreeSet::new();
            loop {
                if seen.len() >= 40 || !seen.insert(path.clone()) {
                    return Err(EditorError::new(
                        ErrorCode::Unsupported,
                        "Package symbolic link chain is cyclic or too long",
                        &display_directory(package),
                    ));
                }
                let mut prefix = PathBuf::new();
                let mut redirect = None;
                for component in path.components() {
                    prefix.push(component);
                    let metadata = match std::fs::symlink_metadata(&prefix) {
                        Ok(metadata) => metadata,
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
                        Err(error) => return Err(io_error(error, &prefix)),
                    };
                    if metadata.is_symlink() {
                        let parent = prefix.parent().expect("a symbolic link has a parent");
                        let parent = parent
                            .canonicalize()
                            .map_err(|error| io_error(error, parent))?;
                        watches.ensure_directory(&parent)?;
                        let target = std::fs::read_link(&prefix)
                            .map_err(|error| io_error(error, &prefix))?;
                        let target = if target.is_absolute() {
                            target
                        } else {
                            parent.join(target)
                        };
                        let target = target.join(path.strip_prefix(&prefix).expect("path prefix"));
                        let mut normalized = PathBuf::new();
                        for component in target.components() {
                            match component {
                                std::path::Component::CurDir => {}
                                std::path::Component::ParentDir => {
                                    normalized.pop();
                                }
                                component => normalized.push(component),
                            }
                        }
                        redirect = Some(normalized);
                        break;
                    }
                }
                if let Some(target) = redirect {
                    // The explicitly granted alias and its resolved target are
                    // both observed, including a target that does not exist yet.
                    path = target;
                } else {
                    watches.ensure_directory(&path)?;
                    break;
                }
            }
        }
        Ok(())
    }

    fn stop_watching(&self) {
        if let Some(watches) = &self.watches {
            watches.stop();
        }
    }

    fn watch_package_resource(
        &self,
        grant: &celestite_core::preview::native::PackageGrant,
        path: &str,
        directory: bool,
    ) -> EditorResult<()> {
        let Some(watches) = &self.watches else {
            return Ok(());
        };
        match grant.observation_directory(path, directory) {
            Ok(path) => watches.ensure_directory(&path),
            // watch_packages already observes the nearest existing ancestor of
            // a missing package. Keep a missing optional resource an empty read.
            Err(error) if error.code == ErrorCode::NotFound => Ok(()),
            Err(error) => Err(error),
        }
    }
}

/// Call from a native blocking worker. Different sessions may execute in
/// parallel; calls targeting one session serialize over the same mutable owner.
pub(crate) struct DesktopRuntime {
    app_data: PathBuf,
    opening: Mutex<()>,
    sessions: Mutex<BTreeMap<String, Arc<Session>>>,
}
impl DesktopRuntime {
    pub(crate) fn open(app_data: &Path) -> EditorResult<Self> {
        std::fs::create_dir_all(app_data).map_err(|error| io_error(error, app_data))?;
        Ok(Self {
            app_data: app_data
                .canonicalize()
                .map_err(|error| io_error(error, app_data))?,
            opening: Mutex::new(()),
            sessions: Mutex::new(BTreeMap::new()),
        })
    }

    pub(crate) fn open_session(&self, source: OpenSource) -> EditorResult<SessionDescriptor> {
        // Serialize lifecycle changes without holding the session registry over
        // disk/history IO. Existing sessions remain callable during an open.
        let _opening = lock(&self.opening)?;
        let (editor, root, files, watches) = match source {
            OpenSource::Remote { identity } => (
                block_on(Editor::open(identity, None, None))?,
                None,
                None,
                None,
            ),
            source => {
                let (root, history) = match source {
                    OpenSource::Default => {
                        let base = self.app_data.join("default");
                        let root = base.join("files");
                        std::fs::create_dir_all(&root).map_err(|error| io_error(error, &root))?;
                        (root, base.join("history"))
                    }
                    OpenSource::Directory { path } => {
                        let path = PathBuf::from(path);
                        let root = path
                            .canonicalize()
                            .map_err(|error| io_error(error, &path))?;
                        if !root.is_dir() {
                            return Err(EditorError::new(
                                ErrorCode::NotDirectory,
                                "Expected a local directory",
                                &root.to_string_lossy(),
                            ));
                        }
                        let identity = path_string(&root)?;
                        let key = blake3::hash(identity.as_bytes()).to_hex().to_string();
                        (root, self.app_data.join("instances").join(key))
                    }
                    OpenSource::Remote { .. } => unreachable!(),
                };
                let root = root
                    .canonicalize()
                    .map_err(|error| io_error(error, &root))?;
                if self.app_data.starts_with(&root) {
                    return Err(EditorError::new(
                        ErrorCode::InvalidPath,
                        "Private recovery data must be outside the Vault",
                        &root.to_string_lossy(),
                    ));
                }
                let root_string = path_string(&root)?;
                if let Some(session) = lock(&self.sessions)?
                    .values()
                    .find(|session| session.descriptor.root.as_ref() == Some(&root_string))
                {
                    // WebView reloads reconnect to the existing owner. Its
                    // accepted draft, wire contexts and undo must survive.
                    return Ok(session.descriptor.clone());
                }
                let history = private_recovery_path(&root, &history)?;
                let watches = Arc::new(WatchService::new(root.clone())?);
                let recovery = Arc::new(FsVault::open_private(&history)?);
                let identity = local_identity(&recovery)?;
                let files = Arc::new(LocalFiles::new(
                    Arc::new(FsVault::open(&root).map_err(|error| io_error(error, &root))?),
                    root.clone(),
                    watches.clone(),
                )?);
                let core = block_on(Editor::open_with_options(
                    identity,
                    Some(files.clone()),
                    Some(recovery),
                    EditorOptions {
                        external_changes: ExternalChangePolicy::Merge,
                        defer_filesystem_diff: false,
                        ..Default::default()
                    },
                ))?;
                for document in core.resident_status()? {
                    if !document.deleted {
                        watches.enqueue_path(&root.join(document.path))?;
                    }
                }
                (core, Some(root_string), Some(files), Some(watches))
            }
        };
        let descriptor = SessionDescriptor {
            handle: uuid::Uuid::new_v4().to_string(),
            identity: editor.identity().clone(),
            root,
        };
        let session = Session {
            packages: descriptor
                .root
                .as_ref()
                .map(|root| PackageResources::new(PathBuf::from(root))),
            files,
            watches,
            descriptor: descriptor.clone(),
            owner: Mutex::new(Owner {
                editor: Some(editor),
                adapter: EditorAdapter::default(),
                preview: PreviewController::default(),
            }),
        };
        lock(&self.sessions)?.insert(descriptor.handle.clone(), Arc::new(session));
        Ok(descriptor)
    }

    fn session(&self, handle: &str) -> EditorResult<Arc<Session>> {
        lock(&self.sessions)?.get(handle).cloned().ok_or_else(|| {
            EditorError::new(
                ErrorCode::Closed,
                "Desktop session is closed or unknown",
                handle,
            )
        })
    }

    /// Same envelope as the WASM binding, including accepted effects of failed
    /// commands. The caller delivers mutations before interpreting the outcome.
    pub(crate) fn core(&self, handle: &str, method: &str, params: Value) -> EditorResult<Value> {
        let session = self.session(handle)?;
        let mut owner = session.owner()?;
        let Owner {
            editor, adapter, ..
        } = &mut *owner;
        let editor = editor.as_mut().expect("a live owner has an editor");
        let result = block_on(adapter.call(editor, method, params));
        let mutations = adapter.take_mutations(editor);
        let (result, mutations) = match mutations {
            Ok(mutations) => (result, mutations),
            // The adapter retains unencoded receipts for the next call.
            Err(error) => (Err(error), vec![]),
        };
        Ok(match result {
            Ok(value) => json!({"status":"ok", "value":value, "mutations":mutations}),
            Err(error) => json!({"status":"error", "error":error, "mutations":mutations}),
        })
    }

    pub(crate) fn preview(&self, handle: &str, method: &str, params: Value) -> EditorResult<Value> {
        let session = self.session(handle)?;
        let mut owner = session.owner()?;
        let preview = &mut owner.preview;
        let id = params["id"].as_str().unwrap_or("");
        let client = params["sessionId"].as_str().unwrap_or("");
        let value = match method {
            "synchronize" => serde_json::to_value(
                preview.synchronize(&decode(params["source"].clone())?, now_ms()),
            ),
            "subscribe" => serde_json::to_value(preview.subscribe(id, client, now_ms())?),
            "unsubscribe" => serde_json::to_value(
                preview.unsubscribe(required_str(&params, "subscriptionId")?, client),
            ),
            "release_client" => {
                preview.release_client(client);
                Ok(Value::Null)
            }
            "state" => serde_json::to_value(preview.state(id)?),
            "required_snapshots" => serde_json::to_value(preview.required_snapshots(id)?),
            "take_task" => {
                let mut task =
                    preview.take_task(id, &decode(params["source"].clone())?, now_ms())?;
                if let (Some(task), Some(root)) = (&mut task, &session.descriptor.root) {
                    task.resource_root.clone_from(root);
                }
                serde_json::to_value(task)
            }
            "complete" => {
                serde_json::to_value(preview.complete(decode(params["completion"].clone())?))
            }
            "retry" => serde_json::to_value(preview.retry(id, now_ms())?),
            "events" => serde_json::to_value(preview.take_events()),
            "link" => serde_json::to_value(preview.link(
                id,
                required_str(&params, "taskId")?,
                required_str(&params, "target")?,
            )?),
            "invalidate_project" => {
                preview.invalidate_project(now_ms());
                Ok(Value::Null)
            }
            "clear" => {
                preview.clear();
                Ok(Value::Null)
            }
            _ => {
                return Err(EditorError::new(
                    ErrorCode::Unsupported,
                    "Unknown preview operation",
                    method,
                ));
            }
        };
        value.map_err(|error| EditorError::new(ErrorCode::Io, error.to_string(), ""))
    }

    pub(crate) fn package_read(
        &self,
        handle: &str,
        task: PreviewTask,
        request: PreviewResourceRequest,
    ) -> EditorResult<PreviewResource> {
        let session = self.session(handle)?;
        // Read-only immutable task IO does not borrow the editing owner. An
        // already-started read can finish after close; its late completion is
        // rejected by the preview controller's ticket checks.
        drop(session.owner()?);
        let packages = session.packages.as_ref().ok_or_else(no_local_resources)?;
        if !Path::new(&request.path).is_absolute() {
            let files = session.files.as_ref().ok_or_else(no_local_resources)?;
            let kind = match files.stat(&request.path)?.map(|entry| entry.kind) {
                None => None,
                Some(EntryKind::File) => Some(PreviewResourceKind::File),
                Some(EntryKind::Directory) => Some(PreviewResourceKind::Directory),
                _ => {
                    return Err(EditorError::new(
                        ErrorCode::Unsupported,
                        "Preview resource must be a file or directory",
                        &request.path,
                    ));
                }
            };
            let data = if request.read && kind == Some(PreviewResourceKind::File) {
                Some(files.read_file_limited(&request.path, 16 * 1024 * 1024)?)
            } else {
                None
            };
            return Ok(PreviewResource {
                kind,
                data,
                error: None,
            });
        }
        let grant = packages.grant(&Context {
            document_path: task.ticket.path,
            overlays: task.overlays,
        })?;
        session.watch_packages(grant.roots())?;
        session.watch_package_resource(&grant, &request.path, false)?;
        grant.read(request)
    }

    pub(crate) fn package_directory(
        &self,
        handle: &str,
        task: PreviewTask,
        path: &str,
    ) -> EditorResult<Vec<FileEntry>> {
        let session = self.session(handle)?;
        drop(session.owner()?);
        let packages = session.packages.as_ref().ok_or_else(no_local_resources)?;
        if !Path::new(path).is_absolute() {
            return session
                .files
                .as_ref()
                .ok_or_else(no_local_resources)?
                .read_dir(path);
        }
        let grant = packages.grant(&Context {
            document_path: task.ticket.path,
            overlays: task.overlays,
        })?;
        session.watch_packages(grant.roots())?;
        session.watch_package_resource(&grant, path, true)?;
        grant.directory(path)
    }

    /// Drain one coalesced native watch hint. Reading files and editing private
    /// history produce no projection hint; external errors conservatively do.
    pub(crate) fn changes(&self, handle: &str) -> EditorResult<bool> {
        let session = self.session(handle)?;
        let _owner = session.owner()?;
        session
            .watches
            .as_ref()
            .map_or(Ok(false), |watches| watches.take_changes())
    }

    /// Keep the session and its history lock available if persistence fails.
    pub(crate) fn close_session(&self, handle: &str) -> EditorResult<()> {
        let _opening = lock(&self.opening)?;
        let mut sessions = lock(&self.sessions)?;
        let session = sessions.get(handle).ok_or_else(|| {
            EditorError::new(
                ErrorCode::Closed,
                "Desktop session is closed or unknown",
                handle,
            )
        })?;
        {
            let mut owner = session.owner()?;
            block_on(
                owner
                    .editor
                    .as_mut()
                    .expect("a live owner has an editor")
                    .close(),
            )?;
            owner.preview.clear();
            owner.editor = None;
        }
        session.stop_watching();
        sessions.remove(handle);
        Ok(())
    }

    /// A replacement WebView keeps native local owners but revokes the old
    /// view's preview subscriptions/tasks and abandoned volatile replicas.
    /// Follow the same registry-before-owner lock order as close and shutdown.
    pub(crate) fn reset_views(&self) -> EditorResult<()> {
        let _opening = lock(&self.opening)?;
        let mut sessions = lock(&self.sessions)?;
        let live: Vec<_> = sessions.values().cloned().collect();
        let mut owners = live
            .iter()
            .map(|session| session.owner())
            .collect::<EditorResult<Vec<_>>>()?;
        for (session, owner) in live.iter().zip(&mut owners) {
            if session.descriptor.root.is_none() {
                block_on(
                    owner
                        .editor
                        .as_mut()
                        .expect("a live owner has an editor")
                        .close(),
                )?;
            }
        }
        for (session, owner) in live.iter().zip(&mut owners) {
            // A replacement view starts a new event stream. clear() revokes
            // tasks but deliberately preserves sequence numbers and queued
            // closure events for the existing consumer.
            owner.preview = PreviewController::default();
            if session.descriptor.root.is_none() {
                owner.editor = None;
            }
        }
        sessions.retain(|_, session| session.descriptor.root.is_some());
        Ok(())
    }

    /// Lock all owners until every close succeeds. A failed shutdown releases
    /// no owner, so the UI can report the failure and retry without losing edits.
    pub(crate) fn shutdown(&self) -> EditorResult<()> {
        let _opening = lock(&self.opening)?;
        let mut sessions = lock(&self.sessions)?;
        let live: Vec<_> = sessions.values().cloned().collect();
        let mut owners = live
            .iter()
            .map(|session| session.owner())
            .collect::<EditorResult<Vec<_>>>()?;
        for owner in &mut owners {
            block_on(
                owner
                    .editor
                    .as_mut()
                    .expect("a live owner has an editor")
                    .close(),
            )?;
        }
        for owner in &mut owners {
            owner.preview.clear();
            owner.editor = None;
        }
        for session in &live {
            session.stop_watching();
        }
        sessions.clear();
        Ok(())
    }
}

fn lock<T>(mutex: &Mutex<T>) -> EditorResult<MutexGuard<'_, T>> {
    mutex
        .lock()
        .map_err(|_| EditorError::new(ErrorCode::Io, "Desktop owner lock failed", ""))
}
fn decode<T: DeserializeOwned>(value: Value) -> EditorResult<T> {
    serde_json::from_value(value)
        .map_err(|error| EditorError::new(ErrorCode::InvalidEdit, error.to_string(), ""))
}
fn required_str<'a>(params: &'a Value, field: &str) -> EditorResult<&'a str> {
    params[field]
        .as_str()
        .ok_or_else(|| EditorError::new(ErrorCode::InvalidEdit, format!("Missing {field}"), ""))
}
fn no_local_resources() -> EditorError {
    EditorError::new(
        ErrorCode::Unsupported,
        "Remote replica resources are provided by their host",
        "",
    )
}
fn path_string(path: &Path) -> EditorResult<String> {
    path.to_str().ok_or_else(|| {
        EditorError::new(
            ErrorCode::Unsupported,
            "Non-UTF-8 directory paths are not supported",
            &path.to_string_lossy(),
        )
    })?;
    Ok(display_directory(path))
}

pub(crate) fn display_directory(path: &Path) -> String {
    let path = path.to_string_lossy();
    #[cfg(windows)]
    let path = {
        // std canonicalization uses verbatim paths. The shell and preview use
        // ordinary absolute identities with one separator convention.
        let path = path
            .strip_prefix("\\\\?\\UNC\\")
            .map(|tail| format!("//{tail}"))
            .unwrap_or_else(|| path.strip_prefix("\\\\?\\").unwrap_or(&path).to_owned());
        path.replace('\\', "/")
    };
    path.to_string()
}
fn io_error(error: std::io::Error, path: &Path) -> EditorError {
    let code = match error.kind() {
        std::io::ErrorKind::NotFound => ErrorCode::NotFound,
        std::io::ErrorKind::PermissionDenied => ErrorCode::PermissionDenied,
        std::io::ErrorKind::NotADirectory => ErrorCode::NotDirectory,
        _ => ErrorCode::Io,
    };
    EditorError::new(code, error.to_string(), &path.to_string_lossy())
}
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn private_recovery_path(root: &Path, requested: &Path) -> EditorResult<PathBuf> {
    // Resolve existing ancestors before creating anything: an instances or
    // recovery directory may have been redirected into the ordinary Vault.
    let mut ancestor = requested;
    let mut missing = Vec::new();
    let resolved = loop {
        match ancestor.canonicalize() {
            Ok(mut path) => {
                for name in missing.iter().rev() {
                    path.push(name);
                }
                break path;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let Some(name) = ancestor.file_name() else {
                    return Err(io_error(error, requested));
                };
                missing.push(name.to_owned());
                ancestor = ancestor
                    .parent()
                    .expect("a named recovery path has a parent");
            }
            Err(error) => return Err(io_error(error, requested)),
        }
    };
    let outside_vault = |path: &Path| {
        if path.starts_with(root) {
            Err(EditorError::new(
                ErrorCode::InvalidPath,
                "Private recovery data must be outside the Vault",
                &path.to_string_lossy(),
            ))
        } else {
            Ok(())
        }
    };
    outside_vault(&resolved)?;
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder
        .create(requested)
        .map_err(|error| io_error(error, requested))?;
    let actual = requested
        .canonicalize()
        .map_err(|error| io_error(error, requested))?;
    outside_vault(&actual)?;
    Ok(actual)
}

#[derive(Serialize, Deserialize)]
struct LocalIdentity {
    instance_id: String,
    vault_id: String,
}

fn local_identity(recovery: &FsVault) -> EditorResult<InstanceIdentity> {
    let read = |path: &str| match recovery.read_file_limited(path, 1024 * 1024) {
        Ok(bytes) => serde_json::from_slice::<Value>(&bytes)
            .map(Some)
            .map_err(|error| EditorError::new(ErrorCode::Io, error.to_string(), path)),
        Err(error) if error.code == ErrorCode::NotFound => Ok(None),
        Err(error) => Err(error),
    };
    let stored = read("instance.json")?;
    let create = stored.is_none();
    let profile = match stored {
        Some(value) => serde_json::from_value::<LocalIdentity>(value)
            .map_err(|error| EditorError::new(ErrorCode::Io, error.to_string(), "instance.json"))?,
        None => {
            // Only stable IDs are reused from the retired CRDT manifest.
            let legacy = read("manifest.json")?
                .map(|value| {
                    serde_json::from_value::<InstanceIdentity>(value["identity"].clone()).map_err(
                        |error| EditorError::new(ErrorCode::Io, error.to_string(), "manifest.json"),
                    )
                })
                .transpose()?;
            legacy.map_or_else(
                || LocalIdentity {
                    instance_id: uuid::Uuid::new_v4().to_string(),
                    vault_id: uuid::Uuid::new_v4().to_string(),
                },
                |identity| LocalIdentity {
                    instance_id: identity.instance_id,
                    vault_id: identity.vault.vault_id,
                },
            )
        }
    };
    if profile.instance_id.is_empty() || profile.vault_id.is_empty() {
        return Err(EditorError::new(
            ErrorCode::Io,
            "Invalid local instance identity",
            "instance.json",
        ));
    }
    if create {
        let bytes = serde_json::to_vec(&profile)
            .map_err(|error| EditorError::new(ErrorCode::Io, error.to_string(), "instance.json"))?;
        recovery.write_file("instance.json", &bytes, WriteMode::Upsert, None)?;
    }
    Ok(InstanceIdentity {
        instance_id: profile.instance_id,
        vault: Vault {
            vault_id: profile.vault_id,
            history_id: uuid::Uuid::new_v4().to_string(),
        },
    })
}

#[cfg(test)]
mod owner_lifetime {
    use super::{DesktopRuntime, OpenSource};

    #[test]
    fn completed_close_releases_history_lock_even_while_derived_io_holds_a_session() {
        let storage = tempfile::tempdir().unwrap();
        let runtime = DesktopRuntime::open(storage.path()).unwrap();
        let opened = runtime.open_session(OpenSource::Default).unwrap();
        // A package read retains this immutable session reference while doing
        // IO outside the editor lock. It must not retain the native core lock.
        let derived_reader = runtime.session(&opened.handle).unwrap();
        runtime.close_session(&opened.handle).unwrap();
        let reopened = runtime.open_session(OpenSource::Default).unwrap();
        assert_eq!(opened.identity.instance_id, reopened.identity.instance_id);
        assert_eq!(
            opened.identity.vault.vault_id,
            reopened.identity.vault.vault_id
        );
        assert_ne!(
            opened.identity.vault.history_id,
            reopened.identity.vault.history_id
        );
        assert!(derived_reader.owner().is_err());
        let second_reader = runtime.session(&reopened.handle).unwrap();
        runtime.shutdown().unwrap();
        runtime.open_session(OpenSource::Default).unwrap();
        assert!(second_reader.owner().is_err());
        runtime.shutdown().unwrap();
    }
}
