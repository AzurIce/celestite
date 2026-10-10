//! Read-only package IO. Notist discovers dependencies; Vault file/history IO stays separate.
use crate::{
    vault::fs::{self, ChangeHint, Entry, FsVault, VaultError},
    ApiError, RemoteAccess, ServerState,
};
use axum::{routing::post, Extension, Json, Router};
use celestite_core::preview::{PreviewResource, PreviewResourceKind, PreviewResourceRequest};
use notify::{RecursiveMode, Watcher};
use notist::{resources::ResourceKind, ResourceError, Resources};
use serde::Deserialize;
use std::{
    cell::RefCell,
    collections::{BTreeMap, BTreeSet},
    io::Read,
    path::{Path as FsPath, PathBuf},
    sync::{Arc, Mutex},
};
use tokio::sync::broadcast;

const LIMIT: u64 = 16 * 1024 * 1024;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Context {
    document_path: String,
    #[serde(default)]
    overlays: BTreeMap<String, String>,
}
#[derive(Deserialize)]
struct ReadRequest {
    context: Context,
    request: PreviewResourceRequest,
}
#[derive(Deserialize)]
struct DirectoryRequest {
    context: Context,
    path: String,
}
struct Discovery<'a> {
    root: &'a FsPath,
    overlays: BTreeMap<PathBuf, &'a str>,
    packages: RefCell<BTreeSet<PathBuf>>,
}
impl Resources for Discovery<'_> {
    fn root(&self) -> &FsPath {
        self.root
    }
    fn read(&self, path: &FsPath) -> Result<Vec<u8>, ResourceError> {
        let path = self.resolve(path);
        if path.file_name().is_some_and(|name| name == "lib.notc")
            || (!path.starts_with(self.root)
                && path.file_name().is_some_and(|name| name == "Notist.toml"))
        {
            self.packages
                .borrow_mut()
                .insert(path.parent().unwrap().to_owned());
        }
        if let Some(source) = self.overlays.get(&path) {
            return Ok(source.as_bytes().to_vec());
        }
        let access = |error: std::io::Error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                ResourceError::NotFound(path.clone())
            } else {
                ResourceError::Access {
                    path: path.clone(),
                    message: error.to_string(),
                }
            }
        };
        let file = std::fs::File::open(&path).map_err(access)?;
        let mut data = Vec::new();
        file.take(LIMIT + 1)
            .read_to_end(&mut data)
            .map_err(access)?;
        if data.len() as u64 > LIMIT {
            return Err(ResourceError::Access {
                path,
                message: "package input exceeds 16 MiB".into(),
            });
        }
        Ok(data)
    }
    fn kind(&self, path: &FsPath) -> Result<Option<ResourceKind>, ResourceError> {
        let path = self.resolve(path);
        // Nearest document configuration remains scoped to the document Vault.
        if !path.starts_with(self.root) {
            return Ok(None);
        }
        if self.overlays.contains_key(&path) {
            return Ok(Some(ResourceKind::File));
        }
        notist::FsResources::new(self.root).kind(&path)
    }
    fn entries(&self, _: &FsPath) -> Result<Vec<PathBuf>, ResourceError> {
        Ok(vec![])
    }
    fn source(&self, path: &FsPath) -> Result<String, ResourceError> {
        let source = String::from_utf8(self.read(path)?)
            .map_err(|_| ResourceError::InvalidUtf8(self.resolve(path)))?;
        Ok(source
            .trim_start_matches('\u{feff}')
            .replace("\r\n", "\n")
            .replace('\r', "\n"))
    }
}
struct Watches {
    watcher: notify::RecommendedWatcher,
    paths: BTreeSet<PathBuf>,
}
pub(crate) struct PackageResources {
    pub root: PathBuf,
    watches: Mutex<Watches>,
}
impl PackageResources {
    pub fn new(
        root: PathBuf,
        events: broadcast::Sender<ChangeHint>,
    ) -> Result<Self, notify::Error> {
        let watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
            if !matches!(event, Ok(ref event) if event.kind.is_access()) {
                // No reconciliation: package content never joins the document histories.
                let _ = events.send(ChangeHint::all());
            }
        })?;
        Ok(Self {
            root,
            watches: Mutex::new(Watches {
                watcher,
                paths: BTreeSet::new(),
            }),
        })
    }
    fn packages(&self, context: &Context) -> fs::Result<BTreeSet<PathBuf>> {
        fs::validate_path(&context.document_path)?;
        let mut overlays = BTreeMap::new();
        let mut bytes = 0usize;
        for (path, source) in &context.overlays {
            let identity = if path.starts_with('/') {
                let identity = FsPath::new(path);
                if notist::resources::normalize(identity) != identity {
                    return Err(VaultError::new(
                        "InvalidPath",
                        "Expected a normalized package manifest identity",
                        path,
                    ));
                }
                identity.to_owned()
            } else {
                fs::validate_path(path)?;
                self.root.join(path)
            };
            if FsPath::new(path)
                .file_name()
                .is_none_or(|name| name != "Notist.toml")
            {
                return Err(VaultError::new(
                    "InvalidPath",
                    "Only Notist configuration snapshots are accepted",
                    path,
                ));
            }
            bytes = bytes.saturating_add(source.len());
            if bytes > 32 * 1024 * 1024 {
                return Err(VaultError::new(
                    "Unsupported",
                    "Configuration overlays exceed 32 MiB",
                    path,
                ));
            }
            // External snapshots are consulted only when Notist reaches them through
            // the document's dependency graph. They do not grant arbitrary resource IO.
            overlays.insert(identity, source.as_str());
        }
        let resources = Discovery {
            root: &self.root,
            overlays,
            packages: RefCell::new(BTreeSet::new()),
        };
        // Capture Notist's manifest/declaration reads even when assembly is invalid.
        let _ = notist::Vault::new(&resources).environment_for(&context.document_path);
        let packages = resources.packages.into_inner();
        let mut watches = self
            .watches
            .lock()
            .map_err(|_| VaultError::new("IO", "Package watcher lock failed", ""))?;
        for root in &packages {
            if root.starts_with(&self.root) {
                continue;
            }
            let mut ancestor = root.as_path();
            while !ancestor.is_dir() {
                let Some(parent) = ancestor.parent() else {
                    break;
                };
                ancestor = parent;
            }
            for (path, mode) in [
                (ancestor.to_owned(), RecursiveMode::NonRecursive),
                (root.join("components"), RecursiveMode::Recursive),
            ] {
                if !path.is_dir() || watches.paths.contains(&path) {
                    continue;
                }
                if watches.paths.len() >= 2048 {
                    return Err(VaultError::new(
                        "Unsupported",
                        "Too many package resource directories",
                        "",
                    ));
                }
                watches
                    .watcher
                    .watch(&path, mode)
                    .map_err(|error| VaultError::new("IO", error.to_string(), ""))?;
                watches.paths.insert(path);
            }
        }
        Ok(packages)
    }
    fn resolve(&self, context: &Context, path: &str) -> fs::Result<(FsVault, String)> {
        let resource = FsPath::new(path);
        if !resource.is_absolute() || notist::resources::normalize(resource) != resource {
            return Err(VaultError::new(
                "InvalidPath",
                "Expected an absolute package resource identity",
                path,
            ));
        }
        for root in self.packages(context)? {
            let Ok(relative) = resource.strip_prefix(&root) else {
                continue;
            };
            if relative.as_os_str().is_empty()
                || relative == FsPath::new("lib.notc")
                || relative == FsPath::new("Notist.toml")
                || relative.starts_with("components")
            {
                let relative = relative.to_str().ok_or_else(|| {
                    VaultError::new("InvalidPath", "Package resource path is not UTF-8", path)
                })?;
                fs::validate_path(relative)?;
                // An explicit package directory may itself be a symlink. Its contents use
                // the same capability-based IO as Vaults; internal symlinks are rejected.
                let canonical = match root.canonicalize() {
                    Ok(path) => path,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                        return Err(VaultError::new(
                            "NotFound",
                            "Package directory does not exist",
                            path,
                        ))
                    }
                    Err(error) => return Err(VaultError::new("IO", error.to_string(), path)),
                };
                return FsVault::open(&canonical)
                    .map(|files| (files, relative.to_owned()))
                    .map_err(|error| VaultError::new("IO", error.to_string(), path));
            }
        }
        Err(VaultError::new(
            "PermissionDenied",
            "Resource is not a manifest, declaration or component of a configured package",
            path,
        ))
    }
    fn read(&self, input: ReadRequest) -> fs::Result<PreviewResource> {
        let (files, path) = match self.resolve(&input.context, &input.request.path) {
            Err(error) if error.code == "NotFound" => {
                return Ok(PreviewResource {
                    kind: None,
                    data: None,
                    error: None,
                })
            }
            other => other?,
        };
        let Some(stat) = files.stat(&path)? else {
            return Ok(PreviewResource {
                kind: None,
                data: None,
                error: None,
            });
        };
        let kind = match stat.kind {
            "file" => PreviewResourceKind::File,
            "directory" => PreviewResourceKind::Directory,
            _ => {
                return Err(VaultError::new(
                    "Unsupported",
                    "Package resource must be a file or directory",
                    &input.request.path,
                ))
            }
        };
        let data = if input.request.read && kind == PreviewResourceKind::File {
            Some(files.read_file_limited(&path, LIMIT)?)
        } else {
            None
        };
        Ok(PreviewResource {
            kind: Some(kind),
            data,
            error: None,
        })
    }
    fn directory(&self, input: DirectoryRequest) -> fs::Result<Vec<Entry>> {
        let (files, path) = self.resolve(&input.context, &input.path)?;
        let mut entries = files.read_dir(&path)?;
        for entry in &mut entries {
            entry.path = format!(
                "{}/{}",
                input.path,
                FsPath::new(&entry.path)
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
            );
        }
        Ok(entries)
    }
}
pub(crate) fn routes() -> Router<Arc<ServerState>> {
    Router::new()
        .route("/{id}/api/v1/preview/resources", post(read))
        .route("/{id}/api/v1/preview/directory", post(directory))
}
async fn read(
    Extension(access): Extension<RemoteAccess>,
    Json(input): Json<ReadRequest>,
) -> Result<Json<PreviewResource>, ApiError> {
    let vault = access.grant.vault.clone();
    tokio::task::spawn_blocking(move || vault.packages.read(input))
        .await
        .map_err(|_| crate::failure("IO", "Package IO failed"))?
        .map(Json)
        .map_err(Into::into)
}
async fn directory(
    Extension(access): Extension<RemoteAccess>,
    Json(input): Json<DirectoryRequest>,
) -> Result<Json<Vec<Entry>>, ApiError> {
    let vault = access.grant.vault.clone();
    tokio::task::spawn_blocking(move || vault.packages.directory(input))
        .await
        .map_err(|_| crate::failure("IO", "Package IO failed"))?
        .map(Json)
        .map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::{Context, PackageResources};
    use crate::testing::Host;
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use http_body_util::BodyExt;
    use std::collections::BTreeMap;
    use tokio::sync::broadcast;
    use tower::ServiceExt;

    async fn call(
        router: &Host,
        route: &str,
        input: serde_json::Value,
    ) -> axum::response::Response {
        router
            .router
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(router.uri(&format!("/preview/{route}")))
                    .header("content-type", "application/json")
                    .body(Body::from(input.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap()
    }
    #[tokio::test]
    async fn sibling_packages_use_notist_configuration_and_stay_out_of_document_history() {
        let repository = tempfile::tempdir().unwrap();
        // Requests use the same canonical identities exposed by the server;
        // macOS temporary paths commonly pass through the /var symlink.
        let repository_root = repository.path().canonicalize().unwrap();
        let root = repository_root.join("docs");
        let package = repository_root.join("packages/widgets");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(package.join("components/panel")).unwrap();
        std::fs::write(
            root.join("Notist.toml"),
            "[dependencies]\nwidgets = {path = '../packages/widgets'}",
        )
        .unwrap();
        std::fs::write(root.join("a.not"), "#widgets::panel()[body]").unwrap();
        std::fs::write(
            package.join("Notist.toml"),
            "[package]\nname = 'widgets'\n[dependencies]\nkatex = {path = '../katex'}\n",
        )
        .unwrap();
        let transitive = repository_root.join("packages/katex");
        std::fs::create_dir_all(&transitive).unwrap();
        std::fs::write(
            transitive.join("Notist.toml"),
            "[package]\nname = 'katex'\n",
        )
        .unwrap();
        std::fs::write(
            transitive.join("lib.notc"),
            "fn math(text: String) -> InlineContent;",
        )
        .unwrap();
        std::fs::write(
            package.join("lib.notc"),
            "fn panel()[children: Content] -> Content;",
        )
        .unwrap();
        std::fs::write(
            package.join("components/panel/index.js"),
            "export default class extends HTMLElement {}",
        )
        .unwrap();
        std::fs::write(package.join("private.txt"), "not a component").unwrap();
        let config = crate::Config {
            server: crate::ServerConfig::default(),
            vault: crate::VaultConfig {
                name: "Docs".into(),
                path: root.clone(),
                ..Default::default()
            },
        };
        let router = Host::new(crate::build_server(config, &repository_root).unwrap());
        let context = serde_json::json!({"documentPath": "a.not", "overlays": {}});
        let declaration = call(&router, "resources", serde_json::json!({"context":context, "request":{"path":package.join("lib.notc"), "read":true}})).await;
        assert_eq!(declaration.status(), StatusCode::OK);
        let data: serde_json::Value =
            serde_json::from_slice(&declaration.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert_eq!(data["kind"], "file");
        assert!(!data["data"].as_array().unwrap().is_empty());
        let manifest = call(&router, "resources", serde_json::json!({"context":context, "request":{"path":transitive.join("Notist.toml"), "read":true}})).await;
        assert_eq!(manifest.status(), StatusCode::OK);
        // Resource grants must follow the exact manifest snapshot used by the Worker.
        let snapshot = serde_json::json!({"documentPath":"a.not", "overlays":{package.join("Notist.toml").to_str().unwrap(): "[package]\nname = 'widgets'\n"}});
        let revoked = call(&router, "resources", serde_json::json!({"context":snapshot, "request":{"path":transitive.join("lib.notc"),"read":true}})).await;
        assert_eq!(revoked.status(), StatusCode::FORBIDDEN);
        let entries = call(
            &router,
            "directory",
            serde_json::json!({"context":context, "path":package.join("components/panel")}),
        )
        .await;
        assert_eq!(entries.status(), StatusCode::OK);
        let data: serde_json::Value =
            serde_json::from_slice(&entries.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert_eq!(
            data[0]["path"],
            package.join("components/panel/index.js").to_str().unwrap()
        );
        for path in [
            package.join("private.txt"),
            repository_root.join("secret.txt"),
            package.join("components/../private.txt"),
        ] {
            let denied = call(
                &router,
                "resources",
                serde_json::json!({"context":context, "request":{"path":path, "read":true}}),
            )
            .await;
            assert!(denied.status().is_client_error());
        }
        // Configuration edits are snapshots: no write to the saved configuration.
        let overlay = serde_json::json!({"documentPath":"a.not", "overlays":{"Notist.toml":"[dependencies]\nother = {path = '../packages/missing'}"}});
        let revoked = call(&router, "resources", serde_json::json!({"context":overlay, "request":{"path":package.join("lib.notc"),"read":true}})).await;
        assert_eq!(revoked.status(), StatusCode::FORBIDDEN);
        assert!(std::fs::read_to_string(root.join("Notist.toml"))
            .unwrap()
            .contains("widgets"));
        let resources = PackageResources::new(root.clone(), broadcast::channel(8).0).unwrap();
        assert!(resources
            .packages(&Context {
                document_path: "a.not".into(),
                overlays: BTreeMap::new()
            })
            .unwrap()
            .contains(&package));
        let mut documents = crate::vault::documents::Documents::open(&root, &[0; 32]).unwrap();
        documents.open_file("a.not").unwrap();
        assert!(documents
            .resident()
            .unwrap()
            .iter()
            .all(|doc| !doc.path.contains("lib.notc") && !doc.path.contains("components")));
    }
}
