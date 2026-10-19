//! Observable documents and receipts, shared by native and serialized callers.
use super::observation::ExternalChangeStatus;
use crate::text::LineEnding;
use celestite_buffer::types::{BufferUpdate, UndoState, Version};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorDocument {
    #[serde(flatten)]
    pub status: DocumentStatus,
    pub snapshot: DocumentText,
    pub undo: UndoState,
    #[serde(with = "celestite_buffer::codec::peer_id")]
    pub peer_id: u64,
    pub saved_content: String,
    pub bom: bool,
    pub line_ending: LineEnding,
    pub autosave_delay: Option<u64>,
    pub recovery_delay: Option<u64>,
}
/// Text of one read view. The document version lives in `DocumentStatus`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentText {
    pub text: Arc<str>,
    pub state_revision: u64,
}

/// Lightweight observable state. Reading it never materializes the full text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentStatus {
    pub id: String,
    pub path: String,
    pub version: Version,
    pub saved_version: Option<Version>,
    pub file_revision: String,
    pub dirty: bool,
    pub deleted: bool,
    pub conflict: bool,
    pub error: Option<String>,
    pub external_change: Option<ExternalChangeStatus>,
    pub recovery_error: Option<String>,
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
    pub line_ending: LineEnding,
}

/// One accepted Buffer mutation, including its exact display and transport effects.
#[derive(Debug)]
pub struct EditorMutation {
    pub document: EditorDocument,
    pub update: BufferUpdate,
    /// Accepted imports with missing causal dependencies, at this acceptance.
    pub pending: bool,
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
    pub file_revision: String,
    pub bom: bool,
    pub line_ending: LineEnding,
    pub deleted: bool,
    pub conflict: bool,
    pub error: Option<String>,
    #[serde(default)]
    pub read_only: bool,
}
