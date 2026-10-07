//! A synchronous, single-owner text replica. `apply` is the only command entry
//! point. Every accepted command returns one `BufferUpdate`; the owner decides
//! how to persist, publish or transmit it. There are no sockets, files, clocks,
//! UI conventions, callbacks into callers, or hidden event queues here.
//!
//! Import admission can be split into `prepare_import` and `commit_import`.
//! Preparation is read-only and single-use: a changed/different Buffer rejects
//! the token. Commit applies the original operations to the original replica,
//! preserving its writer, undo stack and anchors.

pub(crate) mod filesystem;
#[cfg(test)]
mod filesystem_tests;
mod history;
mod positions;
mod text;
mod types;
mod undo;
pub(crate) use filesystem::FilesystemChange;
pub use history::PreparedImport;
pub use text::{difference as text_difference, utf16_to_byte};
pub use types::*;

use history::{
    PendingImport, state_version, validate_document, validate_identity, validate_packet,
};
use loro::{LoroDoc, LoroText};
use std::sync::Arc;
use text::{difference, validate_edits};
use types::{AnchorTarget, crdt_error};
use undo::{Restoration, UndoSession};

const SOURCE: &str = "source";

pub struct Buffer {
    identity: DocumentIdentity,
    doc: LoroDoc,
    text: LoroText,
    undo: UndoSession,
    revision: u64,
    owner: Arc<()>,
    pending_imports: Vec<PendingImport>,
}

impl Buffer {
    /// Create a history once. Other replicas join its snapshot, not its string.
    /// An explicit writer requires caller-guaranteed uniqueness; None generates one.
    pub fn new(
        identity: DocumentIdentity,
        writer: Option<u64>,
        initial: &str,
    ) -> Result<Self, CoreError> {
        validate_identity(&identity)?;
        let doc = LoroDoc::new();
        if let Some(writer) = writer {
            doc.set_peer_id(writer).map_err(crdt_error)?;
        }
        doc.get_text(SOURCE)
            .insert(0, initial)
            .map_err(crdt_error)?;
        doc.commit();
        Ok(Self::attach(identity, doc))
    }

    /// Join full history with a fresh personal undo session and writer.
    pub fn from_snapshot(packet: &SyncPacket, writer: Option<u64>) -> Result<Self, CoreError> {
        validate_identity(&packet.identity)?;
        validate_packet(packet)?;
        if packet.kind != PacketKind::Snapshot {
            return Err(CoreError::InvalidPacket);
        }
        let doc = LoroDoc::from_snapshot(&packet.data).map_err(crdt_error)?;
        if doc.is_shallow() {
            return Err(CoreError::UnsupportedHistory);
        }
        validate_document(&doc)?;
        let writer = writer.unwrap_or_else(|| LoroDoc::new().peer_id());
        if doc.oplog_vv().get(&writer).copied().unwrap_or(0) != 0 {
            return Err(CoreError::WriterAlreadyUsed {
                peer: writer.to_string(),
            });
        }
        doc.set_peer_id(writer).map_err(crdt_error)?;
        Ok(Self::attach(packet.identity.clone(), doc))
    }

    fn attach(identity: DocumentIdentity, doc: LoroDoc) -> Self {
        let text = doc.get_text(SOURCE);
        let undo = UndoSession::new(&doc);
        Self {
            identity,
            doc,
            text,
            undo,
            revision: 0,
            owner: Arc::new(()),
            pending_imports: vec![],
        }
    }

    pub fn identity(&self) -> &DocumentIdentity {
        &self.identity
    }
    pub fn writer_id(&self) -> String {
        self.doc.peer_id().to_string()
    }
    pub fn version(&self) -> Version {
        state_version(&self.identity, &self.doc)
    }
    pub fn undo_state(&self) -> UndoState {
        self.undo.state()
    }
    pub fn snapshot(&self) -> TextSnapshot {
        TextSnapshot {
            text: self.text.to_string(),
            version: self.version(),
            revision: self.revision,
        }
    }

