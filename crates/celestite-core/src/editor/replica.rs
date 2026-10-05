//! Host snapshots and metadata are validated together before replacing a session.
use super::*;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplicaDocument {
    pub packets: Vec<SyncPacket>,
    pub writer_id: Option<String>,
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
    let writer = input
        .writer_id
        .as_deref()
        .map(str::parse::<u64>)
        .transpose()
        .map_err(|e| EditorError::new("InvalidEdit", e.to_string(), &state.path))?;
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
    let mut document = Document::from_snapshot(&seed, writer)?;
    for packet in packets {
        if packet.kind != PacketKind::Updates || packet.data.len() > 16 * 1024 * 1024 {
            return Err(EditorError::new(
                "InvalidEdit",
                "Invalid session update",
                &state.path,
            ));
        }
        if document.import(&packet, "session".into())?.pending {
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
        disk_revision: state.backend_revision,
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
        hosted: true,
        read_only: state.read_only,
        header,
        document,
        pending_packets: vec![],
        pending_observation: None,
        uncommitted: vec![],
        durable: None,
        conflict: state.conflict,
        error: state.error,
        last_group: String::new(),
        last_edit: 0,
        first_dirty: None,
    })
}

impl<B: Backend> EditorCore<B> {
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
                && self
                    .records
                    .values()
                    .any(|old| !old.header.deleted && old.header.path == next.header.path))
        {
            return Err(EditorError::new(
                "Conflict",
                "Host document identity/path already exists",
                &next.header.path,
            ));
        }
        self.backend.commit(&next.header, None).await?;
        self.records.insert(id.clone(), next);
        self.sync_preview(&id);
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
                .is_some_and(|old| old.document.identity() != record.document.identity())
            {
                return Err(EditorError::new(
                    "Conflict",
                    "Replica history changed",
                    &record.header.path,
                ));
            }
            next.insert(id, record);
        }
        // An open document omitted by the host remains readable as a tombstone.
        // Its old writer and undo stack do not survive the new session.
        for (id, old) in &self.records {
            if next.contains_key(id) {
                continue;
            }
            let packet = old.document.export_snapshot()?;
            let missing = record(ReplicaDocument {
                packets: vec![packet],
                writer_id: None,
                state: ReplicaHostState {
                    path: old.header.path.clone(),
                    version: old.document.version(),
                    saved_content: old.header.saved_text.clone(),
                    backend_revision: old.header.disk_revision.clone(),
                    bom: old.header.bom,
                    line_ending: old.header.line_ending.clone(),
                    deleted: true,
                    read_only: true,
                    conflict: false,
                    error: None,
                    external_change: None,
                },
            })?;
            next.insert(id.clone(), missing);
        }
        let headers: Vec<_> = next.values().map(|record| record.header.clone()).collect();
        self.backend.replace_volatile_documents(&headers).await?;
        self.records = next;
        self.failure = None;
        self.requires_reopen = false;
        for id in self.records.keys().cloned().collect::<Vec<_>>() {
            self.sync_preview(&id);
        }
        Ok(())
    }
}
