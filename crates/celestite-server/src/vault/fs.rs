//! Directory-backed Vault operations. Kept separate from HTTP and the editing kernel.
use cap_std::{
    ambient_authority,
    fs::{Dir, OpenOptions},
};
use celestite_core::backend::{EditorError, EntryKind, ErrorCode, FileEntry};
use serde::Serialize;
use std::{
    io::{self, Read, Write},
    path::Path,
    time::UNIX_EPOCH,
};

pub type Result<T> = celestite_core::backend::EditorResult<T>;
fn entry_kind(symlink: bool, directory: bool, file: bool) -> EntryKind {
    if symlink {
        EntryKind::Symlink
    } else if directory {
        EntryKind::Directory
    } else if file {
        EntryKind::File
    } else {
        EntryKind::Other
    }
}

fn io_error(error: io::Error, path: &str) -> EditorError {
    let code = match error.kind() {
        io::ErrorKind::NotFound => ErrorCode::NotFound,
        io::ErrorKind::AlreadyExists => ErrorCode::AlreadyExists,
        io::ErrorKind::PermissionDenied => ErrorCode::PermissionDenied,
        io::ErrorKind::NotADirectory => ErrorCode::NotDirectory,
        io::ErrorKind::IsADirectory => ErrorCode::NotFile,
        io::ErrorKind::DirectoryNotEmpty => ErrorCode::DirectoryNotEmpty,
        io::ErrorKind::StorageFull => ErrorCode::QuotaExceeded,
        io::ErrorKind::CrossesDevices | io::ErrorKind::Unsupported => ErrorCode::Unsupported,
        _ => ErrorCode::Io,
    };
    EditorError::new(code, error.to_string(), path)
}

#[derive(Clone, Debug, Serialize)]
pub struct ChangeHint {
    pub paths: Vec<String>,
    pub recursive: bool,
}
impl ChangeHint {
    pub fn all() -> Self {
        Self {
            paths: vec![String::new()],
            recursive: true,
        }
    }
}

pub fn validate_path(path: &str) -> Result<()> {
    celestite_core::editor::validate_editor_path(path)
        .map_err(|error| EditorError::new(ErrorCode::InvalidPath, error.message, path))
}
fn split(path: &str) -> Result<(&str, &str)> {
    validate_path(path)?;
    if path.is_empty() {
        return Err(EditorError::new(
            ErrorCode::InvalidPath,
            "Cannot modify the Vault root",
            path,
        ));
    }
    Ok(path.rsplit_once('/').unwrap_or(("", path)))
}
pub fn revision(bytes: &[u8]) -> String {
    format!("\"{}\"", blake3::hash(bytes).to_hex())
}

