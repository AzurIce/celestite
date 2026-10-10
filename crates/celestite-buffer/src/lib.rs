//! A synchronous, single-owner text replica. Every accepted mutation returns
//! one `BufferUpdate`; the owner decides how to persist, publish or transmit it.
//! There are no files, sockets, UI conventions or hidden event queues here.
//!
//! Import admission can be split into read-only `prepare_import` and single-use
//! `commit_import`. Commit preserves the original peer ID, undo stack and anchors.

pub mod change;
#[cfg(test)]
mod change_tests;
pub mod codec;
pub mod history;
pub mod positions;
pub mod text;
pub mod types;
mod undo;

use history::{
    PendingImport, state_version, validate_document, validate_identity, validate_packet,
};
use loro::{LoroDoc, LoroText};
use positions::ToOffset;
use std::{ops::Range, sync::Arc};
use text::difference;
use types::{
    BufferError, BufferUpdate, ChangeCause, DocumentIdentity, EditOptions, HistoryPacket,
    HistoryPacketKind, TextEdit, TextSnapshot, UndoContext, UndoState, Version, crdt_error,
};
use undo::{Restoration, UndoSession};

const SOURCE: &str = "source";

/// Allocate a fresh, ephemeral peer ID without exposing the CRDT runtime.
pub fn new_peer_id() -> u64 {
    LoroDoc::new().peer_id()
}

pub struct Buffer {
    identity: DocumentIdentity,
    doc: LoroDoc,
    text: LoroText,
    undo: UndoSession,
    version: Version,
    state_revision: u64,
    owner: Arc<()>,
    pending_imports: Vec<PendingImport>,
}

impl Buffer {
    /// Create a history once. Other replicas join its snapshot, not its string.
    pub fn new(identity: DocumentIdentity, initial: &str) -> Result<Self, BufferError> {
        Self::with_peer_id(identity, new_peer_id(), initial)
    }

    /// An explicit peer ID requires caller-guaranteed uniqueness.
    pub fn with_peer_id(
        identity: DocumentIdentity,
        peer_id: u64,
        initial: &str,
    ) -> Result<Self, BufferError> {
        validate_identity(&identity)?;
        let doc = LoroDoc::new();
        doc.set_peer_id(peer_id).map_err(crdt_error)?;
        doc.get_text(SOURCE)
            .insert(0, initial)
            .map_err(crdt_error)?;
        doc.commit();
        Ok(Self::attach(identity, doc))
    }

    /// Join full history with a fresh personal undo session and generated peer ID.
    pub fn from_snapshot(packet: &HistoryPacket) -> Result<Self, BufferError> {
        Self::from_snapshot_with_peer_id(packet, new_peer_id())
    }

    pub fn from_snapshot_with_peer_id(
        packet: &HistoryPacket,
        peer_id: u64,
    ) -> Result<Self, BufferError> {
        validate_identity(&packet.identity)?;
        validate_packet(packet)?;
        if packet.kind != HistoryPacketKind::Snapshot {
            return Err(BufferError::InvalidPacket);
        }
        let doc = LoroDoc::from_snapshot(&packet.data).map_err(crdt_error)?;
        if doc.is_shallow() {
            return Err(BufferError::UnsupportedHistory);
        }
        validate_document(&doc)?;
        if doc.oplog_vv().get(&peer_id).copied().unwrap_or(0) != 0 {
            return Err(BufferError::PeerIdAlreadyUsed { peer_id });
        }
        doc.set_peer_id(peer_id).map_err(crdt_error)?;
        Ok(Self::attach(packet.identity.clone(), doc))
    }

    fn attach(identity: DocumentIdentity, doc: LoroDoc) -> Self {
        let text = doc.get_text(SOURCE);
        let undo = UndoSession::new(&doc);
        let version = state_version(&identity, &doc);
        Self {
            identity,
            doc,
            text,
            undo,
            version,
            state_revision: 0,
            owner: Arc::new(()),
            pending_imports: vec![],
        }
    }

