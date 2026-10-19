//! Capability-scoped directory operations for native files and resources.
mod store;
use crate::error::{EditorError, EditorResult, ErrorCode};
use crate::fs::validate_path;
use crate::fs::{EntryKind, FileEntry, FileSnapshot, FileSystem, WriteMode};
use cap_std::{
    ambient_authority,
    fs::{Dir, OpenOptions},
};
use std::{
    io::{self, Read, Write},
    path::Path,
    time::UNIX_EPOCH,
};
pub use store::{write_bytes, write_json};

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

fn write_not_started(mut error: EditorError) -> EditorError {
    error.write_not_started = true;
    error
}

fn split(path: &str) -> EditorResult<(&str, &str)> {
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
    _lock: Option<std::fs::File>,
}
impl FsVault {
    /// Existing root only. All subsequent operations are relative to this directory capability.
    pub fn open(path: &Path) -> io::Result<Self> {
        Ok(Self {
            root: Dir::open_ambient_dir(path, ambient_authority())?,
            _lock: None,
        })
    }
    /// Open an application-private directory and retain exclusive write ownership.
    pub fn open_private(path: &Path) -> EditorResult<Self> {
        let mut builder = std::fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder
            .create(path)
            .map_err(|error| store::io_error(error, path))?;
        let root = Self::open(path).map_err(|error| store::io_error(error, path))?;
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use cap_std::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let lock_path = path.join("owner.lock");
        let lock = root
            .root
            .open_with("owner.lock", &options)
            .map_err(|error| store::io_error(error, &lock_path))?
            .into_std();
        lock.try_lock().map_err(|error| match error {
            std::fs::TryLockError::WouldBlock => EditorError::new(
                ErrorCode::Busy,
                "This private recovery directory is already open",
                &path.to_string_lossy(),
            ),
            std::fs::TryLockError::Error(error) => store::io_error(error, &lock_path),
        })?;
        Ok(Self {
            root: root.root,
            _lock: Some(lock),
        })
    }