pub struct FsVault {
    root: Dir,
}
impl FsVault {
    /// Existing root only. All subsequent operations are relative to this directory capability.
    pub fn open(path: &Path) -> io::Result<Self> {
        Ok(Self {
            root: Dir::open_ambient_dir(path, ambient_authority())?,
        })
    }
    fn directory(&self, path: &str) -> Result<Dir> {
        validate_path(path)?;
        let mut directory = self.root.try_clone().map_err(|e| io_error(e, path))?;
        if !path.is_empty() {
            for part in path.split('/') {
                let metadata = directory
                    .symlink_metadata(part)
                    .map_err(|e| io_error(e, path))?;
                if metadata.is_symlink() {
                    return Err(EditorError::new(
                        ErrorCode::Unsupported,
                        "Following symbolic links is disabled",
                        path,
                    ));
                }
                directory = directory.open_dir(part).map_err(|e| io_error(e, path))?;
            }
        }
        Ok(directory)
    }
    fn parent(&self, path: &str) -> Result<(Dir, String)> {
        let (parent, name) = split(path)?;
        Ok((self.directory(parent)?, name.into()))
    }
    pub fn stat(&self, path: &str) -> Result<Option<FileEntry>> {
        validate_path(path)?;
        let result = if path.is_empty() {
            self.root.dir_metadata()
        } else {
            let (parent, name) = match self.parent(path) {
                Err(error) if error.code == ErrorCode::NotFound => return Ok(None),
                result => result?,
            };
            parent.symlink_metadata(name)
        };
        match result {
            Ok(metadata) => Ok(Some(FileEntry {
                path: path.into(),
                kind: entry_kind(metadata.is_symlink(), metadata.is_dir(), metadata.is_file()),
                size: metadata.is_file().then_some(metadata.len()),
                modified_at: metadata
                    .modified()
                    .ok()
                    .and_then(|t| t.into_std().duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64),
            })),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(io_error(error, path)),
        }
    }
    pub fn read_dir(&self, path: &str) -> Result<Vec<FileEntry>> {
        let directory = self.directory(path)?;
        let mut entries = Vec::new();
        for entry in directory.entries().map_err(|e| io_error(e, path))? {
            let entry = entry.map_err(|e| io_error(e, path))?;
            let name = entry.file_name().into_string().map_err(|_| {
                EditorError::new(
                    ErrorCode::Unsupported,
                    "Non-UTF-8 file names are not supported",
                    path,
                )
            })?;
            let child = if path.is_empty() {
                name
            } else {
                format!("{path}/{name}")
            };
            // Enumeration promises entry kinds, not a consistent metadata snapshot.
            let kind = entry.file_type().map_err(|e| io_error(e, &child))?;
            entries.push(FileEntry {
                path: child,
                kind: entry_kind(kind.is_symlink(), kind.is_dir(), kind.is_file()),
                size: None,
                modified_at: None,
            });
        }
        Ok(entries)
    }
    fn require_file(&self, path: &str) -> Result<()> {
        match self.stat(path)? {
            None => Err(EditorError::new(
                ErrorCode::NotFound,
                "File does not exist",
                path,
            )),
            Some(entry) if entry.kind == EntryKind::File => Ok(()),
            _ => Err(EditorError::new(
                ErrorCode::NotFile,
                "Expected a regular file",
                path,
            )),
        }
    }
    pub fn read_file(&self, path: &str) -> Result<Vec<u8>> {
        self.read_file_limited(path, u64::MAX)
    }
    pub fn read_file_limited(&self, path: &str, limit: u64) -> Result<Vec<u8>> {
        self.require_file(path)?;
        let (parent, name) = self.parent(path)?;
        let file = parent.open(name).map_err(|e| io_error(e, path))?;
        let mut bytes = Vec::new();
        file.take(limit.saturating_add(1))
            .read_to_end(&mut bytes)
            .map_err(|e| io_error(e, path))?;
        if bytes.len() as u64 > limit {
            return Err(EditorError::new(
                ErrorCode::Unsupported,
                "File exceeds the supported size",
                path,
            ));
        }
        Ok(bytes)
    }
    fn file_revision(&self, path: &str) -> Result<String> {
        self.require_file(path)?;
        let (parent, name) = self.parent(path)?;
        let file = parent.open(name).map_err(|e| io_error(e, path))?;
        let mut hash = blake3::Hasher::new();
        hash.update_reader(file).map_err(|e| io_error(e, path))?;
        Ok(format!("\"{}\"", hash.finalize().to_hex()))
    }
    /// Hosts serialize mutations and version checks for each Vault.
    /// External processes do not participate in this lock; revision checking is best effort for them.
    pub fn write_file(
        &self,
        path: &str,
        bytes: &[u8],
        mode: &str,
        expected: Option<&str>,
    ) -> Result<String> {
        let (parent, name) = self.parent(path)?;
        let mut options = OpenOptions::new();
        options.write(true);
        match mode {
            "create" => {
                options.create_new(true);
            }
            "replace" => {
                self.require_file(path)?;
                if let Some(expected) = expected {
                    if self.file_revision(path)? != expected {
                        return Err(EditorError::new(
                            ErrorCode::Conflict,
                            "File changed since it was read",
                            path,
                        ));
                    }
                }
                options.truncate(true);
            }
            _ => {
                return Err(EditorError::new(
                    ErrorCode::InvalidPath,
                    "Expected create or replace write mode",
                    path,
                ))
            }
        }
        let mut file = parent
            .open_with(&name, &options)
            .map_err(|e| io_error(e, path))?;
        file.write_all(bytes).map_err(|e| io_error(e, path))?;
        file.sync_all().map_err(|e| io_error(e, path))?;
        Ok(revision(bytes))
    }
    pub fn mkdir(&self, path: &str, recursive: bool) -> Result<()> {
        split(path)?;
        if !recursive {
            let (parent, name) = self.parent(path)?;
            return parent.create_dir(name).map_err(|e| io_error(e, path));
        }
        let mut parent = self.root.try_clone().map_err(|e| io_error(e, path))?;
        for name in path.split('/') {
            match parent.create_dir(name) {
                Ok(()) => {}
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
                Err(e) => return Err(io_error(e, path)),
            }
            let kind = parent
                .symlink_metadata(name)
                .map_err(|e| io_error(e, path))?;
            if kind.is_symlink() {
                return Err(EditorError::new(
                    ErrorCode::Unsupported,
                    "Following symbolic links is disabled",
                    path,
                ));
            }
            parent = parent.open_dir(name).map_err(|e| io_error(e, path))?;
        }
        Ok(())
    }
    pub fn remove(&self, path: &str, recursive: bool) -> Result<()> {
        let (parent, name) = self.parent(path)?;
        let kind = parent
            .symlink_metadata(&name)
            .map_err(|e| io_error(e, path))?;
        let result = if kind.is_dir() && !kind.is_symlink() {
            if recursive {
                parent.remove_dir_all(name)
            } else {
                parent.remove_dir(name)
            }
        } else {
            parent.remove_file(name)
        };
        result.map_err(|e| io_error(e, path))
    }
    pub fn rename(&self, from: &str, to: &str) -> Result<()> {
        let (source, source_name) = self.parent(from)?;
        let entry = self
            .stat(from)?
            .ok_or_else(|| EditorError::new(ErrorCode::NotFound, "Source does not exist", from))?;
        let (target, target_name) = self.parent(to)?;
        if from == to {
            return Ok(());
        }
        if entry.kind == EntryKind::Directory && to.starts_with(&format!("{from}/")) {
            return Err(EditorError::new(
                ErrorCode::InvalidPath,
                "Cannot move a directory into itself",
                to,
            ));
        }
        if self.stat(to)?.is_some() {
            return Err(EditorError::new(
                ErrorCode::AlreadyExists,
                "Target already exists",
                to,
            ));
        }
        source
            .rename(&source_name, &target, &target_name)
            .map_err(|e| io_error(e, to))
    }
}

