//! Platform IO contract. Futures need not be Send: browser IO stays in its Worker.
use crate::{InstanceIdentity, SyncPacket, Version};
use serde::{Deserialize, Serialize};

pub type EditorResult<T> = Result<T, EditorError>;

#[derive(Debug, Clone, Serialize, Deserialize, thiserror::Error)]
#[error("{message}")]
#[serde(rename_all = "camelCase")]
pub struct EditorError {
    pub code: String,
    pub message: String,
    #[serde(default)]
    pub path: String,
    /// Backend proof that this write attempt never changed the projected file.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub write_not_started: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rename: Option<Box<RenameFailure>>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RenameFailure {
    pub from: String,
    pub to: String,
    pub phase: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cleanup: Option<Box<EditorError>>,
}
impl EditorError {
    pub fn new(code: &str, message: impl Into<String>, path: &str) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            path: path.into(),
            rename: None,
            write_not_started: false,
        }
    }
}
impl From<crate::CoreError> for EditorError {
    fn from(error: crate::CoreError) -> Self {
        let code = match error {
            crate::CoreError::StaleVersion => "StaleVersion",
            crate::CoreError::IdentityMismatch
            | crate::CoreError::WriterCollision
            | crate::CoreError::WriterAlreadyUsed { .. } => "Conflict",
            _ => "InvalidEdit",
        };
        Self::new(code, error.to_string(), "")
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub struct JournalEntry {
    pub packet: SyncPacket,
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
    pub seed: SyncPacket,
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
    pub line_ending: String,
}
pub type StoredDocument = (DocumentHeader, Vec<JournalEntry>);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub path: String,
    pub kind: String,
    pub size: Option<u64>,
    pub modified_at: Option<u64>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct FileSnapshot {
    pub data: Vec<u8>,
    pub revision: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DirectoryIntent {
    pub operation: String,
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
    /// Replace a volatile replica after explicitly discarding its local changes.
    /// Durable stores and file projections do not support this operation.
    async fn replace_volatile_record(&mut self, _header: &DocumentHeader) -> EditorResult<()> {
        Err(EditorError::new(
            "Unsupported",
            "Replica reset is unavailable",
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
        "Unsupported",
        "This instance has no ordinary file projection",
        path,
    )
}
