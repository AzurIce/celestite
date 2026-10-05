//! Notist drives resource discovery; platforms answer queries asynchronously.
use super::*;
use notist::{ResourceError, Resources, resources::ResourceKind};
use std::{
    cell::RefCell,
    path::{Path, PathBuf},
};

pub(super) fn resource_key(root: &str, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .into_owned()
}

pub(super) struct SnapshotResources<'a> {
    task: &'a PreviewTask,
    requests: RefCell<BTreeMap<String, bool>>,
}
impl<'a> SnapshotResources<'a> {
    pub(super) fn new(task: &'a PreviewTask) -> Self {
        Self {
            task,
            requests: RefCell::new(BTreeMap::new()),
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
        let resolved = self.resolve(path);
        let key = resource_key(&self.task.resource_root, &resolved);
        // WASM paths use the preview's logical Unix namespace.
        if !resolved.to_string_lossy().starts_with('/') {
            return Err(ResourceError::Access {
                path: resolved,
                message: "expected absolute resource identity".into(),
            });
        }
        if !key.starts_with('/') {
            crate::validate_editor_path(&key).map_err(|error| ResourceError::Access {
                path: resolved,
                message: error.message,
            })?;
        }
        Ok(key)
    }
}
impl Resources for SnapshotResources<'_> {
    fn root(&self) -> &Path {
        Path::new(&self.task.resource_root)
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
                        path: resolved,
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
                    path: self.resolve(path),
                    message: message.clone(),
                });
            }
            if let Some(data) = &resource.data {
                return Ok(data.clone());
            }
            if resource.kind.is_none() {
                return Err(ResourceError::NotFound(self.resolve(path)));
            }
        }
        self.request(&key, true);
        Err(ResourceError::Access {
            path: self.resolve(path),
            message: "resource snapshot is not prepared".into(),
        })
    }
    fn source(&self, path: &Path) -> Result<String, ResourceError> {
        let source = String::from_utf8(self.read(path)?)
            .map_err(|_| ResourceError::InvalidUtf8(self.resolve(path)))?;
        Ok(source
            .trim_start_matches('\u{feff}')
            .replace("\r\n", "\n")
            .replace('\r', "\n"))
    }
    fn entries(&self, _path: &Path) -> Result<Vec<PathBuf>, ResourceError> {
        Ok(vec![])
    }
}

/// Missing probes are part of the preparation, including absent nearer configs.
pub fn preview_resource_requests(task: &PreviewTask) -> Vec<PreviewResourceRequest> {
    let resources = SnapshotResources::new(task);
    let mut vault = notist::Vault::new(&resources);
    let _ = vault.html_registry(&task.ticket.path);
    resources
        .requests
        .into_inner()
        .into_iter()
        .map(|(path, read)| PreviewResourceRequest { path, read })
        .collect()
}
