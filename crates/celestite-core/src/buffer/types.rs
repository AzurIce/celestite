use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::BTreeMap, sync::Arc};

/// Logical identity assigned by the owning application, independent of any
/// connection. A new history needs a new history_id, even for identical text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DocumentIdentity {
    pub document_id: String,
    pub history_id: String,
}

/// A causal state token, scoped to one document history. Decimal peer strings
/// keep 64-bit writer identities exact across JavaScript and native hosts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Version {
    pub identity: DocumentIdentity,
    pub clocks: BTreeMap<String, i32>,
}

/// An owned, immutable point-in-time read. `revision` is local to this instance;
/// use `version`, not revision, for cross-instance comparisons and preconditions.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TextSnapshot {
    pub text: String,
    pub version: Version,
    pub revision: u64,
}

/// Half-open UTF-16 range in the transaction's BEFORE text. Endpoints must be
/// Unicode scalar boundaries; edits must be sorted, disjoint and unambiguous.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TextEdit {
    pub from: usize,
    pub to: usize,
    pub insert: String,
}

/// Two input representations, normalized into the same validated edit script.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TextInput {
    Edits { edits: Vec<TextEdit> },
    Text { text: String },
}

/// A local transaction. The caller chooses gesture boundaries, not an IO clock.
/// Equal, consecutive group IDs share an undo step; None is an independent step.
/// Rejected/no-op edits never change grouping.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Edit {
    pub base: Version,
    pub input: TextInput,
    #[serde(default)]
    pub origin: String,
    #[serde(default)]
    pub group: Option<String>,
    #[serde(default)]
    pub undo: UndoContext,
}

impl Edit {
    pub fn new(base: Version, edits: Vec<TextEdit>) -> Self {
        Self {
            base,
            input: TextInput::Edits { edits },
            origin: String::new(),
            group: None,
            undo: UndoContext::default(),
        }
    }

    /// A whole-text input still becomes an ordinary edit, not another write path.
    pub fn replace(snapshot: &TextSnapshot, text: &str) -> Self {
        Self {
            input: TextInput::Text { text: text.into() },
            ..Self::new(snapshot.version.clone(), vec![])
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Import {
    pub packet: SyncPacket,
    #[serde(default)]
    pub origin: String,
    /// Explicitly discarding an unshared draft can also discard personal undo.
    /// The reset and imported operations form one atomic Buffer update.
    #[serde(default)]
    pub reset_undo: bool,
}

impl Import {
    pub fn new(packet: SyncPacket, origin: impl Into<String>) -> Self {
        Self {
            packet,
            origin: origin.into(),
            reset_undo: false,
        }
    }
}

/// Commands accepted by `Buffer::apply`, shared by Rust and WASM callers.
/// Import can additionally split admission from commitment using PreparedImport.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BufferCommand {
    Edit(Edit),
    Undo {
        base: Version,
        #[serde(default)]
        context: UndoContext,
    },
    Redo {
        base: Version,
        #[serde(default)]
        context: UndoContext,
    },
    Import(Import),
    ClearUndo,
}

/// Opaque caller metadata and BEFORE-text UTF-16 positions. Only positions are
/// interpreted: collaborative undo transforms them, including replaced ranges.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct UndoContext {
    #[serde(default)]
    pub metadata: Option<Value>,
    #[serde(default)]
    pub positions: Vec<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ChangeCause {
    Local { origin: String },
    Import { origin: String },
    Undo,
    Redo,
    HistoryCleared,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoState {
    pub can_undo: bool,
    pub can_redo: bool,
}

/// One accepted command's complete effects. An error means no command was
/// accepted; an unchanged result is a successful no-op. No hidden event queue
/// or second export step is required. Display edits are never CRDT operations.
#[must_use = "the owner must account for accepted operations and their effects"]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BufferUpdate {
    pub cause: ChangeCause,
    pub changed: bool,
    pub before: Version,
    pub after: Version,
    pub before_len: usize,
    pub after_len: usize,
    pub revision: u64,
    pub edits: Vec<TextEdit>,
    pub undo: UndoState,
    /// Positions in AFTER text and metadata restored by undo/redo.
    pub restored: Option<UndoContext>,
    /// Exact accepted bytes for journaling. For local changes these contain
    /// only this writer's new operations; imports retain the original packet.
    /// None for a no-op or a change to personal undo only.
    pub operation: Option<SyncPacket>,
    /// The Buffer still has accepted imports with missing causal dependencies.
    pub pending: bool,
}

impl BufferUpdate {
    /// Only locally generated operations go upstream. A host may redistribute
    /// imported operations separately; an import never masquerades as a local edit.
    pub fn local_operation(&self) -> Option<&SyncPacket> {
        match self.cause {
            ChangeCause::Local { .. } | ChangeCause::Undo | ChangeCause::Redo => {
                self.operation.as_ref()
            }
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PacketKind {
    Snapshot,
    Updates,
}

/// History-scoped transfer/storage object. This is not an authenticated transport.
/// The envelope prevents accidental cross-document/history imports. Only full
/// history snapshots and updates are supported; shallow history is rejected.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncPacket {
    pub identity: DocumentIdentity,
    pub kind: PacketKind,
    pub data: Arc<[u8]>,
}

/// Prospective state after an import, including any queued causal dependencies.
/// Computing it never changes the live Buffer, its writer, revision or undo.
#[derive(Debug, Clone, Serialize)]
pub struct ImportPreview {
    pub text: String,
    pub version: Version,
    pub pending: bool,
}

/// Which side of text inserted at the anchored gap the position follows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Affinity {
    Before,
    After,
}

/// Serializable CRDT position, scoped to one document history. Coordinates are
/// deliberately opaque; use Buffer::resolve_anchor rather than decoding them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Anchor {
    pub(crate) identity: DocumentIdentity,
    pub(crate) affinity: Affinity,
    pub(crate) target: AnchorTarget,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) enum AnchorTarget {
    Start,
    End,
    Character { cursor: Vec<u8>, after: bool },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResolvedAnchor {
    pub offset: usize,
    /// Equivalent position rebased onto current live text, to avoid repeatedly
    /// resolving deleted characters through old history.
    pub refreshed: Anchor,
}

#[derive(Debug, thiserror::Error, Serialize)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum CoreError {
    #[error("document_id and history_id must be nonempty")]
    InvalidIdentity,
    #[error("the object belongs to a different document or history")]
    IdentityMismatch,
    #[error("the transaction was based on an obsolete state")]
    StaleVersion,
    #[error("invalid causal version")]
    InvalidVersion,
    #[error("invalid UTF-16 scalar boundary: {offset}")]
    InvalidPosition { offset: usize },
    #[error("edits must be ordered, disjoint half-open ranges with distinct starts")]
    InvalidEdits,
    #[error("Filesystem diff exceeded its time budget; no operations accepted")]
    FilesystemDiffTimeout,
    #[error("writer {peer} already has operations in this history; use a fresh writer")]
    WriterAlreadyUsed { peer: String },
    #[error("incoming operations reuse this live writer's identity")]
    WriterCollision,
    #[error("shallow or unsupported CRDT history is not accepted")]
    UnsupportedHistory,
    #[error("packet kind does not match its payload")]
    InvalidPacket,
    #[error("the prepared import belongs to another Buffer or an obsolete state")]
    StalePreparation,
    #[error("anchor is unavailable in this replica: {message}")]
    AnchorUnavailable { message: String },
    #[error("CRDT error: {message}")]
    Crdt { message: String },
}

pub(crate) fn crdt_error(error: impl std::fmt::Display) -> CoreError {
    CoreError::Crdt {
        message: error.to_string(),
    }
}
