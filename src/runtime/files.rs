//! Native projection observation is an IO boundary, not an editor policy.
//! The core and preview readers share the same watched directory capabilities.
use super::watch::WatchService;
use celestite_core::fs::native::{FsVault, revision};
use celestite_core::{
    error::{EditorError, EditorResult, ErrorCode},
    fs::validate_path,
    fs::{FileEntry, FileSnapshot, FileSystem, WriteMode},
};
use std::{io, path::PathBuf, sync::Arc};

/// A native root capability paired with observation barriers. Exposing this
/// helper instead of the raw FsVault prevents previews from bypassing watches.
pub(crate) struct LocalFiles {
    files: Arc<FsVault>,
    root: PathBuf,
    watches: Arc<WatchService>,
}

fn io_error(error: io::Error, path: &str) -> EditorError {
    let code = match error.kind() {
        io::ErrorKind::NotFound => ErrorCode::NotFound,
        io::ErrorKind::PermissionDenied => ErrorCode::PermissionDenied,
        io::ErrorKind::NotADirectory => ErrorCode::NotDirectory,
        _ => ErrorCode::Io,
    };
    EditorError::new(code, error.to_string(), path)
}

fn write_not_started(mut error: EditorError) -> EditorError {
    error.write_not_started = true;
    error
}

impl LocalFiles {
    pub(crate) fn new(
        files: Arc<FsVault>,
        root: PathBuf,
        watches: Arc<WatchService>,
    ) -> EditorResult<Self> {
        let local = Self {
            files,
            root,
            watches,
        };
        local.check_root()?;
        Ok(local)
    }

    fn disconnected(&self) -> EditorError {
        EditorError::new(
            ErrorCode::Closed,
            "The Vault root was removed or replaced; reopen the Vault to reconnect. Private drafts are retained.",
            &self.root.to_string_lossy(),
        )
    }

    /// FsVault intentionally retains its original root directory handle. A
    /// pathname replacement must never silently redirect its IO or leave its
    /// watch hints describing a different directory from the capability.
    fn check_root(&self) -> EditorResult<()> {
        let metadata = std::fs::symlink_metadata(&self.root).map_err(|error| {
            if matches!(
                error.kind(),
                io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
            ) {
                self.disconnected()
            } else {
                io_error(error, &self.root.to_string_lossy())
            }
        })?;
        if metadata.is_symlink() || !metadata.is_dir() {
            return Err(self.disconnected());
        }
        let matches = self.files.matches_root(&self.root).map_err(|error| {
            if matches!(
                error.kind(),
                io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
            ) {
                self.disconnected()
            } else {
                io_error(error, &self.root.to_string_lossy())
            }
        })?;
        if !matches {
            return Err(self.disconnected());
        }
        Ok(())
    }

