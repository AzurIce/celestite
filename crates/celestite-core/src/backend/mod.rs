//! Platform IO contract. Futures need not be Send: browser IO stays in its Worker.
use crate::instance::InstanceIdentity;
use crate::text::LineEnding;
use celestite_buffer::types::{BufferError, HistoryPacket, Version};
use serde::{Deserialize, Serialize};

#[cfg(all(feature = "wasm", target_arch = "wasm32"))]
pub(crate) mod browser;
pub mod memory;

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
    /// Backend proof that this write attempt never changed the projected file.
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

#[derive(Clone, Serialize, Deserialize)]
pub struct JournalEntry {
    pub packet: HistoryPacket,
    pub applied: Version,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct DiskCursor {
    pub version: Version,
    pub observation: u64,
    /// Exact bytes, including mixed line endings; normalized text is saved_text.
    pub bytes: Vec<u8>,
}
#[derive(Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WritePhase {
    /// Old receipts cannot prove that file IO had not begun.
    #[default]
    Legacy,
    Prepared,
    Started,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct PendingWrite {
    pub text: String,
    // Older OPFS receipts did not record a saved causal version.
    pub version: Option<Version>,
    #[serde(default)]
    pub phase: WritePhase,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub expected_revision: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct DocumentHeader {
    pub id: String,
    pub path: String,
    pub seed: HistoryPacket,
    pub sequence: u64,
    pub applied: Version,
    pub saved_text: String,
    pub disk_revision: String,
    pub saved_version: Option<Version>,
    pub pending_write: Option<PendingWrite>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disk_cursor: Option<DiskCursor>,
    pub deleted: bool,
    pub bom: bool,
    pub line_ending: LineEnding,
}
pub type StoredDocument = (DocumentHeader, Vec<JournalEntry>);

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
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DirectoryOperation {
    Rename,
    Remove,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DirectoryIntent {
    pub operation: DirectoryOperation,
    pub from: String,
    pub to: Option<String>,
    pub entries: Vec<(String, String)>,
}

/// HistoryStore and optional FileProjection in one injected platform adapter.
/// commit() succeeds only after the header and its new journal entry are committed to the history store.
/// This is a logical commit boundary, not a promise of hardware fsync.
/// A failed commit may have completed: repeating the same commit must be safe.
#[allow(async_fn_in_trait)]
pub trait Backend {
    fn identity(&self) -> &InstanceIdentity;
    fn persistent(&self) -> bool;
    fn new_id(&self) -> EditorResult<String>;
    fn has_projection(&self) -> bool {
        false
    }
    fn now_ms(&self) -> u64;
    async fn load(&mut self) -> EditorResult<Vec<StoredDocument>>;
    async fn commit(
        &mut self,
        header: &DocumentHeader,
        entry: Option<&JournalEntry>,
    ) -> EditorResult<()>;
    async fn directory_intent(&mut self) -> EditorResult<Option<DirectoryIntent>>;
    async fn set_directory_intent(&mut self, intent: Option<&DirectoryIntent>) -> EditorResult<()>;
    /// Atomically replace a volatile session's complete history store.
    /// On failure the previous session must remain intact.
    async fn replace_volatile_documents(
        &mut self,
        _headers: &[DocumentHeader],
    ) -> EditorResult<()> {
        Err(EditorError::new(
            ErrorCode::Unsupported,
            "Replica session replacement is unavailable",
            "",
        ))
    }
    async fn stat(&self, path: &str) -> EditorResult<Option<FileEntry>> {
        Err(no_projection(path))
    }
    async fn read_dir(&self, path: &str) -> EditorResult<Vec<FileEntry>> {
        Err(no_projection(path))
    }
    async fn read_file(&self, path: &str, _limit: Option<u64>) -> EditorResult<FileSnapshot> {
        Err(no_projection(path))
    }
    /// Set error.write_not_started only when this attempt provably left the
    /// projected file untouched. An ordinary error carries no such guarantee.
    async fn write_file(
        &self,
        path: &str,
        _data: &[u8],
        _mode: &str,
        _expected: Option<&str>,
    ) -> EditorResult<String> {
        Err(no_projection(path))
    }
    async fn mkdir(&self, path: &str, _recursive: bool) -> EditorResult<()> {
        Err(no_projection(path))
    }
    async fn rename(&self, from: &str, _to: &str) -> EditorResult<()> {
        Err(no_projection(from))
    }
    async fn remove(&self, path: &str, _recursive: bool) -> EditorResult<()> {
        Err(no_projection(path))
    }
}

fn no_projection(path: &str) -> EditorError {
    EditorError::new(
        ErrorCode::Unsupported,
        "This instance has no ordinary file projection",
        path,
    )
}

#[cfg(test)]
mod tests {
    use super::{DocumentHeader, WritePhase};
    use crate::text::LineEnding;
    use serde_json::json;

    #[test]
    fn legacy_opfs_header_json_remains_readable() {
        let header: DocumentHeader = serde_json::from_value(json!({
            "id": "doc",
            "path": "a.md",
            "seed": {
                "identity": { "document_id": "doc", "history_id": "history" },
                "kind": "snapshot",
                "data": [1, 2, 3]
            },
            "sequence": 0,
            "applied": {
                "identity": { "document_id": "doc", "history_id": "history" },
                "clocks": {}
            },
            "saved_text": "a\n",
            "disk_revision": "disk",
            "saved_version": null,
            "pending_write": {
                "text": "a\n",
                "version": null,
                "phase": "legacy",
                "id": null,
                "expected_revision": null
            },
            "deleted": false,
            "bom": false,
            "line_ending": "\r\n"
        }))
        .unwrap();
        assert_eq!(header.line_ending, LineEnding::CrLf);
        assert!(matches!(
            header.pending_write.unwrap().phase,
            WritePhase::Legacy
        ));
    }
}
