use loro::VersionVector;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

/// Logical identity assigned by the owning application, independent of any
/// connection. A new history needs a new history_id, even for identical text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "wasm", derive(tsify::Tsify))]
pub struct DocumentIdentity {
    pub document_id: String,
    pub history_id: String,
}

/// A cheap, shared causal state token scoped to one document history.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Version {
    identity: Arc<DocumentIdentity>,
    vector: Arc<VersionVector>,
}

impl Version {
    pub fn identity(&self) -> &DocumentIdentity {
        &self.identity
    }

    pub fn clock(&self, peer: u64) -> i32 {
        self.vector.get(&peer).copied().unwrap_or(0)
    }

    pub fn iter(&self) -> impl Iterator<Item = (u64, i32)> + '_ {
        self.vector.iter().map(|(peer, clock)| (*peer, *clock))
    }

    pub(crate) fn from_vector(
        identity: DocumentIdentity,
        vector: VersionVector,
    ) -> Result<Self, BufferError> {
        super::history::validate_identity(&identity)?;
        if vector.iter().any(|(_, clock)| *clock <= 0) {
            return Err(BufferError::InvalidVersion);
        }
        Ok(Self {
            identity: Arc::new(identity),
            vector: Arc::new(vector),
        })
    }

    pub(crate) fn vector(&self) -> &VersionVector {
        &self.vector
    }

    /// Causal containment is only defined within the same document history.
    pub fn contains(&self, checkpoint: &Self) -> bool {
        self.identity == checkpoint.identity
            && checkpoint
                .iter()
                .all(|(peer_id, clock)| self.clock(peer_id) >= clock)
    }
}

/// An owned, immutable point-in-time read. `state_revision` counts local Buffer
/// state changes, including imports and undo state, not just text changes.
/// Use `version` for cross-instance comparisons and causal preconditions.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "wasm", derive(tsify::Tsify))]
#[cfg_attr(feature = "wasm", tsify(missing_as_null, hashmap_as_object))]
#[serde(rename_all = "camelCase")]
pub struct TextSnapshot {
    #[cfg_attr(feature = "wasm", tsify(type = "string"))]
    pub text: Arc<str>,
    pub version: Version,
    #[serde(alias = "revision")]
    pub state_revision: u64,
}

/// Half-open UTF-8 byte range in the transaction's BEFORE text. Endpoints must be
/// Unicode scalar boundaries; edits must be sorted, disjoint and unambiguous.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TextEdit {
    pub from: usize,
    pub to: usize,
    pub insert: String,
}

/// The caller chooses gesture boundaries, not an IO clock.
/// Equal, consecutive group IDs share an undo step; None is an independent step.
/// Rejected/no-op edits never change grouping.
#[derive(Debug, Clone, Default)]
pub struct EditOptions {
    pub group: Option<String>,
    pub undo: UndoContext,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct ImportOptions {
    /// Explicitly discarding an unshared draft can also discard personal undo.
    /// The reset and imported operations form one atomic Buffer update.
    pub reset_undo: bool,
}

/// Opaque caller tag and BEFORE-text UTF-8 byte positions. Only positions are
/// interpreted: collaborative undo transforms them, including replaced ranges.
/// Tags share a caller-managed namespace: do not reuse a live tag for different
/// context data. External adapters reserve live tags before allocating theirs.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct UndoContext {
    pub tag: Option<u64>,
    pub positions: Vec<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ChangeCause {
    Local,
    Import,
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
#[derive(Debug, Clone)]
pub struct BufferUpdate {
    pub cause: ChangeCause,
    pub changed: bool,
    pub before: Version,
    pub after: Version,
    pub before_len: usize,
    pub after_len: usize,
    pub edits: Vec<TextEdit>,
    /// UTF-8 byte positions in AFTER text and tag restored by undo/redo.
    pub restored: Option<UndoContext>,
    /// Exact accepted bytes for journaling. For local changes these contain
    /// only this peer's new operations; imports retain the original packet.
    /// None for a no-op or a change to personal undo only.
    pub operation: Option<HistoryPacket>,
    /// Keep restored caller context live while a receipt awaits external encoding.
    pub(super) _restored_frame: Option<Arc<Vec<u8>>>,
}

impl BufferUpdate {
    /// Only locally generated operations go upstream. A host may redistribute
    /// imported operations separately; an import never masquerades as a local edit.
    pub fn local_operation(&self) -> Option<&HistoryPacket> {
        match self.cause {
            ChangeCause::Local | ChangeCause::Undo | ChangeCause::Redo => self.operation.as_ref(),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HistoryPacketKind {
    Snapshot,
    Updates,
}

/// History-scoped transfer/storage object. This is not an authenticated transport.
/// The envelope prevents accidental cross-document/history imports. Only full
/// history snapshots and updates are supported; shallow history is rejected.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryPacket {
    pub identity: DocumentIdentity,
    pub kind: HistoryPacketKind,
    pub data: Arc<[u8]>,
}

/// Prospective state after an import, including any queued causal dependencies.
/// Computing it never changes the live Buffer, its peer ID, state revision or undo.
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
/// deliberately opaque; use Anchor::to_offset rather than decoding them.
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

#[derive(Debug, thiserror::Error, Serialize)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum BufferError {
    #[error("document_id and history_id must be nonempty")]
    InvalidIdentity,
    #[error("the object belongs to a different document or history")]
    IdentityMismatch,
    #[error("the transaction was based on an obsolete state")]
    StaleVersion,
    #[error("invalid causal version")]
    InvalidVersion,
    #[error("invalid UTF-8 scalar boundary: {offset}")]
    InvalidPosition { offset: usize },
    #[error("edits must be ordered, disjoint half-open ranges with distinct starts")]
    InvalidEdits,
    #[error("text diff exceeded its time budget; no operations accepted")]
    DiffTimeout,
    #[error("peer {peer_id} already has operations in this history; use a fresh peer")]
    #[serde(rename = "writer_already_used")]
    PeerIdAlreadyUsed {
        #[serde(rename = "peer", with = "crate::codec::peer_id")]
        peer_id: u64,
    },
    #[error("incoming operations reuse this live peer's identity")]
    #[serde(rename = "writer_collision")]
    PeerIdCollision,
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

pub(crate) fn crdt_error(error: impl std::fmt::Display) -> BufferError {
    BufferError::Crdt {
        message: error.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::DocumentIdentity;
    use crate::Buffer;
    use std::sync::Arc;

    #[test]
    fn version_reads_share_both_native_vector_and_history_identity() {
        let mut b = Buffer::new(
            DocumentIdentity {
                document_id: "doc".into(),
                history_id: "history".into(),
            },
            "hello",
        )
        .unwrap();
        let first = b.version();
        let second = b.version();
        assert!(Arc::ptr_eq(&first.vector, &second.vector));
        assert!(Arc::ptr_eq(&first.identity, &second.identity));
        let noop = b.edit([(0..5, "hello")]).unwrap();
        assert!(Arc::ptr_eq(&first.vector, &noop.before.vector));
        assert!(Arc::ptr_eq(&first.vector, &noop.after.vector));
        let changed = b.edit([(0..0, "!")]).unwrap();
        assert!(Arc::ptr_eq(&first.vector, &changed.before.vector));
        assert!(!Arc::ptr_eq(&first.vector, &changed.after.vector));
        assert!(Arc::ptr_eq(&changed.after.vector, &b.version().vector));
    }
}
