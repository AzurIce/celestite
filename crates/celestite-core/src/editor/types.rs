//! Observable documents and receipts, shared by native and serialized callers.
use super::observation::ExternalChangeStatus;
use crate::backend::{EditorError, EditorResult};
use celestite_buffer::types::{BufferUpdate, TextSnapshot, UndoState, Version};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorDocument {
    pub external_change: Option<ExternalChangeStatus>,
    pub id: String,
    pub path: String,
    pub snapshot: TextSnapshot,
    pub undo: UndoState,
    #[serde(with = "celestite_buffer::codec::peer_id")]
    pub peer_id: u64,
    pub saved_content: String,
    pub bom: bool,
    pub line_ending: String,
    pub dirty: bool,
    pub deleted: bool,
    pub conflict: bool,
    pub file_revision: String,
    pub saved_version: Option<Version>,
    pub persisted_version: Option<Version>,
    pub persistence_error: Option<String>,
    pub error: Option<String>,
    pub autosave_delay: Option<u64>,
}
/// Lightweight observable state. Reading it never materializes the full text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentStatus {
    pub id: String,
    pub path: String,
    pub version: Version,
    pub saved_version: Option<Version>,
    pub persisted_version: Option<Version>,
    pub file_revision: String,
    pub dirty: bool,
    pub deleted: bool,
    pub conflict: bool,
    pub error: Option<String>,
    pub external_change: Option<ExternalChangeStatus>,
    pub persistence_error: Option<String>,
}

/// Only host-owned facts cross the collaboration transport. Personal undo and
/// the local replica peer remain on the receiving EditorCore.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostDocument {
    #[serde(flatten)]
    pub status: DocumentStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub saved_content: Option<String>,
    pub bom: bool,
    pub line_ending: String,
}

/// Acceptance of text and commitment of history are different facts. A failed
/// history write never turns an accepted Buffer mutation into a rejected edit.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum HistoryCommit {
    Committed { version: Version, persisted: bool },
    Failed { error: EditorError },
}

#[derive(Debug)]
pub struct EditorMutation {
    pub document: EditorDocument,
    pub update: BufferUpdate,
    pub history: HistoryCommit,
    /// Accepted imports with missing causal dependencies, at this acceptance.
    pub pending: bool,
}

impl EditorMutation {
    /// Network acknowledgements and ordinary-file saves require this separately
    /// from accepting the edit. Local UI still receives the accepted update.
    pub fn require_committed(&self) -> EditorResult<()> {
        match &self.history {
            HistoryCommit::Committed { .. } => Ok(()),
            HistoryCommit::Failed { error } => Err(error.clone()),
        }
    }
}

/// Host receipt for a private client replica. File baselines remain host-owned;
/// receiving a receipt does not claim the client's volatile history is persisted.
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplicaHostState {
    #[serde(default)]
    pub external_change: Option<ExternalChangeStatus>,
    pub path: String,
    pub version: Version,
    pub saved_content: String,
    #[serde(alias = "backendRevision")]
    pub file_revision: String,
    pub bom: bool,
    pub line_ending: String,
    pub deleted: bool,
    pub conflict: bool,
    pub error: Option<String>,
    #[serde(default)]
    pub read_only: bool,
}