    /// Compare a file baseline without allocating a second copy of the text.
    pub fn content_matches(&self, value: &str) -> bool {
        if self.text.len_utf8() != value.len() {
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

    /// Rejected input never changes text, undo grouping, revision or pending
    /// history. Successful no-ops have `changed == false` and no operation.
    pub fn apply(&mut self, command: BufferCommand) -> Result<BufferUpdate, CoreError> {
        match command {
            BufferCommand::Edit(edit) => self.apply_edit(edit),
            BufferCommand::Undo { base, context } => self.apply_history(base, false, context),
            BufferCommand::Redo { base, context } => self.apply_history(base, true, context),
            BufferCommand::Import(input) => {
                let prepared = self.prepare_import(input)?;
                self.commit_import(prepared)
            }
            BufferCommand::ClearUndo => {
                let before = self.snapshot();
                let previous = self.undo_state();
                self.undo.clear();
                Ok(self.finish(
                    before,
                    ChangeCause::HistoryCleared,
                    Some(vec![]),
                    None,
                    None,
                    previous != self.undo_state(),
                ))
            }
        }
    }

    fn apply_edit(&mut self, edit: Edit) -> Result<BufferUpdate, CoreError> {
        self.check_identity(&edit.base.identity)?;
        if edit.base != self.version() {
            return Err(CoreError::StaleVersion);
        }
        let before = self.snapshot();
        let edits = match edit.input {
            TextInput::Edits { edits } => edits,
            TextInput::Text { text } => difference(&before.text, &text),
        };
        let edits = validate_edits(&before.text, &edits)?;
        let cursors = self.undo_cursors_at(&before.text, &edit.undo.positions)?;
        let cause = ChangeCause::Local {
            origin: edit.origin.clone(),
        };
        if edits.is_empty() {
            return Ok(self.finish(before, cause, Some(edits), None, None, false));
        }
        // All fallible input validation precedes changing the undo session.
        self.undo.record(edit.group, edit.undo.metadata, cursors);
        let counter = self.local_counter();
        for edit in edits.iter().rev() {
            if edit.to > edit.from {
                self.text
                    .delete_utf16(edit.from, edit.to - edit.from)
                    .expect("validated text deletion");
            }
            if !edit.insert.is_empty() {
                self.text
                    .insert_utf16(edit.from, &edit.insert)
                    .expect("validated text insertion");
            }
        }
        self.doc.set_next_commit_origin(&edit.origin);
        self.doc.commit();
        let operation = self.local_operations(counter);
        Ok(self.finish(before, cause, Some(edits), operation, None, true))
    }

    fn apply_history(
        &mut self,
        base: Version,
        redo: bool,
        context: UndoContext,
    ) -> Result<BufferUpdate, CoreError> {
        self.check_identity(&base.identity)?;
        if base != self.version() {
            return Err(CoreError::StaleVersion);
        }
        let before = self.snapshot();
        let cursors = self.undo_cursors_at(&before.text, &context.positions)?;
        let previous = self.undo_state();
        self.undo.prepare(context.metadata, cursors);
        let counter = self.local_counter();
        let applied = self.undo.apply(redo).expect("valid personal undo session");
        let operation = self.local_operations(counter);
        let changed = applied || operation.is_some() || previous != self.undo_state();
        let restored = changed.then(|| self.undo.take_restoration());
        Ok(self.finish(
            before,
            if redo {
                ChangeCause::Redo
            } else {
                ChangeCause::Undo
            },
            None,
            operation,
            restored,
            changed,
        ))
    }

    fn finish(
        &mut self,
        before: TextSnapshot,
        cause: ChangeCause,
        edits: Option<Vec<TextEdit>>,
        operation: Option<SyncPacket>,
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
            self.revision = self
                .revision
                .checked_add(1)
                .expect("Buffer revision exhausted");
        }
        let after = self.version();
        let edits = edits.unwrap_or_else(|| {
            if before.version == after {
                vec![]
            } else {
                self.display_delta(&before)
                    .unwrap_or_else(|| difference(&before.text, &self.text.to_string()))
            }
        });
        let restored = restored.map(|restored| {
            let text = self.text.to_string();
            UndoContext {
                metadata: restored.metadata,
                positions: restored
                    .positions
                    .iter()
                    .map(|index| text.chars().take(*index).map(char::len_utf16).sum())
                    .collect(),
            }
        });
        BufferUpdate {
            before_len: before.text.encode_utf16().count(),
            after_len: self.text.len_utf16(),
            before: before.version,
            after,
            cause,
            changed,
            revision: self.revision,
            edits,
            undo: self.undo_state(),
            restored,
            operation,
            pending: !self.pending_imports.is_empty(),
        }
    }

    fn check_identity(&self, identity: &DocumentIdentity) -> Result<(), CoreError> {
        if identity == &self.identity {
            Ok(())
        } else {
            Err(CoreError::IdentityMismatch)
        }
    }
}