    /// Compare a pathname with the retained directory capability, including a
    /// replacement that happened between opening this capability and checking.
    pub fn matches_root(&self, path: &Path) -> io::Result<bool> {
        let retained = same_file::Handle::from_file(self.root.try_clone()?.into_std_file())?;
        Ok(retained == same_file::Handle::from_path(path)?)
    }
    fn directory(&self, path: &str) -> EditorResult<Dir> {
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
    fn parent(&self, path: &str) -> EditorResult<(Dir, String)> {
        let (parent, name) = split(path)?;
        Ok((self.directory(parent)?, name.into()))
    }
    pub fn stat(&self, path: &str) -> EditorResult<Option<FileEntry>> {
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
    pub fn read_dir(&self, path: &str) -> EditorResult<Vec<FileEntry>> {
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
    fn require_file(&self, path: &str) -> EditorResult<()> {
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
    pub fn read_file_limited(&self, path: &str, limit: u64) -> EditorResult<Vec<u8>> {
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
                "File exceeds the read limit",
                path,
            ));
        }
        Ok(bytes)
    }
    fn file_revision(&self, path: &str) -> EditorResult<String> {
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
        mode: WriteMode,
        expected: Option<&str>,
    ) -> EditorResult<String> {
        let (parent, name) = self.parent(path).map_err(write_not_started)?;
        let mut options = OpenOptions::new();
        options.write(true);
        match mode {
            WriteMode::Create => {
                options.create_new(true);
            }
            WriteMode::Replace => {
                self.require_file(path).map_err(write_not_started)?;
                if let Some(expected) = expected
                    && self.file_revision(path).map_err(write_not_started)? != expected
                {
                    return Err(write_not_started(EditorError::new(
                        ErrorCode::Conflict,
                        "File changed since it was read",
                        path,
                    )));
                }
                // Check the target's write permission without changing it, then
                // construct the entire replacement before touching its name.
                let original = parent
                    .open_with(&name, &options)
                    .map_err(|error| write_not_started(io_error(error, path)))?;
                let permissions = original
                    .metadata()
                    .map_err(|error| write_not_started(io_error(error, path)))?
                    .permissions();
                drop(original);
                let temporary = format!(".celestite-{}.tmp", uuid::Uuid::new_v4());
                options.create_new(true);
                let prepared = (|| {
                    let mut file = parent.open_with(&temporary, &options)?;
                    file.set_permissions(permissions)?;
                    file.write_all(bytes)?;
                    file.sync_all()
                })();
                if let Err(error) = prepared {
                    let _ = parent.remove_file(&temporary);
                    return Err(write_not_started(io_error(error, path)));
                }
                if let Some(expected) = expected {
                    let checked = self.file_revision(path);
                    if checked.as_ref().is_err()
                        || checked.as_ref().is_ok_and(|revision| revision != expected)
                    {
                        let _ = parent.remove_file(&temporary);
                        return Err(write_not_started(checked.err().unwrap_or_else(|| {
                            EditorError::new(
                                ErrorCode::Conflict,
                                "File changed since it was read",
                                path,
                            )
                        })));
                    }
                }
                if let Err(error) = parent.rename(&temporary, &parent, &name) {
                    let _ = parent.remove_file(&temporary);
                    return Err(io_error(error, path));
                }
                #[cfg(unix)]
                parent
                    .open(".")
                    .and_then(|directory| directory.sync_all())
                    .map_err(|error| io_error(error, path))?;
                return Ok(revision(bytes));
            }
            WriteMode::Upsert => {
                if self._lock.is_none() {
                    return Err(write_not_started(EditorError::new(
                        ErrorCode::Unsupported,
                        "Upsert is only available in an application-private directory",
                        path,
                    )));
                }
                if let Some(entry) = self.stat(path).map_err(write_not_started)?
                    && entry.kind != EntryKind::File
                {
                    return Err(write_not_started(EditorError::new(
                        ErrorCode::NotFile,
                        "Expected a regular recovery file",
                        path,
                    )));
                }
                if let Some(expected) = expected
                    && self.file_revision(path).map_err(write_not_started)? != expected
                {
                    return Err(write_not_started(EditorError::new(
                        ErrorCode::Conflict,
                        "Recovery file changed since it was read",
                        path,
                    )));
                }
                let temporary = format!(".celestite-{}.tmp", uuid::Uuid::new_v4());
                options.create_new(true);
                #[cfg(unix)]
                {
                    use cap_std::fs::OpenOptionsExt;
                    options.mode(0o600);
                }
                let prepared = (|| {
                    let mut file = parent.open_with(&temporary, &options)?;
                    file.write_all(bytes)?;
                    file.sync_all()
                })();
                if let Err(error) = prepared {
                    let _ = parent.remove_file(&temporary);
                    return Err(write_not_started(io_error(error, path)));
                }
                if let Err(error) = parent.rename(&temporary, &parent, &name) {
                    let _ = parent.remove_file(&temporary);
                    return Err(io_error(error, path));
                }
                #[cfg(unix)]
                parent
                    .open(".")
                    .and_then(|directory| directory.sync_all())
                    .map_err(|error| io_error(error, path))?;
                return Ok(revision(bytes));
            }
        }
        let mut file = parent
            .open_with(&name, &options)
            .map_err(|error| write_not_started(io_error(error, path)))?;
        file.write_all(bytes).map_err(|e| io_error(e, path))?;
        file.sync_all().map_err(|e| io_error(e, path))?;
        #[cfg(unix)]
        parent
            .open(".")
            .and_then(|directory| directory.sync_all())
            .map_err(|error| io_error(error, path))?;
        Ok(revision(bytes))
    }
    pub fn mkdir(&self, path: &str, recursive: bool) -> EditorResult<()> {
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
    pub fn remove(&self, path: &str, recursive: bool) -> EditorResult<()> {
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
    pub fn rename(&self, from: &str, to: &str) -> EditorResult<()> {
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
        // The existence check gives a predictable error but cannot prevent a
        // different process from creating the target immediately afterwards.
        // Require the platform operation itself to refuse replacement.
        #[cfg(any(target_os = "linux", target_os = "android", target_vendor = "apple"))]
        {
            rustix::fs::renameat_with(
                &source,
                source_name.as_str(),
                &target,
                target_name.as_str(),
                rustix::fs::RenameFlags::NOREPLACE,
            )
            .map_err(|error| {
                if matches!(error, rustix::io::Errno::NOSYS | rustix::io::Errno::INVAL) {
                    EditorError::new(
                        ErrorCode::Unsupported,
                        "Atomic rename without replacement is unavailable on this filesystem",
                        to,
                    )
                } else {
                    io_error(error.into(), to)
                }
            })
        }
        #[cfg(not(any(target_os = "linux", target_os = "android", target_vendor = "apple")))]
        {
            // cap-std has no portable no-replace operation. Keep rename
            // available here, with best-effort protection against target
            // creation by external processes after the check above.
            source
                .rename(&source_name, &target, &target_name)
                .map_err(|error| io_error(error, to))
        }
    }
}

impl FileSystem for FsVault {
    async fn stat(&self, path: &str) -> EditorResult<Option<FileEntry>> {
        FsVault::stat(self, path)
    }
    async fn read_dir(&self, path: &str) -> EditorResult<Vec<FileEntry>> {
        FsVault::read_dir(self, path)
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
        FsVault::write_file(self, path, data, mode, expected)
    }
    async fn mkdir(&self, path: &str, recursive: bool) -> EditorResult<()> {
        FsVault::mkdir(self, path, recursive)
    }
    async fn rename(&self, from: &str, to: &str) -> EditorResult<()> {
        FsVault::rename(self, from, to)
    }
    async fn remove(&self, path: &str, recursive: bool) -> EditorResult<()> {
        FsVault::remove(self, path, recursive)
    }
}

#[cfg(test)]
mod tests {
    use super::{EntryKind, ErrorCode, FsVault};
    use crate::fs::WriteMode;
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
            .write_file(
                "a/b/x.md",
                b"long original content",
                WriteMode::Create,
                None,
            )
            .unwrap();
        assert_eq!(
            vault
                .write_file("a/b/x.md", b"bad", WriteMode::Create, None)
                .unwrap_err()
                .code,
            ErrorCode::AlreadyExists
        );
        vault
            .write_file("a/b/x.md", b"new", WriteMode::Replace, Some(&version))
            .unwrap();
        assert_eq!(
            vault
                .write_file("a/b/x.md", b"bad", WriteMode::Replace, Some(&version))
                .unwrap_err()
                .code,
            ErrorCode::Conflict
        );
        assert_eq!(
            vault.read_file_limited("a/b/x.md", u64::MAX).unwrap(),
            b"new"
        );
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
        assert_eq!(
            vault.read_file_limited("renamed/b/x.md", u64::MAX).unwrap(),
            b"new"
        );
        assert_eq!(
            vault.remove("renamed", false).unwrap_err().code,
            ErrorCode::DirectoryNotEmpty
        );
        vault.remove("renamed", true).unwrap();
        assert!(vault.stat("renamed").unwrap().is_none());
        assert_eq!(
            vault
                .write_file("absent", b"x", WriteMode::Replace, None)
                .unwrap_err()
                .code,
            ErrorCode::NotFound
        );
    }

    #[test]
    fn rename_rejects_an_existing_file_without_changing_either_file() {
        let root = tempfile::tempdir().unwrap();
        let vault = FsVault::open(root.path()).unwrap();
        vault
            .write_file("source", b"new", WriteMode::Create, None)
            .unwrap();
        vault
            .write_file("target", b"old", WriteMode::Create, None)
            .unwrap();

        assert_eq!(
            vault.rename("source", "target").unwrap_err().code,
            ErrorCode::AlreadyExists
        );
        assert_eq!(vault.read_file_limited("source", u64::MAX).unwrap(), b"new");
        assert_eq!(vault.read_file_limited("target", u64::MAX).unwrap(), b"old");
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
    fn replacement_preserves_permissions_and_preparation_failure_preserves_content() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("a.not");
        std::fs::write(&path, "original").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o640)).unwrap();
        let vault = FsVault::open(root.path()).unwrap();
        let revision = vault
            .write_file("a.not", b"replacement", WriteMode::Replace, None)
            .unwrap();
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o640
        );

        // The existing file is writable, but this directory cannot create a
        // replacement. Unlike truncation, failed preparation leaves it intact.
        std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o500)).unwrap();
        let result = vault.write_file("a.not", b"lost", WriteMode::Replace, Some(&revision));
        std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        match result {
            Err(error) => {
                assert_eq!(error.code, ErrorCode::PermissionDenied);
                assert!(error.write_not_started);
                assert_eq!(std::fs::read(&path).unwrap(), b"replacement");
            }
            // Privileged test runners can bypass directory permissions.
            Ok(_) => assert_eq!(std::fs::read(&path).unwrap(), b"lost"),
        }
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 1);
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
            vault
                .read_file_limited("link/secret", u64::MAX)
                .unwrap_err()
                .code,
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
