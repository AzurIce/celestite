//! Notist drives resource discovery; platforms answer queries asynchronously.
use super::{
    PreviewDiagnostic, PreviewDiagnosticOrigin, PreviewResourceKind, PreviewResourceRequest,
    PreviewTask,
    manifests::ManifestSource,
    paths::{ResourceNamespace, ResourcePath},
};
use crate::fs::validate_path;
use notist::{ResourceError, Resources, resources::ResourceKind};
use std::{
    cell::RefCell,
    collections::BTreeMap,
    path::{Path, PathBuf},
};

pub(super) fn resource_key(root: &str, path: &Path) -> String {
    ResourceNamespace::new(root).key(path)
}

pub(super) struct SnapshotResources<'a> {
    task: &'a PreviewTask,
    namespace: ResourceNamespace,
    manifests: RefCell<BTreeMap<PathBuf, ManifestSource>>,
    requests: RefCell<BTreeMap<String, bool>>,
    allow_commands: bool,
}
impl<'a> SnapshotResources<'a> {
    pub(super) fn new(task: &'a PreviewTask) -> Self {
        // Browser hosts let Notist report that process extensions are
        // unavailable. Native logical execution is also used for remote
        // replicas, whose configuration must never execute local processes.
        #[cfg(all(feature = "native", not(target_arch = "wasm32")))]
        let allow_commands = false;
        #[cfg(not(all(feature = "native", not(target_arch = "wasm32"))))]
        let allow_commands = true;
        Self::with_mode(task, false, allow_commands)
    }

    /// Native execution maps logical paths to real paths so process extensions
    /// receive the real configuration directory as their working directory.
    #[cfg(all(feature = "native", not(target_arch = "wasm32")))]
    pub(super) fn native(task: &'a PreviewTask) -> Self {
        Self::with_mode(task, true, true)
    }

    /// Discovery must stay free of user processes while still walking the
    /// replace/module graph for resource preparation.
    pub(super) fn discovery(task: &'a PreviewTask) -> Self {
        Self::with_mode(task, false, false)
    }

    fn with_mode(task: &'a PreviewTask, _native: bool, allow_commands: bool) -> Self {
        #[cfg(all(feature = "native", not(target_arch = "wasm32")))]
        let namespace = if _native {
            ResourceNamespace::native(&task.resource_root)
        } else {
            ResourceNamespace::new(&task.resource_root)
        };
        #[cfg(not(all(feature = "native", not(target_arch = "wasm32"))))]
        let namespace = ResourceNamespace::new(&task.resource_root);
        Self {
            task,
            namespace,
            manifests: RefCell::new(BTreeMap::new()),
            requests: RefCell::new(BTreeMap::new()),
            allow_commands,
        }
    }
    fn request(&self, path: &str, read: bool) {
        self.requests
            .borrow_mut()
            .entry(path.into())
            .and_modify(|value| *value |= read)
            .or_insert(read);
    }
    fn overlay(&self, path: &str) -> Option<&str> {
        if path == self.task.ticket.path {
            Some(&self.task.source)
        } else {
            self.task.overlays.get(path).map(String::as_str)
        }
    }
    fn key(&self, path: &Path) -> Result<String, ResourceError> {
        if ResourcePath::absolute(&self.task.resource_root).is_none() {
            return Err(ResourceError::Access {
                path: PathBuf::from(&self.task.resource_root),
                message: "expected absolute resource root".into(),
            });
        }
        let key = self.namespace.key(path);
        if ResourcePath::absolute(&key).is_none() {
            validate_path(&key).map_err(|error| ResourceError::Access {
                path: PathBuf::from(&key),
                message: error.message,
            })?;
        }
        Ok(key)
    }

