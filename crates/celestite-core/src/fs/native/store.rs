//! Atomic JSON files for private native application metadata.
use crate::error::{EditorError, EditorResult, ErrorCode};
use serde::Serialize;
use std::{
    fs::{self as std_fs, File, OpenOptions},
    io::{self, Write},
    path::Path,
};

pub(super) fn io_error(error: io::Error, path: &Path) -> EditorError {
    let code = match error.kind() {
        io::ErrorKind::NotFound => ErrorCode::NotFound,
        io::ErrorKind::PermissionDenied => ErrorCode::PermissionDenied,
        io::ErrorKind::StorageFull => ErrorCode::QuotaExceeded,
        io::ErrorKind::AlreadyExists => ErrorCode::AlreadyExists,
        _ => ErrorCode::Io,
    };
    EditorError::new(code, error.to_string(), &path.to_string_lossy())
}

fn store_error(message: impl Into<String>, path: &Path) -> EditorError {
    EditorError::new(ErrorCode::Io, message, &path.to_string_lossy())
}

fn sync_directory(path: &Path) -> EditorResult<()> {
    // Windows does not support opening directories through File::open. File
    // contents are synchronized there, and rename remains the logical boundary.
    #[cfg(unix)]
    File::open(path)
        .and_then(|file| file.sync_all())
        .map_err(|error| io_error(error, path))?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

pub fn write_json<T: Serialize + ?Sized>(path: &Path, value: &T) -> EditorResult<()> {
    let bytes = serde_json::to_vec(value).map_err(|error| {
        store_error(
            format!("Cannot serialize application metadata: {error}"),
            path,
        )
    })?;
    write_bytes(path, &bytes)
}

/// Atomically publish complete bytes. The parent directory must exist. New
/// files use mode 0600 on Unix, including when replacing an existing file.
pub fn write_bytes(path: &Path, bytes: &[u8]) -> EditorResult<()> {
    if path.file_name().is_none() {
        return Err(EditorError::new(
            ErrorCode::InvalidPath,
            "Expected a file path",
            &path.to_string_lossy(),
        ));
    }
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let temporary = parent.join(format!(".{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temporary)
            .map_err(|error| io_error(error, path))?;
        file.write_all(bytes)
            .and_then(|()| file.sync_all())
            .map_err(|error| io_error(error, path))?;
        drop(file);
        std_fs::rename(&temporary, path).map_err(|error| io_error(error, path))?;
        sync_directory(parent)
    })();
    if result.is_err() {
        let _ = std_fs::remove_file(&temporary);
    }
    result
}