    fn directory(&self, path: &str, include_target: bool) -> EditorResult<PathBuf> {
        validate_path(path)?;
        self.check_root()?;
        let relative = if include_target {
            path
        } else {
            path.rsplit_once('/').map_or("", |(parent, _)| parent)
        };
        let mut directory = self.root.clone();
        for part in relative.split('/').filter(|part| !part.is_empty()) {
            directory.push(part);
            match std::fs::symlink_metadata(&directory) {
                Ok(metadata) if metadata.is_symlink() => {
                    return Err(EditorError::new(
                        ErrorCode::Unsupported,
                        "Following symbolic links is disabled",
                        path,
                    ));
                }
                Ok(metadata) if !metadata.is_dir() => {
                    return Err(EditorError::new(
                        ErrorCode::NotDirectory,
                        "Expected a directory",
                        path,
                    ));
                }
                Ok(_) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    // Keep the requested missing suffix. WatchService observes
                    // its nearest existing ancestor and future path creation.
                    return Ok(self.root.join(relative));
                }
                Err(error) => return Err(io_error(error, path)),
            }
        }
        Ok(directory)
    }

    fn ensure(&self, path: &str, directory: bool) -> EditorResult<()> {
        let target = self.directory(path, directory)?;
        self.watches.ensure_directory(&target)?;
        // Registration runs on another thread. Recheck after that barrier so a
        // root replacement while waiting cannot read through the retained inode.
        self.check_root()
    }

    pub(crate) fn stat(&self, path: &str) -> EditorResult<Option<FileEntry>> {
        self.ensure(path, false)?;
        FsVault::stat(self.files.as_ref(), path)
    }

    pub(crate) fn read_dir(&self, path: &str) -> EditorResult<Vec<FileEntry>> {
        self.ensure(path, true)?;
        FsVault::read_dir(self.files.as_ref(), path)
    }

    pub(crate) fn read_file_limited(&self, path: &str, limit: u64) -> EditorResult<Vec<u8>> {
        self.ensure(path, false)?;
        self.files.read_file_limited(path, limit)
    }

    fn write_file(
        &self,
        path: &str,
        bytes: &[u8],
        mode: WriteMode,
        expected: Option<&str>,
    ) -> EditorResult<String> {
        self.ensure(path, false).map_err(write_not_started)?;
        FsVault::write_file(self.files.as_ref(), path, bytes, mode, expected)
    }

    fn mkdir(&self, path: &str, recursive: bool) -> EditorResult<()> {
        self.ensure(path, false)?;
        FsVault::mkdir(self.files.as_ref(), path, recursive)?;
        // A newly created directory is part of this session's visited set.
        // Registration is incremental and never enumerates its children.
        // The directory already exists. A derived watcher failure must not
        // turn that completed mutation into an apparent creation failure.
        let _ = self.watches.enqueue_directory(&self.root.join(path));
        Ok(())
    }

    fn rename(&self, from: &str, to: &str) -> EditorResult<()> {
        self.ensure(from, false)?;
        self.ensure(to, false)?;
        FsVault::rename(self.files.as_ref(), from, to)
    }

    fn remove(&self, path: &str, recursive: bool) -> EditorResult<()> {
        self.ensure(path, false)?;
        FsVault::remove(self.files.as_ref(), path, recursive)
    }
}

impl FileSystem for LocalFiles {
    async fn stat(&self, path: &str) -> EditorResult<Option<FileEntry>> {
        LocalFiles::stat(self, path)
    }
    async fn read_dir(&self, path: &str) -> EditorResult<Vec<FileEntry>> {
        LocalFiles::read_dir(self, path)
    }
    async fn read_file(&self, path: &str, limit: Option<u64>) -> EditorResult<FileSnapshot> {
        let data = self.read_file_limited(path, limit.unwrap_or(u64::MAX))?;
        Ok(FileSnapshot {
            revision: revision(&data),
            data,
        })
    }
    async fn write_file(
        &self,
        path: &str,
        data: &[u8],
        mode: WriteMode,
        expected: Option<&str>,
    ) -> EditorResult<String> {
        LocalFiles::write_file(self, path, data, mode, expected)
    }
    async fn mkdir(&self, path: &str, recursive: bool) -> EditorResult<()> {
        LocalFiles::mkdir(self, path, recursive)
    }
    async fn rename(&self, from: &str, to: &str) -> EditorResult<()> {
        LocalFiles::rename(self, from, to)
    }
    async fn remove(&self, path: &str, recursive: bool) -> EditorResult<()> {
        LocalFiles::remove(self, path, recursive)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replacing_the_root_before_binding_observation_cannot_adopt_the_new_inode() {
        let directory = tempfile::tempdir().unwrap();
        let parent = directory.path().canonicalize().unwrap();
        let root = parent.join("vault");
        std::fs::create_dir(&root).unwrap();
        let files = Arc::new(FsVault::open(&root).unwrap());
        std::fs::rename(&root, parent.join("old-vault")).unwrap();
        std::fs::create_dir(&root).unwrap();
        let watches = Arc::new(WatchService::new(root.clone()).unwrap());
        let error = LocalFiles::new(files, root, watches).err().unwrap();
        assert_eq!(error.code, ErrorCode::Closed);
    }
}
