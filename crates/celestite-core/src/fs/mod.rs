//! Filesystem capabilities used by the editor and its recovery snapshots.
use crate::error::{EditorError, EditorResult, ErrorCode};
use serde::{Deserialize, Serialize};

#[cfg(all(feature = "wasm", target_arch = "wasm32"))]
pub(crate) mod browser;
#[cfg(all(feature = "native", not(target_arch = "wasm32")))]
pub mod native;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    File,
    Directory,
    Symlink,
    Other,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub path: String,
    pub kind: EntryKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modified_at: Option<u64>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct FileSnapshot {
    pub data: Vec<u8>,
    pub revision: String,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WriteMode {
    Create,
    Replace,
    /// Atomically create or replace private application data.
    Upsert,
}

/// Capability-scoped files. Implementations own permissions and atomic publication.
/// Futures need not be Send: browser IO remains in its Worker.
#[allow(async_fn_in_trait)]
pub trait FileSystem {
    async fn stat(&self, path: &str) -> EditorResult<Option<FileEntry>>;
    async fn read_dir(&self, path: &str) -> EditorResult<Vec<FileEntry>>;
    async fn read_file(&self, path: &str, limit: Option<u64>) -> EditorResult<FileSnapshot>;
    /// Set error.write_not_started only when this attempt provably changed no target bytes.
    async fn write_file(
        &self,
        path: &str,
        data: &[u8],
        mode: WriteMode,
        expected: Option<&str>,
    ) -> EditorResult<String>;
    async fn mkdir(&self, path: &str, recursive: bool) -> EditorResult<()>;
    /// Move an entry, rejecting an existing target.
    async fn rename(&self, from: &str, to: &str) -> EditorResult<()>;
    async fn remove(&self, path: &str, recursive: bool) -> EditorResult<()>;
}

// The default in-memory EditorCore has no FileSystem value. An uninhabited
// type expresses that absence without a dummy backend or platform dependency.
impl FileSystem for std::convert::Infallible {
    async fn stat(&self, _path: &str) -> EditorResult<Option<FileEntry>> {
        match *self {}
    }
    async fn read_dir(&self, _path: &str) -> EditorResult<Vec<FileEntry>> {
        match *self {}
    }
    async fn read_file(&self, _path: &str, _limit: Option<u64>) -> EditorResult<FileSnapshot> {
        match *self {}
    }
    async fn write_file(
        &self,
        _path: &str,
        _data: &[u8],
        _mode: WriteMode,
        _expected: Option<&str>,
    ) -> EditorResult<String> {
        match *self {}
    }
    async fn mkdir(&self, _path: &str, _recursive: bool) -> EditorResult<()> {
        match *self {}
    }
    async fn rename(&self, _from: &str, _to: &str) -> EditorResult<()> {
        match *self {}
    }
    async fn remove(&self, _path: &str, _recursive: bool) -> EditorResult<()> {
        match *self {}
    }
}

impl<T: FileSystem + ?Sized> FileSystem for std::sync::Arc<T> {
    async fn stat(&self, path: &str) -> EditorResult<Option<FileEntry>> {
        T::stat(self.as_ref(), path).await
    }
    async fn read_dir(&self, path: &str) -> EditorResult<Vec<FileEntry>> {
        T::read_dir(self.as_ref(), path).await
    }
    async fn read_file(&self, path: &str, limit: Option<u64>) -> EditorResult<FileSnapshot> {
        T::read_file(self.as_ref(), path, limit).await
    }
    async fn write_file(
        &self,
        path: &str,
        data: &[u8],
        mode: WriteMode,
        expected: Option<&str>,
    ) -> EditorResult<String> {
        T::write_file(self.as_ref(), path, data, mode, expected).await
    }
    async fn mkdir(&self, path: &str, recursive: bool) -> EditorResult<()> {
        T::mkdir(self.as_ref(), path, recursive).await
    }
    async fn rename(&self, from: &str, to: &str) -> EditorResult<()> {
        T::rename(self.as_ref(), from, to).await
    }
    async fn remove(&self, path: &str, recursive: bool) -> EditorResult<()> {
        T::remove(self.as_ref(), path, recursive).await
    }
}

pub fn validate_path(path: &str) -> EditorResult<()> {
    if path.contains(['\\', '\0'])
        || path.starts_with('/')
        || (path.as_bytes().get(1) == Some(&b':') && path.as_bytes()[0].is_ascii_alphabetic())
        || (!path.is_empty()
            && path
                .split('/')
                .any(|p| p.is_empty() || p == "." || p == ".."))
    {
        return Err(EditorError::new(
            ErrorCode::InvalidPath,
            "Expected a Vault-relative path",
            path,
        ));
    }
    Ok(())
}
