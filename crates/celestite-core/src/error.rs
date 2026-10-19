//! Errors shared by the editor and platform IO.
use celestite_buffer::types::BufferError;
use serde::{Deserialize, Serialize};

pub type EditorResult<T> = Result<T, EditorError>;

/// Stable error identity across native, wire and platform boundaries.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ErrorCode {
    #[serde(rename = "IO")]
    Io,
    InvalidEdit,
    InvalidPath,
    NotFound,
    AlreadyExists,
    NotDirectory,
    NotFile,
    DirectoryNotEmpty,
    PermissionDenied,
    QuotaExceeded,
    Busy,
    Closed,
    Conflict,
    StaleVersion,
    FilesystemDiffTimeout,
    FilesystemReconciliationPending,
    InvalidPreview,
    PreviewLimit,
    Unsupported,
}

impl ErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Io => "IO",
            Self::InvalidEdit => "InvalidEdit",
            Self::InvalidPath => "InvalidPath",
            Self::NotFound => "NotFound",
            Self::AlreadyExists => "AlreadyExists",
            Self::NotDirectory => "NotDirectory",
            Self::NotFile => "NotFile",
            Self::DirectoryNotEmpty => "DirectoryNotEmpty",
            Self::PermissionDenied => "PermissionDenied",
            Self::QuotaExceeded => "QuotaExceeded",
            Self::Busy => "Busy",
            Self::Closed => "Closed",
            Self::Conflict => "Conflict",
            Self::StaleVersion => "StaleVersion",
            Self::FilesystemDiffTimeout => "FilesystemDiffTimeout",
            Self::FilesystemReconciliationPending => "FilesystemReconciliationPending",
            Self::InvalidPreview => "InvalidPreview",
            Self::PreviewLimit => "PreviewLimit",
            Self::Unsupported => "Unsupported",
        }
    }
}

impl std::fmt::Display for ErrorCode {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, thiserror::Error)]
#[error("{message}")]
#[serde(rename_all = "camelCase")]
pub struct EditorError {
    pub code: ErrorCode,
    pub message: String,
    #[serde(default)]
    pub path: String,
    /// Filesystem proof that this write attempt never changed the projected file.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub write_not_started: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rename: Option<Box<RenameFailure>>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RenamePhase {
    Copy,
    RemoveSource,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RenameFailure {
    pub from: String,
    pub to: String,
    pub phase: RenamePhase,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cleanup: Option<Box<EditorError>>,
}
impl EditorError {
    pub fn new(code: ErrorCode, message: impl Into<String>, path: &str) -> Self {
        Self {
            code,
            message: message.into(),
            path: path.into(),
            rename: None,
            write_not_started: false,
        }
    }
}
impl From<BufferError> for EditorError {
    fn from(error: BufferError) -> Self {
        let code = match error {
            BufferError::DiffTimeout => ErrorCode::FilesystemDiffTimeout,
            BufferError::StaleVersion | BufferError::StalePreparation => ErrorCode::StaleVersion,
            BufferError::IdentityMismatch
            | BufferError::PeerIdCollision
            | BufferError::PeerIdAlreadyUsed { .. } => ErrorCode::Conflict,
            _ => ErrorCode::InvalidEdit,
        };
        Self::new(code, error.to_string(), "")
    }
}
