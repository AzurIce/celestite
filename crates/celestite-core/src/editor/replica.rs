//! Host snapshots and metadata are validated together before replacing a session.
use super::observation::ObservationCoordinator;
use super::types::ReplicaHostState;
use super::{EditorCore, Record, validate_editor_path, validate_text};
use crate::backend::{Backend, DocumentHeader, EditorError, EditorResult};
use celestite_buffer::Buffer;
use celestite_buffer::types::{HistoryPacket, HistoryPacketKind};
use std::collections::BTreeMap;

/// Client access and subscription state, independent of deletion and persistence.
/// host_authoritative means host metadata governs this client replica; it is not a host role.
pub(super) struct ReplicaState {
    pub(super) host_authoritative: bool,
    pub(super) attached: bool,
    pub(super) read_only: bool,
}

impl Default for ReplicaState {
    fn default() -> Self {
        Self {
            host_authoritative: false,
            attached: true,
            read_only: false,
        }
    }
}

pub struct ReplicaDocument {
    pub packets: Vec<HistoryPacket>,
    pub peer_id: Option<u64>,
    pub state: ReplicaHostState,
}

fn record(input: ReplicaDocument) -> EditorResult<Record> {
    let state = input.state;
    validate_editor_path(&state.path)?;
    validate_text(&state.saved_content, &state.path)?;
    if state.path.is_empty() || !matches!(state.line_ending.as_str(), "\n" | "\r" | "\r\n") {
        return Err(EditorError::new(
            "InvalidEdit",
            "Invalid host metadata",
            &state.path,
        ));
    }
    let mut packets = input.packets.into_iter();
    let seed = packets
        .next()
        .ok_or_else(|| EditorError::new("InvalidEdit", "Missing session snapshot", &state.path))?;
    if seed.data.len() > 16 * 1024 * 1024 {
        return Err(EditorError::new(
            "Unsupported",
            "CRDT snapshot exceeds 16 MiB",
            &state.path,
        ));
    }
    let mut document = match input.peer_id {
        Some(peer_id) => Buffer::from_snapshot_with_peer_id(&seed, peer_id)?,
        None => Buffer::from_snapshot(&seed)?,
    };
    for packet in packets {
        if packet.kind != HistoryPacketKind::Updates || packet.data.len() > 16 * 1024 * 1024 {
            return Err(EditorError::new(
                "InvalidEdit",
                "Invalid session update",
                &state.path,
            ));
        }
        let _ = document.import(packet)?;
        if document.has_pending_imports() {
            return Err(EditorError::new(
                "InvalidEdit",
                "Session history has missing dependencies",
                &state.path,
            ));
        }
    }
    let snapshot = document.snapshot();
    validate_text(&snapshot.text, &state.path)?;
    if snapshot.version != state.version {
        return Err(EditorError::new(
            "Conflict",
            "Session snapshot and host version differ",
            &state.path,
        ));
    }
    let header = DocumentHeader {
        id: document.identity().document_id.clone(),
        path: state.path,
        seed: document.export_snapshot()?,
        sequence: 0,
        applied: snapshot.version,
        saved_text: state.saved_content,
        disk_revision: state.file_revision,
        saved_version: None,
        pending_write: None,
        disk_cursor: None,
        deleted: state.deleted,
        bom: state.bom,
        line_ending: state.line_ending,
    };
    let mut observation = ObservationCoordinator::default();
    observation.remote = state.external_change;
    Ok(Record {
        observation,
        replica: ReplicaState {
            host_authoritative: true,
            attached: true,
            read_only: state.read_only,
        },
        dirty: !document.content_matches(&header.saved_text),
        header,
        buffer: document,
        pending_observation: None,
        uncommitted: vec![],
        persisted_version: None,
        conflict: state.conflict,
        error: state.error,

        first_dirty: None,
    })
}

impl<B: Backend> EditorCore<B> {
    /// Stop a remote subscription while keeping the Buffer and its personal undo.
    /// A closed cache releases its path reservation; it is not a deleted file.
    pub fn release_replica_document(&mut self, id: &str) -> EditorResult<()> {
        if self.backend.has_projection()
            || self.backend.persistent()
            || !self.record(id)?.replica.host_authoritative
        {
            return Err(EditorError::new(
                "Unsupported",
                "Only volatile hosted replicas can release a subscription",
                id,
            ));
        }
        self.records.get_mut(id).unwrap().replica.attached = false;
        Ok(())
    }
    /// A new document's deletion flag participates in path validation immediately.
    pub async fn join_replica_document(&mut self, input: ReplicaDocument) -> EditorResult<String> {
        self.writable()?;
        if self.backend.has_projection() {
            return Err(EditorError::new(
                "Unsupported",
                "Host snapshots require a private replica",
                "",
            ));
        }
        let next = record(input)?;
        let id = next.header.id.clone();
        if self.records.contains_key(&id)
            || (!next.header.deleted
                && self.records.values().any(|old| {
                    old.replica.attached
                        && !old.header.deleted
                        && old.header.path == next.header.path
                }))
        {
            return Err(EditorError::new(
                "Conflict",
                "Host document identity/path already exists",
                &next.header.path,
            ));
        }
        self.backend.commit(&next.header, None).await?;
        self.records.insert(id.clone(), next);
        Ok(id)
    }

    /// Validate the final catalogue and all histories before touching the old session.
    pub async fn replace_replica_session(
        &mut self,
        inputs: Vec<ReplicaDocument>,
    ) -> EditorResult<()> {
        if self.backend.has_projection() || self.backend.persistent() {
            return Err(EditorError::new(
                "Unsupported",
                "Only volatile private sessions can be replaced",
                "",
            ));
        }
        let mut next = BTreeMap::new();
        let mut paths = std::collections::BTreeSet::new();
        for input in inputs {
            let record = record(input)?;
            let id = record.header.id.clone();
            if next.contains_key(&id)
                || (!record.header.deleted && !paths.insert(record.header.path.clone()))
            {
                return Err(EditorError::new(
                    "Conflict",
                    "Duplicate session document or live path",
                    &record.header.path,
                ));
            }
            if self
                .records
                .get(&id)
                .is_some_and(|old| old.buffer.identity() != record.buffer.identity())
            {
                return Err(EditorError::new(
                    "Conflict",
                    "Replica history changed",
                    &record.header.path,
                ));
            }
            next.insert(id, record);
        }
        // The caller supplies the complete active session catalogue. Closed,
        // unsubscribed caches must not be resurrected as phantom tombstones.
        let headers: Vec<_> = next.values().map(|record| record.header.clone()).collect();
        self.backend.replace_volatile_documents(&headers).await?;
        self.records = next;
        self.source_epoch = self
            .source_epoch
            .checked_add(1)
            .expect("source epoch exhausted");
        // Accepted effects are owned receipts, not borrowed session state.
        // Replacement must not erase an undrained native owner's batch.
        self.failure = None;
        self.requires_reopen = false;
        Ok(())
    }
}