    pub fn identity(&self) -> &DocumentIdentity {
        &self.identity
    }
    pub fn peer_id(&self) -> u64 {
        self.doc.peer_id()
    }
    pub fn version(&self) -> Version {
        self.version.clone()
    }
    pub fn undo_state(&self) -> UndoState {
        self.undo.state()
    }
    /// Caller tags still owned by Loro history or queued restoration receipts.
    pub fn undo_tags(&self) -> Vec<u64> {
        self.undo.tags()
    }
    /// Current UTF-8 byte length; this does not materialize the document.
    pub fn len(&self) -> usize {
        self.text.len_utf8()
    }
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
    /// Explicitly materialize the entire document.
    pub fn text(&self) -> String {
        self.text.to_string()
    }
    pub fn snapshot(&self) -> TextSnapshot {
        TextSnapshot {
            text: self.text().into(),
            version: self.version(),
            state_revision: self.state_revision,
        }
    }
    pub fn has_pending_imports(&self) -> bool {
        !self.pending_imports.is_empty()
    }

    /// Read a half-open byte range, validating both scalar boundaries.
    pub fn slice(&self, range: Range<usize>) -> Result<String, BufferError> {
        if range.start > range.end {
            return Err(BufferError::InvalidEdits);
        }
        let start = self.scalar_index(range.start)?;
        let end = self.scalar_index(range.end)?;
        self.text.slice(start, end).map_err(crdt_error)
    }

    /// Compare a file baseline without allocating a second copy of the text.
    pub fn content_matches(&self, value: &str) -> bool {
        if self.len() != value.len() {
            return false;
        }
        let mut remaining = value;
        let mut matches = true;
        self.text.iter(|chunk| {
            if let Some(rest) = remaining.strip_prefix(chunk) {
                remaining = rest;
                true
            } else {
                matches = false;
                false
            }
        });
        matches && remaining.is_empty()
    }

    /// Ranges refer to BEFORE-text bytes and must be ordered and disjoint.
    /// Rejected input and successful no-ops do not change history or grouping.
    pub fn edit<P: ToOffset, S: Into<String>>(
        &mut self,
        edits: impl IntoIterator<Item = (Range<P>, S)>,
    ) -> Result<BufferUpdate, BufferError> {
        self.edit_with(edits, EditOptions::default())
    }

    pub fn edit_with<P: ToOffset, S: Into<String>>(
        &mut self,
        edits: impl IntoIterator<Item = (Range<P>, S)>,
        options: EditOptions,
    ) -> Result<BufferUpdate, BufferError> {
        let mut previous: Option<(usize, usize)> = None;
        let mut useful = Vec::new();
        for (range, insert) in edits {
            let from = range.start.to_offset(self)?;
            let to = range.end.to_offset(self)?;
            if from > to || previous.is_some_and(|(start, end)| end > from || start == from) {
                return Err(BufferError::InvalidEdits);
            }
            // ToOffset is open to callers: validate even custom implementations.
            self.scalar_index(from)?;
            self.scalar_index(to)?;
            let insert = insert.into();
            if to - from != insert.len() || self.slice(from..to)? != insert {
                useful.push(TextEdit { from, to, insert });
            }
            previous = Some((from, to));
        }
        let cursors = self.undo_cursors_at(&options.undo.positions)?;
        let before = self.version();
        let before_len = self.len();
        if useful.is_empty() {
            return Ok(self.finish(
                before,
                before_len,
                ChangeCause::Local,
                useful,
                None,
                None,
                false,
            ));
        }
        // All fallible input validation precedes changing the undo session.
        self.undo.record(options.group, options.undo.tag, cursors);
        let counter = self.local_counter();
        for edit in useful.iter().rev() {
            if edit.to > edit.from {
                self.text
                    .delete_utf8(edit.from, edit.to - edit.from)
                    .expect("validated text deletion");
            }
            if !edit.insert.is_empty() {
                self.text
                    .insert_utf8(edit.from, &edit.insert)
                    .expect("validated text insertion");
            }
        }
        self.doc.commit();
        let operation = self.local_operations(counter);
        Ok(self.finish(
            before,
            before_len,
            ChangeCause::Local,
            useful,
            operation,
            None,
            true,
        ))
    }