    pub(super) fn diagnostic(&self, error: &notist::SourceDiagnostic) -> PreviewDiagnostic {
        let sources = self.manifests.borrow();
        let prepared = sources
            .get(&self.resolve(&error.path))
            .filter(|prepared| prepared.analysis == error.source);
        let from = usize::from(error.diagnostic.span.start());
        let to = usize::from(error.diagnostic.span.end());
        let source = prepared.map_or(&error.source, |prepared| &prepared.original);
        let range = from..to;
        PreviewDiagnostic {
            from: source[..range.start].encode_utf16().count(),
            to: source[..range.end].encode_utf16().count(),
            origin: PreviewDiagnosticOrigin::Environment,
            phase: error.diagnostic.phase.to_string(),
            message: self.namespace.message(&error.diagnostic.message),
            path: self.namespace.key(&error.path),
            source: Some(source.clone()),
        }
    }
}
impl Resources for SnapshotResources<'_> {
    fn root(&self) -> &Path {
        self.namespace.root()
    }
    fn resolve(&self, path: &Path) -> PathBuf {
        self.namespace.resolve(path)
    }
    fn kind(&self, path: &Path) -> Result<Option<ResourceKind>, ResourceError> {
        let resolved = self.resolve(path);
        // Configuration discovery may probe ancestors; never expose other roots.
        if !resolved.starts_with(self.root())
            && resolved
                .file_name()
                .is_some_and(|name| name == "Notist.toml")
        {
            return Ok(None);
        }
        let key = self.key(path)?;
        if key.is_empty() {
            return Ok(Some(ResourceKind::Directory));
        }
        if self.overlay(&key).is_some() {
            return Ok(Some(ResourceKind::File));
        }
        if self
            .task
            .overlays
            .keys()
            .any(|p| p.starts_with(&format!("{key}/")))
        {
            return Ok(Some(ResourceKind::Directory));
        }
        match self.task.resources.get(&key) {
            Some(resource) => {
                if let Some(message) = &resource.error {
                    return Err(ResourceError::Access {
                        path: PathBuf::from(&key),
                        message: message.clone(),
                    });
                }
                Ok(resource.kind.map(|kind| match kind {
                    PreviewResourceKind::File => ResourceKind::File,
                    PreviewResourceKind::Directory => ResourceKind::Directory,
                }))
            }
            None => {
                self.request(&key, false);
                Ok(None)
            }
        }
    }
    fn read(&self, path: &Path) -> Result<Vec<u8>, ResourceError> {
        let key = self.key(path)?;
        if let Some(source) = self.overlay(&key) {
            return Ok(source.as_bytes().to_vec());
        }
        if let Some(resource) = self.task.resources.get(&key) {
            if let Some(message) = &resource.error {
                return Err(ResourceError::Access {
                    path: PathBuf::from(&key),
                    message: message.clone(),
                });
            }
            if let Some(data) = &resource.data {
                return Ok(data.clone());
            }
            if resource.kind.is_none() {
                return Err(ResourceError::NotFound(PathBuf::from(&key)));
            }
        }
        self.request(&key, true);
        Err(ResourceError::Access {
            path: PathBuf::from(&key),
            message: "resource snapshot is not prepared".into(),
        })
    }
    fn source(&self, path: &Path) -> Result<String, ResourceError> {
        let source = String::from_utf8(self.read(path)?)
            .map_err(|_| ResourceError::InvalidUtf8(PathBuf::from(self.namespace.key(path))))?;
        let source = source
            .trim_start_matches('\u{feff}')
            .replace("\r\n", "\n")
            .replace('\r', "\n");
        let resolved = self.resolve(path);
        if resolved
            .file_name()
            .is_some_and(|name| name == "Notist.toml")
        {
            let prepared = ManifestSource::new(source, !self.allow_commands);
            let analysis = prepared.analysis.clone();
            self.manifests.borrow_mut().insert(resolved, prepared);
            Ok(analysis)
        } else {
            Ok(source)
        }
    }

    fn entries(&self, _path: &Path) -> Result<Vec<PathBuf>, ResourceError> {
        Ok(vec![])
    }
}

/// Missing probes are part of the preparation, including absent nearer configs.
pub fn preview_resource_requests(task: &PreviewTask) -> Vec<PreviewResourceRequest> {
    let resources = SnapshotResources::discovery(task);
    let mut vault = notist::Vault::new(&resources);
    let _ = (|| -> Result<(), notist::VaultError> {
        let analysis = vault.analyze(&task.ticket.path, &task.source)?;
        let evaluation = vault.evaluate(&task.ticket.path, &analysis)?;
        vault.html_registry(&task.ticket.path, &task.source, &evaluation.root)?;
        Ok(())
    })();
    resources
        .requests
        .into_inner()
        .into_iter()
        .map(|(path, read)| PreviewResourceRequest { path, read })
        .collect()
}