#[cfg(test)]
mod tests {
    use super::{EntryKind, ErrorCode, FsVault};
    #[test]
    fn paths_and_root_are_protected() {
        let tmp = tempfile::tempdir().unwrap();
        let vault = FsVault::open(tmp.path()).unwrap();
        for path in ["/etc/passwd", "../x", "a//b", "a/./b", "C:/x", "a\\b"] {
            assert_eq!(vault.stat(path).unwrap_err().code, ErrorCode::InvalidPath);
        }
        assert_eq!(
            vault.remove("", true).unwrap_err().code,
            ErrorCode::InvalidPath
        );
        assert_eq!(
            vault.rename("", "x").unwrap_err().code,
            ErrorCode::InvalidPath
        );
        assert!(vault.stat("missing/file").unwrap().is_none());
    }
    #[test]
    fn complete_file_contract_and_conflicts() {
        let tmp = tempfile::tempdir().unwrap();
        let vault = FsVault::open(tmp.path()).unwrap();
        vault.mkdir("a/b", true).unwrap();
        let version = vault
            .write_file("a/b/x.md", b"long original content", "create", None)
            .unwrap();
        assert_eq!(
            vault
                .write_file("a/b/x.md", b"bad", "create", None)
                .unwrap_err()
                .code,
            ErrorCode::AlreadyExists
        );
        vault
            .write_file("a/b/x.md", b"new", "replace", Some(&version))
            .unwrap();
        assert_eq!(
            vault
                .write_file("a/b/x.md", b"bad", "replace", Some(&version))
                .unwrap_err()
                .code,
            ErrorCode::Conflict
        );
        assert_eq!(vault.read_file("a/b/x.md").unwrap(), b"new");
        vault.mkdir("target", false).unwrap();
        assert_eq!(
            vault.rename("a", "target").unwrap_err().code,
            ErrorCode::AlreadyExists
        );
        assert_eq!(
            vault.rename("a", "a/b/c").unwrap_err().code,
            ErrorCode::InvalidPath
        );
        vault.rename("a", "renamed").unwrap();
        assert_eq!(vault.read_file("renamed/b/x.md").unwrap(), b"new");
        assert_eq!(
            vault.remove("renamed", false).unwrap_err().code,
            ErrorCode::DirectoryNotEmpty
        );
        vault.remove("renamed", true).unwrap();
        assert!(vault.stat("renamed").unwrap().is_none());
        assert_eq!(
            vault
                .write_file("absent", b"x", "replace", None)
                .unwrap_err()
                .code,
            ErrorCode::NotFound
        );
    }

    #[test]
    fn rename_rejects_an_existing_file_without_changing_either_file() {
        let root = tempfile::tempdir().unwrap();
        let vault = FsVault::open(root.path()).unwrap();
        vault.write_file("source", b"new", "create", None).unwrap();
        vault.write_file("target", b"old", "create", None).unwrap();

        assert_eq!(
            vault.rename("source", "target").unwrap_err().code,
            ErrorCode::AlreadyExists
        );
        assert_eq!(vault.read_file("source").unwrap(), b"new");
        assert_eq!(vault.read_file("target").unwrap(), b"old");
    }
    #[test]
    fn limited_reads_reject_oversize_files() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("a"), b"12345").unwrap();
        let vault = FsVault::open(root.path()).unwrap();
        assert_eq!(
            vault.read_file_limited("a", 4).unwrap_err().code,
            ErrorCode::Unsupported
        );
        assert_eq!(vault.read_file_limited("a", 5).unwrap(), b"12345");
    }

    #[test]
    #[cfg(unix)]
    fn symbolic_links_never_grant_outside_access() {
        let tmp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret"), b"secret").unwrap();
        std::os::unix::fs::symlink(outside.path(), tmp.path().join("link")).unwrap();
        let vault = FsVault::open(tmp.path()).unwrap();
        assert_eq!(
            vault.stat("link").unwrap().unwrap().kind,
            EntryKind::Symlink
        );
        assert_eq!(
            vault.read_file("link/secret").unwrap_err().code,
            ErrorCode::Unsupported
        );
        assert_eq!(
            vault.mkdir("link/new", true).unwrap_err().code,
            ErrorCode::Unsupported
        );
        vault.remove("link", true).unwrap();
        assert_eq!(
            std::fs::read(outside.path().join("secret")).unwrap(),
            b"secret"
        );
    }
}
