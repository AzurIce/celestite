//! Buffer admission and accepted mutation delivery.
use super::types::EditorMutation;
use super::{EditorCore, MAX_TEXT_BYTES, validate_text};
use crate::error::{EditorError, EditorResult, ErrorCode};
use crate::fs::FileSystem;
use celestite_buffer::history::PreparedImport;
use celestite_buffer::positions::ToOffset;
use celestite_buffer::types::{
    BufferError, BufferUpdate, EditOptions, HistoryPacket, ImportOptions, UndoContext,
};
use std::{ops::Range, sync::Arc};

impl<F: FileSystem, R: FileSystem> EditorCore<F, R> {
    /// Edit the current document under this owner's exclusive borrow. Ranges
    /// are UTF-8 bytes (or anchors), all interpreted in the BEFORE state.
    pub fn edit<I, P, S>(&mut self, id: &str, edits: I) -> EditorResult<Arc<EditorMutation>>
    where
        I: IntoIterator<Item = (Range<P>, S)>,
        P: ToOffset,
        S: Into<String>,
    {
        self.edit_with(id, edits, EditOptions::default())
    }

    /// Explicit undo grouping and caller position context are optional. A
    /// rejected edit never changes the text, history or undo group.
    pub fn edit_with<I, P, S>(
        &mut self,
        id: &str,
        edits: I,
        options: EditOptions,
    ) -> EditorResult<Arc<EditorMutation>>
    where
        I: IntoIterator<Item = (Range<P>, S)>,
        P: ToOffset,
        S: Into<String>,
    {
        self.live(id)?;
        let buffer = &self.record(id)?.buffer;
        let mut size = buffer.len();
        let mut previous: Option<(usize, usize)> = None;
        let mut resolved = Vec::new();
        for (range, text) in edits {
            let from = range.start.to_offset(buffer)?;
            let to = range.end.to_offset(buffer)?;
            if from > to || previous.is_some_and(|(start, end)| end > from || start == from) {
                return Err(BufferError::InvalidEdits.into());
            }
            let insert = text.into();
            validate_text(&insert, id)?;
            size = size
                .checked_sub(to - from)
                .and_then(|n| n.checked_add(insert.len()))
                .ok_or_else(|| EditorError::new(ErrorCode::InvalidEdit, "Invalid edit size", id))?;
            previous = Some((from, to));
            resolved.push((from..to, insert));
        }
        if size > MAX_TEXT_BYTES {
            return Err(EditorError::new(
                ErrorCode::Unsupported,
                "Text exceeds 5 MiB",
                id,
            ));
        }
        let update = self
            .records
            .get_mut(id)
            .unwrap()
            .buffer
            .edit_with(resolved, options)?;
        self.accept_update(id, update)
    }

    pub fn replace_text(&mut self, id: &str, text: &str) -> EditorResult<Arc<EditorMutation>> {
        self.replace_text_with(id, text, EditOptions::default())
    }

    /// Whole-text input is diffed by Buffer into the same native edit pipeline.
    pub fn replace_text_with(
        &mut self,
        id: &str,
        text: &str,
        options: EditOptions,
    ) -> EditorResult<Arc<EditorMutation>> {
        self.live(id)?;
        validate_text(text, id)?;
        let update = self
            .records
            .get_mut(id)
            .unwrap()
            .buffer
            .replace_text_with(text, options)?;
        self.accept_update(id, update)
    }

    pub fn undo(&mut self, id: &str) -> EditorResult<Arc<EditorMutation>> {
        self.undo_with(id, UndoContext::default())
    }

    pub fn undo_with(
        &mut self,
        id: &str,
        context: UndoContext,
    ) -> EditorResult<Arc<EditorMutation>> {
        self.live(id)?;
        let update = self
            .records
            .get_mut(id)
            .unwrap()
            .buffer
            .undo_with(context)?;
        self.accept_update(id, update)
    }

