//! Current-session file baselines. CRDT versions never enter recovery files.
use crate::text::LineEnding;
use celestite_buffer::types::Version;
use serde::{Deserialize, Serialize};

#[derive(Clone)]
pub(super) struct DiskCursor {
    pub version: Version,
    pub observation: u64,
    pub bytes: Vec<u8>,
}

#[derive(Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum WritePhase {
    Prepared,
    #[default]
    Started,
}

#[derive(Clone)]
pub(super) struct PendingWrite {
    pub text: String,
    pub version: Version,
    pub phase: WritePhase,
}

#[derive(Clone)]
pub(super) struct DocumentState {
    pub id: String,
    pub path: String,
    pub saved_text: String,
    pub disk_revision: String,
    pub saved_version: Option<Version>,
    pub pending_write: Option<PendingWrite>,
    pub disk_cursor: Option<DiskCursor>,
    pub deleted: bool,
    pub bom: bool,
    pub line_ending: LineEnding,
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum DirectoryOperation {
    Rename,
    Remove,
}

#[derive(Clone, Serialize, Deserialize)]
pub(super) struct DirectoryIntent {
    pub operation: DirectoryOperation,
    pub from: String,
    pub to: Option<String>,
    /// Original document paths, independent of CRDT identities.
    pub paths: Vec<String>,
}
