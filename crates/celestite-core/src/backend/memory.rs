//! Volatile private history for headless replicas and the sync debugger.
use super::{
    Backend, DirectoryIntent, DocumentHeader, EditorError, EditorResult, JournalEntry,
    StoredDocument,
};
use crate::instance::InstanceIdentity;
use std::{cell::Cell, collections::BTreeMap};

pub struct MemoryBackend {
    identity: InstanceIdentity,
    documents: BTreeMap<String, StoredDocument>,
    intent: Option<DirectoryIntent>,
    next_id: Cell<u64>,
    clock: fn() -> u64,
}
impl MemoryBackend {
    pub fn new(identity: InstanceIdentity, clock: fn() -> u64) -> Self {
        Self {
            identity,
            documents: BTreeMap::new(),
            intent: None,
            next_id: Cell::new(0),
            clock,
        }
    }
}
impl Backend for MemoryBackend {
    fn identity(&self) -> &InstanceIdentity {
        &self.identity
    }
    fn persistent(&self) -> bool {
        false
    }
    fn new_id(&self) -> EditorResult<String> {
        let next = self.next_id.get() + 1;
        self.next_id.set(next);
        Ok(format!("{}:{next}", self.identity.instance_id))
    }
    fn now_ms(&self) -> u64 {
        (self.clock)()
    }
    async fn load(&mut self) -> EditorResult<Vec<StoredDocument>> {
        Ok(self.documents.values().cloned().collect())
    }
    async fn commit(
        &mut self,
        header: &DocumentHeader,
        entry: Option<&JournalEntry>,
    ) -> EditorResult<()> {
        let previous = self.documents.get(&header.id);
        let sequence = previous.map_or(0, |(head, _)| head.sequence);
        if let Some((head, journal)) = previous
            && head.sequence == header.sequence
            && entry.is_some()
        {
            let expected = serde_json::to_value(entry.unwrap()).unwrap();
            if journal
                .last()
                .is_none_or(|stored| serde_json::to_value(stored).unwrap() != expected)
            {
                return Err(EditorError::new(
                    "IO",
                    "Retried journal content mismatch",
                    &header.path,
                ));
            }
        } else if header.sequence != sequence + u64::from(entry.is_some()) {
            return Err(EditorError::new(
                "IO",
                "Journal sequence mismatch",
                &header.path,
            ));
        }
        let record = self
            .documents
            .entry(header.id.clone())
            .or_insert_with(|| (header.clone(), vec![]));
        if let Some(entry) = entry
            && record.1.len() < header.sequence as usize
        {
            record.1.push(entry.clone());
        }
        record.0 = header.clone();
        Ok(())
    }
    async fn directory_intent(&mut self) -> EditorResult<Option<DirectoryIntent>> {
        Ok(self.intent.clone())
    }
    async fn replace_volatile_documents(&mut self, headers: &[DocumentHeader]) -> EditorResult<()> {
        self.documents = headers
            .iter()
            .map(|header| (header.id.clone(), (header.clone(), vec![])))
            .collect();
        Ok(())
    }
    async fn set_directory_intent(&mut self, intent: Option<&DirectoryIntent>) -> EditorResult<()> {
        self.intent = intent.cloned();
        Ok(())
    }
}