    /// Whole-text replacement is normalized into the same local edit pipeline.
    pub fn replace_text(&mut self, text: &str) -> Result<BufferUpdate, BufferError> {
        self.replace_text_with(text, EditOptions::default())
    }
    pub fn replace_text_with(
        &mut self,
        text: &str,
        options: EditOptions,
    ) -> Result<BufferUpdate, BufferError> {
        let edits = difference(&self.text(), text);
        self.edit_with(
            edits
                .into_iter()
                .map(|edit| (edit.from..edit.to, edit.insert)),
            options,
        )
    }

    pub fn undo(&mut self) -> Result<BufferUpdate, BufferError> {
        self.undo_with(UndoContext::default())
    }
    pub fn undo_with(&mut self, context: UndoContext) -> Result<BufferUpdate, BufferError> {
        self.apply_history(false, context)
    }
    pub fn redo(&mut self) -> Result<BufferUpdate, BufferError> {
        self.redo_with(UndoContext::default())
    }
    pub fn redo_with(&mut self, context: UndoContext) -> Result<BufferUpdate, BufferError> {
        self.apply_history(true, context)
    }

    /// Clear only the personal undo session without reading the text.
    pub fn clear_undo(&mut self) -> Result<BufferUpdate, BufferError> {
        let before = self.version();
        let before_len = self.len();
        let previous = self.undo_state();
        self.undo.clear();
        Ok(self.finish(
            before,
            before_len,
            ChangeCause::HistoryCleared,
            vec![],
            None,
            None,
            previous != self.undo_state(),
        ))
    }

    fn apply_history(
        &mut self,
        redo: bool,
        context: UndoContext,
    ) -> Result<BufferUpdate, BufferError> {
        let cursors = self.undo_cursors_at(&context.positions)?;
        let previous = self.undo_state();
        let cause = if redo {
            ChangeCause::Redo
        } else {
            ChangeCause::Undo
        };
        if !(if redo {
            previous.can_redo
        } else {
            previous.can_undo
        }) {
            return Ok(self.finish(self.version(), self.len(), cause, vec![], None, None, false));
        }
        let before = self.snapshot();
        self.undo.prepare(context.tag, cursors);
        let counter = self.local_counter();
        let applied = self.undo.apply(redo).expect("valid personal undo session");
        let operation = self.local_operations(counter);
        let changed = applied || operation.is_some() || previous != self.undo_state();
        let restored = changed.then(|| self.undo.take_restoration());
        let edits = self.delta_since(&before);
        Ok(self.finish(
            before.version,
            before.text.len(),
            cause,
            edits,
            operation,
            restored,
            changed,
        ))
    }

    fn delta_since(&self, before: &TextSnapshot) -> Vec<TextEdit> {
        if before.version.vector() == &self.doc.state_vv() {
            vec![]
        } else {
            self.display_delta(before)
                .unwrap_or_else(|| difference(&before.text, &self.text()))
        }
    }

    fn finish(
        &mut self,
        before: Version,
        before_len: usize,
        cause: ChangeCause,
        edits: Vec<TextEdit>,
        operation: Option<HistoryPacket>,
        restored: Option<Restoration>,
        changed: bool,
    ) -> BufferUpdate {
        let known = self.doc.oplog_vv();
        self.pending_imports.retain(|waiting| {
            waiting
                .end
                .iter()
                .any(|(peer, end)| known.get(peer).copied().unwrap_or(0) < *end)
        });
        if changed {
            self.state_revision = self
                .state_revision
                .checked_add(1)
                .expect("Buffer state revision exhausted");
            let vector = self.doc.state_vv();
            if self.version.vector() != &vector {
                self.version = Version::from_vector(self.identity.clone(), vector)
                    .expect("valid integrated causal version");
            }
        }
        let restored_frame = restored
            .as_ref()
            .and_then(|restored| restored.frame.clone());
        let restored = restored.map(|restored| UndoContext {
            tag: restored.tag,
            positions: restored
                .positions
                .iter()
                .map(|index| self.byte_index((*index).min(self.text.len_unicode())))
                .collect(),
        });
        BufferUpdate {
            before_len,
            after_len: self.len(),
            before,
            after: self.version(),
            cause,
            changed,
            edits,
            restored,
            operation,
            _restored_frame: restored_frame,
        }
    }

    fn check_identity(&self, identity: &DocumentIdentity) -> Result<(), BufferError> {
        if identity == &self.identity {
            Ok(())
        } else {
            Err(BufferError::IdentityMismatch)
        }
    }
}