    pub fn redo(&mut self, id: &str) -> EditorResult<Arc<EditorMutation>> {
        self.redo_with(id, UndoContext::default())
    }

    pub fn redo_with(
        &mut self,
        id: &str,
        context: UndoContext,
    ) -> EditorResult<Arc<EditorMutation>> {
        self.live(id)?;
        let update = self
            .records
            .get_mut(id)
            .unwrap()
            .buffer
            .redo_with(context)?;
        self.accept_update(id, update)
    }

    pub fn clear_undo(&mut self, id: &str) -> EditorResult<Arc<EditorMutation>> {
        self.live(id)?;
        let update = self.records.get_mut(id).unwrap().buffer.clear_undo()?;
        self.accept_update(id, update)
    }

    pub fn import(&mut self, id: &str, packet: HistoryPacket) -> EditorResult<Arc<EditorMutation>> {
        self.import_with(id, packet, ImportOptions::default())
    }

    pub fn import_with(
        &mut self,
        id: &str,
        packet: HistoryPacket,
        options: ImportOptions,
    ) -> EditorResult<Arc<EditorMutation>> {
        let prepared = self.prepare_import_with(id, packet, options)?;
        self.commit_import(id, prepared)
    }

    pub fn prepare_import(&self, id: &str, packet: HistoryPacket) -> EditorResult<PreparedImport> {
        self.prepare_import_with(id, packet, ImportOptions::default())
    }

    pub fn prepare_import_with(
        &self,
        id: &str,
        packet: HistoryPacket,
        options: ImportOptions,
    ) -> EditorResult<PreparedImport> {
        if packet.data.len() > 16 * 1024 * 1024 {
            return Err(EditorError::new(
                ErrorCode::Unsupported,
                "CRDT packet exceeds 16 MiB",
                id,
            ));
        }
        let prepared = self
            .record(id)?
            .buffer
            .prepare_import_with(packet, options)?;
        validate_text(&prepared.preview().text, id)?;
        Ok(prepared)
    }

    /// Only admission errors are Err. Accepted text always has a receipt.
    pub fn commit_import(
        &mut self,
        id: &str,
        prepared: PreparedImport,
    ) -> EditorResult<Arc<EditorMutation>> {
        // A client following authoritative host state may receive history while read-only or deleted.
        if self.record(id)?.replica.host_authoritative {
        } else {
            self.live(id)?;
        }
        let update = self
            .records
            .get_mut(id)
            .unwrap()
            .buffer
            .commit_import(prepared)?;
        self.accept_update(id, update)
    }

    pub(super) fn accept_update(
        &mut self,
        id: &str,
        update: BufferUpdate,
    ) -> EditorResult<Arc<EditorMutation>> {
        if update.changed {
            self.buffer_changed(id);
        }
        self.publish_update(id, update)
    }

    pub(super) fn publish_update(
        &mut self,
        id: &str,
        update: BufferUpdate,
    ) -> EditorResult<Arc<EditorMutation>> {
        let mutation = Arc::new(EditorMutation {
            pending: self.record(id)?.buffer.has_pending_imports(),
            document: self.read(id)?,
            update,
        });
        self.mutations.push(mutation.clone());
        Ok(mutation)
    }

    /// The owner drains accepted effects, including effects from a later
    /// failing IO operation. Transport formatting is outside the native model.
    pub fn take_mutations(&mut self) -> Vec<Arc<EditorMutation>> {
        std::mem::take(&mut self.mutations)
    }

    fn buffer_changed(&mut self, id: &str) {
        let now = self.now_ms();
        let record = self.records.get_mut(id).unwrap();
        record.refresh_dirty();
        if self.recovery.is_some() {
            record.recovery_pending_since.get_or_insert(now);
        }
        if record.dirty && record.first_dirty.is_none() {
            record.first_dirty = Some(now);
        }
    }

    pub async fn close(&mut self) -> EditorResult<()> {
        self.checkpoint().await
    }
}
