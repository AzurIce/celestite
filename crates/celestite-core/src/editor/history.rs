//! The single Buffer mutation pipeline: admission, history commitment and delivery.
use super::types::{EditorMutation, HistoryCommit};
use super::{EditorCore, MAX_TEXT_BYTES, validate_text};
use crate::backend::{Backend, EditorError, EditorResult, JournalEntry};
use celestite_buffer::history::PreparedImport;
use celestite_buffer::positions::ToOffset;
use celestite_buffer::types::{
    BufferError, BufferUpdate, EditOptions, HistoryPacket, ImportOptions, UndoContext,
};
use std::{ops::Range, sync::Arc};

impl<B: Backend> EditorCore<B> {
    /// Edit the current document under this owner's exclusive borrow. Ranges
    /// are UTF-8 bytes (or anchors), all interpreted in the BEFORE state.
    pub async fn edit<I, P, S>(&mut self, id: &str, edits: I) -> EditorResult<Arc<EditorMutation>>
    where
        I: IntoIterator<Item = (Range<P>, S)>,
        P: ToOffset,
        S: Into<String>,
    {
        self.edit_with(id, edits, EditOptions::default()).await
    }

    /// Explicit undo grouping and caller position context are optional. A
    /// rejected edit never changes the text, history or undo group.
    pub async fn edit_with<I, P, S>(
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
                .ok_or_else(|| EditorError::new("InvalidEdit", "Invalid edit size", id))?;
            previous = Some((from, to));
            resolved.push((from..to, insert));
        }
        if size > MAX_TEXT_BYTES {
            return Err(EditorError::new("Unsupported", "Text exceeds 5 MiB", id));
        }
        let update = self
            .records
            .get_mut(id)
            .unwrap()
            .buffer
            .edit_with(resolved, options)?;
        self.accept_update(id, update, false).await
    }

    pub async fn replace_text(
        &mut self,
        id: &str,
        text: &str,
    ) -> EditorResult<Arc<EditorMutation>> {
        self.replace_text_with(id, text, EditOptions::default())
            .await
    }

    /// Whole-text input is diffed by Buffer into the same native edit pipeline.
    pub async fn replace_text_with(
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
        self.accept_update(id, update, false).await
    }

    pub async fn undo(&mut self, id: &str) -> EditorResult<Arc<EditorMutation>> {
        self.undo_with(id, UndoContext::default()).await
    }

    pub async fn undo_with(
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
        self.accept_update(id, update, false).await
    }

    pub async fn redo(&mut self, id: &str) -> EditorResult<Arc<EditorMutation>> {
        self.redo_with(id, UndoContext::default()).await
    }

    pub async fn redo_with(
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
        self.accept_update(id, update, false).await
    }

    pub async fn clear_undo(&mut self, id: &str) -> EditorResult<Arc<EditorMutation>> {
        self.live(id)?;
        let update = self.records.get_mut(id).unwrap().buffer.clear_undo()?;
        self.accept_update(id, update, false).await
    }

    pub async fn import(
        &mut self,
        id: &str,
        packet: HistoryPacket,
    ) -> EditorResult<Arc<EditorMutation>> {
        self.import_with(id, packet, ImportOptions::default()).await
    }

    pub async fn import_with(
        &mut self,
        id: &str,
        packet: HistoryPacket,
        options: ImportOptions,
    ) -> EditorResult<Arc<EditorMutation>> {
        let prepared = self.prepare_import_with(id, packet, options)?;
        self.commit_import(id, prepared).await
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
                "Unsupported",
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

    /// Only admission errors are Err. Accepted text always has a receipt,
    /// including when committing its history fails.
    pub async fn commit_import(
        &mut self,
        id: &str,
        prepared: PreparedImport,
    ) -> EditorResult<Arc<EditorMutation>> {
        // A client following authoritative host state may receive history while read-only or deleted.
        if self.record(id)?.replica.host_authoritative {
            self.writable()?;
        } else {
            self.live(id)?;
        }
        let update = self
            .records
            .get_mut(id)
            .unwrap()
            .buffer
            .commit_import(prepared)?;
        self.accept_update(id, update, false).await
    }

    pub(super) async fn accept_update(
        &mut self,
        id: &str,
        update: BufferUpdate,
        header_changed: bool,
    ) -> EditorResult<Arc<EditorMutation>> {
        if let Some(packet) = &update.operation {
            self.queue_packet(id, packet.clone());
        }
        let committed = if header_changed || !self.record(id)?.uncommitted.is_empty() {
            self.persist(id).await
        } else {
            Ok(())
        };
        self.publish_update(id, update, committed)
    }

    pub(super) fn publish_update(
        &mut self,
        id: &str,
        update: BufferUpdate,
        committed: EditorResult<()>,
    ) -> EditorResult<Arc<EditorMutation>> {
        if update.changed {
            self.buffer_changed(id);
        }
        let history = match committed {
            Ok(()) => HistoryCommit::Committed {
                version: update.after.clone(),
                persisted: self.backend.persistent(),
            },
            Err(error) => HistoryCommit::Failed { error },
        };
        let mutation = Arc::new(EditorMutation {
            pending: self.record(id)?.buffer.has_pending_imports(),
            document: self.read(id)?,
            update,
            history,
        });
        self.mutations.push(mutation.clone());
        Ok(mutation)
    }

    /// The owner drains accepted effects, including effects from a later
    /// failing IO operation. Transport formatting is outside the native model.
    pub fn take_mutations(&mut self) -> Vec<Arc<EditorMutation>> {
        std::mem::take(&mut self.mutations)
    }

    fn queue_packet(&mut self, id: &str, packet: HistoryPacket) {
        let record = self.records.get_mut(id).unwrap();
        record.uncommitted.push(JournalEntry {
            packet,
            applied: record.buffer.version(),
        });
    }

    fn buffer_changed(&mut self, id: &str) {
        let record = self.records.get_mut(id).unwrap();
        record.dirty = !record.buffer.content_matches(&record.header.saved_text);
        if record.dirty && record.first_dirty.is_none() {
            record.first_dirty = Some(self.backend.now_ms());
        }
    }

    pub(super) async fn persist(&mut self, id: &str) -> EditorResult<()> {
        let record = self
            .records
            .get_mut(id)
            .ok_or_else(|| EditorError::new("NotFound", "Document not loaded", id))?;
        record.dirty = !record.buffer.content_matches(&record.header.saved_text);
        loop {
            let record = self.record(id)?;
            let entry = record.uncommitted.first().cloned();
            let mut header = record.header.clone();
            if let Some(entry) = &entry {
                header.sequence += 1;
                header.applied = entry.applied.clone();
            }
            if let Err(error) = self.backend.commit(&header, entry.as_ref()).await {
                self.failure = Some(format!("编辑历史尚未持久化：{}", error.message));
                return Err(error);
            }
            let record = self.records.get_mut(id).unwrap();
            record.header = header;
            record.persisted_version = self
                .backend
                .persistent()
                .then(|| record.header.applied.clone());
            if entry.is_some() {
                record.uncommitted.remove(0);
            }
            if record.uncommitted.is_empty() {
                break;
            }
        }
        Ok(())
    }

    /// Finish this owner's accepted history. Derived consumers own their lifecycle.
    pub async fn close(&mut self) -> EditorResult<()> {
        self.retry_history().await
    }

    pub async fn retry_history(&mut self) -> EditorResult<()> {
        if self.requires_reopen {
            return Err(EditorError::new(
                "IO",
                "Committed history requires reopening the core",
                "",
            ));
        }
        let ids: Vec<_> = self.records.keys().cloned().collect();
        for id in ids {
            self.finish_observation(&id).await?;
            self.persist(&id).await?;
        }
        self.failure = None;
        Ok(())
    }
}
