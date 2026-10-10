//! Shared editor business: platform adapters implement IO, never save/recovery policy.
use self::observation::ObservationCoordinator;
use self::replica::ReplicaState;
use self::types::{DocumentStatus, EditorDocument, EditorMutation, HostDocument, ReplicaHostState};
use crate::backend::{
    Backend, DiskCursor, DocumentHeader, EditorError, EditorResult, FileSnapshot, JournalEntry,
    WritePhase,
};
use crate::instance::InstanceIdentity;
use crate::source::{DocumentSnapshot, DocumentSourceSnapshot, SourceDocument};
use celestite_buffer::Buffer;
use celestite_buffer::history::PreparedImport;
use celestite_buffer::types::{
    Affinity, Anchor, DocumentIdentity, HistoryPacket, ImportOptions, TextSnapshot, Version,
};
use std::{collections::BTreeMap, sync::Arc};

mod history;
pub mod observation;
mod projection;
pub mod replica;
pub mod types;

pub const MAX_TEXT_BYTES: usize = 5 * 1024 * 1024;

#[derive(Clone, Copy, Default)]
pub enum ExternalChangePolicy {
    #[default]
    Conflict,
    Merge,
}
#[derive(Clone, Copy, Default)]
pub struct EditorOptions {
    pub external_changes: ExternalChangePolicy,
    /// Platforms take detached tasks and compute without holding the live core.
    pub defer_filesystem_diff: bool,
}

struct Record {
    observation: ObservationCoordinator,
    replica: ReplicaState,
    header: DocumentHeader,
    buffer: Buffer,
    dirty: bool,
    pending_observation: Option<ObservationCommit>,
    uncommitted: Vec<JournalEntry>,
    persisted_version: Option<Version>,
    conflict: bool,
    error: Option<String>,
    first_dirty: Option<u64>,
}

struct ObservationCommit {
    header: DocumentHeader,
    entry: Option<JournalEntry>,
    prepared: Option<PreparedImport>,
}

pub struct EditorCore<B: Backend> {
    file_observation_cursor: Option<String>,
    backend: B,
    records: BTreeMap<String, Record>,
    failure: Option<String>,
    requires_reopen: bool,
    options: EditorOptions,
    source_epoch: u64,
    mutations: Vec<Arc<EditorMutation>>,
}

pub fn validate_editor_path(path: &str) -> EditorResult<()> {
    if path.contains(['\\', '\0'])
        || path.starts_with('/')
        || (path.as_bytes().get(1) == Some(&b':') && path.as_bytes()[0].is_ascii_alphabetic())
        || (!path.is_empty()
            && path
                .split('/')
                .any(|p| p.is_empty() || p == "." || p == ".."))
    {
        return Err(EditorError::new(
            "InvalidPath",
            "Expected a Vault-relative path",
            path,
        ));
    }
    Ok(())
}
fn within(path: &str, root: &str) -> bool {
    root.is_empty()
        || path == root
        || path
            .strip_prefix(root)
            .is_some_and(|tail| tail.starts_with('/'))
}
fn validate_text(text: &str, path: &str) -> EditorResult<()> {
    if text.chars().any(|c| c < ' ' && !matches!(c, '\n' | '\t')) {
        return Err(EditorError::new(
            "InvalidEdit",
            "Text uses LF; binary control characters are not accepted",
            path,
        ));
    }
    if text.len() > MAX_TEXT_BYTES {
        return Err(EditorError::new("Unsupported", "Text exceeds 5 MiB", path));
    }
    Ok(())
}
fn decode(bytes: &[u8], path: &str) -> EditorResult<(String, bool, String)> {
    if bytes.len() > MAX_TEXT_BYTES {
        return Err(EditorError::new("Unsupported", "Text exceeds 5 MiB", path));
    }
    let bom = bytes.starts_with(&[0xef, 0xbb, 0xbf]);
    let raw = std::str::from_utf8(if bom { &bytes[3..] } else { bytes })
        .map_err(|_| EditorError::new("Unsupported", "Not a UTF-8 text file", path))?;
    if raw
        .chars()
        .any(|c| c < ' ' && !matches!(c, '\n' | '\r' | '\t'))
    {
        return Err(EditorError::new(
            "Unsupported",
            "Not an editable text file",
            path,
        ));
    }
    let ending = raw
        .find(['\r', '\n'])
        .map(|i| {
            if raw[i..].starts_with("\r\n") {
                "\r\n"
            } else if raw[i..].starts_with('\r') {
                "\r"
            } else {
                "\n"
            }
        })
        .unwrap_or("\n")
        .to_string();
    Ok((raw.replace("\r\n", "\n").replace('\r', "\n"), bom, ending))
}
fn encode(header: &DocumentHeader, text: &str) -> Vec<u8> {
    format!(
        "{}{}",
        if header.bom { "\u{feff}" } else { "" },
        text.replace('\n', &header.line_ending)
    )
    .into_bytes()
}

impl<B: Backend> EditorCore<B> {
    pub async fn open(backend: B) -> EditorResult<Self> {
        Self::open_with_options(backend, EditorOptions::default()).await
    }
    pub async fn open_with_options(mut backend: B, options: EditorOptions) -> EditorResult<Self> {
        let identity = backend.identity();
        if identity.instance_id.is_empty()
            || identity.vault.vault_id.is_empty()
            || identity.vault.history_id.is_empty()
        {
            return Err(EditorError::new("IO", "Invalid instance identity", ""));
        }
        let mut records = BTreeMap::new();
        let mut paths = std::collections::BTreeSet::new();
        for (header, journal) in backend.load().await? {
            validate_editor_path(&header.path)?;
            if header.id != header.seed.identity.document_id
                || records.contains_key(&header.id)
                || (!header.deleted && !paths.insert(header.path.clone()))
                || journal.len() as u64 != header.sequence
                || !matches!(header.line_ending.as_str(), "\n" | "\r" | "\r\n")
            {
                return Err(EditorError::new(
                    "IO",
                    "Invalid stored document identity or journal",
                    &header.path,
                ));
            }
            let mut document = Buffer::from_snapshot(&header.seed)?;
            for entry in journal {
                let _ = document.import(entry.packet.clone())?;
                if document.version() != entry.applied {
                    return Err(EditorError::new(
                        "IO",
                        "Recovered journal version mismatch",
                        &header.path,
                    ));
                }
            }
            validate_text(&document.snapshot().text, &header.path)?;
            if document.version() != header.applied {
                return Err(EditorError::new(
                    "IO",
                    "Recovered document version mismatch",
                    &header.path,
                ));
            }
            if let Some(cursor) = &header.disk_cursor {
                let (disk_text, bom, ending) = decode(&cursor.bytes, &header.path)?;
                if disk_text != header.saved_text
                    || bom != header.bom
                    || ending != header.line_ending
                    || header.saved_version.as_ref() != Some(&cursor.version)
                    || document.historical_text(&cursor.version)? != header.saved_text
                {
                    return Err(EditorError::new(
                        "IO",
                        "Invalid disk history cursor",
                        &header.path,
                    ));
                }
            } else if matches!(options.external_changes, ExternalChangePolicy::Merge) {
                let version = header.saved_version.as_ref().ok_or_else(|| {
                    EditorError::new(
                        "Conflict",
                        "Missing historical disk baseline; explicit recovery required",
                        &header.path,
                    )
                })?;
                if document.historical_text(version)? != header.saved_text {
                    return Err(EditorError::new(
                        "IO",
                        "Historical disk baseline text mismatch",
                        &header.path,
                    ));
                }
            }
            if let Some(pending) = &header.pending_write
                && let Some(version) = &pending.version
                && document.historical_text(version)? != pending.text
            {
                return Err(EditorError::new(
                    "IO",
                    "Invalid pending write version",
                    &header.path,
                ));
            }
            let persisted_version = backend.persistent().then(|| header.applied.clone());
            records.insert(
                header.id.clone(),
                Record {
                    observation: ObservationCoordinator::default(),
                    replica: ReplicaState::default(),
                    dirty: !document.content_matches(&header.saved_text),
                    header,
                    buffer: document,
                    pending_observation: None,
                    uncommitted: vec![],
                    persisted_version,
                    conflict: false,
                    error: None,

                    first_dirty: None,
                },
            );
        }
        let mut core = Self {
            file_observation_cursor: None,
            backend,
            records,
            failure: None,
            requires_reopen: false,
            options,
            source_epoch: 0,
            mutations: vec![],
        };
        core.recover_directory().await?;
        Ok(core)
    }
    pub fn identity(&self) -> &InstanceIdentity {
        self.backend.identity()
    }
    pub fn persistent(&self) -> bool {
        self.backend.persistent()
    }
    fn record(&self, id: &str) -> EditorResult<&Record> {
        self.records
            .get(id)
            .ok_or_else(|| EditorError::new("NotFound", "Document not found", id))
    }
    fn writable(&self) -> EditorResult<()> {
        if let Some(error) = &self.failure {
            return Err(EditorError::new("IO", error, ""));
        }
        Ok(())
    }
    fn live(&self, id: &str) -> EditorResult<()> {
        self.writable()?;
        if !self.record(id)?.replica.attached {
            return Err(EditorError::new(
                "Closed",
                "Replica document is not subscribed",
                id,
            ));
        }
        if self.record(id)?.replica.read_only {
            return Err(EditorError::new(
                "PermissionDenied",
                "当前远端文档只读。",
                id,
            ));
        }
        if self.record(id)?.header.deleted {
            return Err(EditorError::new(
                "NotFound",
                "Document was deleted; its history is retained",
                id,
            ));
        }
        Ok(())
    }
    pub fn status(&self, id: &str) -> EditorResult<DocumentStatus> {
        let record = self.record(id)?;
        let header = &record.header;
        Ok(DocumentStatus {
            id: id.into(),
            path: header.path.clone(),
            version: record.buffer.version(),
            saved_version: header.saved_version.clone(),
            persisted_version: record.persisted_version.clone(),
            file_revision: header.disk_revision.clone(),
            dirty: record.dirty,
            deleted: header.deleted,
            conflict: record.conflict,
            error: record.error.clone(),
            external_change: record.observation.status(),
            persistence_error: self.failure.clone(),
        })
    }
    pub fn resident_status(&self) -> EditorResult<Vec<DocumentStatus>> {
        self.records.keys().map(|id| self.status(id)).collect()
    }
    pub fn host_document(
        &self,
        id: &str,
        include_saved_content: bool,
    ) -> EditorResult<HostDocument> {
        let record = self.record(id)?;
        Ok(HostDocument {
            status: self.status(id)?,
            saved_content: include_saved_content.then(|| record.header.saved_text.clone()),
            bom: record.header.bom,
            line_ending: record.header.line_ending.clone(),
        })
    }
    /// Create stable positions in the currently borrowed document. Offsets are
    /// UTF-8 bytes; transport adapters handle their own snapshot preconditions.
    pub fn anchors_at(
        &self,
        id: &str,
        positions: &[(usize, Affinity)],
    ) -> EditorResult<Vec<Anchor>> {
        let buffer = &self.record(id)?.buffer;
        positions
            .iter()
            .map(|(offset, affinity)| buffer.anchor_at(*offset, *affinity).map_err(Into::into))
            .collect()
    }
    /// Convert stable positions to current byte offsets. The presence transport
    /// checks causal dependencies before calling this ordinary read method.
    pub fn resolve_anchors(&self, id: &str, anchors: &[Anchor]) -> EditorResult<Vec<usize>> {
        let buffer = &self.record(id)?.buffer;
        anchors
            .iter()
            .map(|anchor| anchor.to_offset(buffer).map_err(Into::into))
            .collect()
    }
    pub fn peer_id(&self, id: &str) -> EditorResult<u64> {
        Ok(self.record(id)?.buffer.peer_id())
    }
    /// Caller context tags still owned by personal undo/redo or outstanding
    /// restoration receipts. This lets an external owner release its metadata.
    pub fn undo_tags(&self, id: &str) -> EditorResult<Vec<u64>> {
        Ok(self.record(id)?.buffer.undo_tags())
    }
    /// An explicit history read. Historical snapshots have no local revision;
    /// their causal version is the sole state token.
    pub fn snapshot_at(&self, id: &str, version: &Version) -> EditorResult<TextSnapshot> {
        let buffer = &self.record(id)?.buffer;
        if buffer.version() == *version {
            return Ok(buffer.snapshot());
        }
        Ok(TextSnapshot {
            text: Arc::from(buffer.historical_text(version)?),
            version: version.clone(),
            state_revision: 0,
        })
    }
    /// Read accepted documents without editing, saving, or interpreting a consumer.
    /// The live catalogue and requested immutable bodies share one read boundary.
    /// Missing, deleted and detached IDs are omitted; consumers can retry a capture
    /// when its catalogue changed while they were choosing which bodies to read.
    pub fn document_source(&self, ids: &[String]) -> DocumentSourceSnapshot {
        let requested: std::collections::BTreeSet<_> = ids.iter().map(String::as_str).collect();
        let mut documents = Vec::new();
        let mut snapshots = Vec::new();
        for (id, record) in &self.records {
            if record.header.deleted || !record.replica.attached {
                continue;
            }
            documents.push(SourceDocument {
                id: id.clone(),
                path: record.header.path.clone(),
                version: record.buffer.version(),
            });
            if requested.contains(id.as_str()) {
                snapshots.push(DocumentSnapshot {
                    id: id.clone(),
                    path: record.header.path.clone(),
                    snapshot: record.buffer.snapshot(),
                });
            }
        }
        DocumentSourceSnapshot {
            epoch: self.source_epoch,
            documents,
            snapshots,
        }
    }

    pub fn read(&self, id: &str) -> EditorResult<EditorDocument> {
        let record = self.record(id)?;
        let header = &record.header;
        let snapshot = record.buffer.snapshot();
        let dirty = record.dirty;
        Ok(EditorDocument {
            external_change: record.observation.status(),
            id: id.into(),
            path: header.path.clone(),
            undo: record.buffer.undo_state(),
            peer_id: record.buffer.peer_id(),
            saved_content: header.saved_text.clone(),
            bom: header.bom,
            line_ending: header.line_ending.clone(),
            dirty,
            deleted: header.deleted,
            conflict: record.conflict,
            file_revision: header.disk_revision.clone(),
            saved_version: header.saved_version.clone(),
            persisted_version: record.persisted_version.clone(),
            persistence_error: self.failure.clone(),
            error: record.error.clone(),
            autosave_delay: if dirty
                && (self.backend.has_projection() || record.replica.host_authoritative)
                && !record.replica.read_only
                && !header.deleted
                && !record.conflict
                && record.error.is_none()
                && record.observation.status().is_none()
                && self.failure.is_none()
            {
                Some(
                    800.min(
                        5000_u64.saturating_sub(
                            self.backend.now_ms().saturating_sub(
                                record.first_dirty.unwrap_or(self.backend.now_ms()),
                            ),
                        ),
                    ),
                )
            } else {
                None
            },
            snapshot,
        })
    }
    /// Join an existing history in a private replica, without creating a file projection.
    /// The host supplies the logical path and full snapshot; never seed from plain text.
    pub async fn join(&mut self, path: &str, packet: HistoryPacket) -> EditorResult<String> {
        self.join_with_peer_id(path, packet, None).await
    }
    pub async fn join_with_peer_id(
        &mut self,
        path: &str,
        packet: HistoryPacket,
        peer_id: Option<u64>,
    ) -> EditorResult<String> {
        self.writable()?;
        validate_editor_path(path)?;
        if self.backend.has_projection() || path.is_empty() {
            return Err(EditorError::new(
                "Unsupported",
                "Joining requires a private replica and a file path",
                path,
            ));
        }
        if packet.data.len() > 16 * 1024 * 1024 {
            return Err(EditorError::new(
                "Unsupported",
                "CRDT snapshot exceeds 16 MiB",
                path,
            ));
        }
        let id = packet.identity.document_id.clone();
        if let Some(record) = self.records.get(&id) {
            if record.header.path != path || record.buffer.identity() != &packet.identity {
                return Err(EditorError::new(
                    "Conflict",
                    "Joined document identity/path mismatch",
                    path,
                ));
            }
            return Ok(id);
        }
        if self
            .records
            .values()
            .any(|record| !record.header.deleted && record.header.path == path)
        {
            return Err(EditorError::new(
                "Conflict",
                "Path belongs to another document history",
                path,
            ));
        }
        let document = match peer_id {
            Some(peer_id) => Buffer::from_snapshot_with_peer_id(&packet, peer_id)?,
            None => Buffer::from_snapshot(&packet)?,
        };
        let snapshot = document.snapshot();
        validate_text(&snapshot.text, path)?;
        let header = DocumentHeader {
            id: id.clone(),
            path: path.into(),
            seed: packet,
            sequence: 0,
            applied: snapshot.version,
            saved_text: snapshot.text.to_string(),
            disk_revision: String::new(),
            saved_version: None,
            pending_write: None,
            disk_cursor: None,
            deleted: false,
            bom: false,
            line_ending: "\n".into(),
        };
        self.records.insert(
            id.clone(),
            Record {
                observation: ObservationCoordinator::default(),
                replica: ReplicaState::default(),
                dirty: !document.content_matches(&header.saved_text),
                header,
                buffer: document,
                pending_observation: None,
                uncommitted: vec![],
                persisted_version: None,
                conflict: false,
                error: None,

                first_dirty: None,
            },
        );
        self.persist(&id).await?;
        Ok(id)
    }
    pub async fn open_file(&mut self, path: &str) -> EditorResult<String> {
        validate_editor_path(path)?;
        if let Some(id) = self
            .records
            .values()
            .find(|r| !r.header.deleted && r.header.path == path)
            .map(|r| r.header.id.clone())
        {
            self.refresh(&id).await?;
            return Ok(id);
        }
        self.writable()?;
        let disk = self
            .backend
            .read_file(path, Some(MAX_TEXT_BYTES as u64))
            .await?;
        let (text, bom, line_ending) = decode(&disk.data, path)?;
        let identity = DocumentIdentity {
            document_id: self.backend.new_id()?,
            history_id: self.backend.new_id()?,
        };
        let document = Buffer::new(identity.clone(), &text)?;
        let header = DocumentHeader {
            id: identity.document_id.clone(),
            path: path.into(),
            seed: document.export_snapshot()?,
            sequence: 0,
            applied: document.version(),
            saved_text: text,
            disk_revision: disk.revision,
            saved_version: Some(document.version()),
            pending_write: None,
            disk_cursor: matches!(self.options.external_changes, ExternalChangePolicy::Merge).then(
                || DiskCursor {
                    version: document.version(),
                    observation: 0,
                    bytes: disk.data.clone(),
                },
            ),
            deleted: false,
            bom,
            line_ending,
        };
        self.records.insert(
            header.id.clone(),
            Record {
                observation: ObservationCoordinator::default(),
                replica: ReplicaState::default(),
                dirty: !document.content_matches(&header.saved_text),
                header,
                buffer: document,
                uncommitted: vec![],
                pending_observation: None,
                persisted_version: None,
                conflict: false,
                error: None,

                first_dirty: None,
            },
        );
        self.persist(&identity.document_id).await?;
        Ok(identity.document_id)
    }
    /// Inspect already loaded documents without filesystem IO or accepting new changes.
    pub fn resident(&self) -> EditorResult<Vec<EditorDocument>> {
        self.records.keys().map(|id| self.read(id)).collect()
    }

    /// Observe loaded buffers without opening other files. One invalid file must
    /// not starve unrelated documents; history failures require explicit retry.
    pub async fn reconcile_files(&mut self) -> Vec<EditorError> {
        let mut errors = vec![];
        if !self.backend.has_projection() {
            return errors;
        }
        if let Some(error) = &self.failure {
            errors.push(EditorError::new("IO", error, ""));
            return errors;
        }
        let ids: Vec<_> = self.records.keys().cloned().collect();
        for id in ids {
            if let Err(error) = self.refresh(&id).await {
                errors.push(error);
            }
            if self.failure.is_some() {
                return errors;
            }
        }
        errors
    }

    pub async fn list(&mut self) -> EditorResult<Vec<EditorDocument>> {
        let ids: Vec<_> = self.records.keys().cloned().collect();
        let mut states = vec![];
        for id in ids {
            self.refresh(&id).await?;
            if !self.record(&id)?.header.deleted {
                states.push(self.read(&id)?);
            }
        }
        states.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(states)
    }
    pub async fn refresh_path(&mut self, path: &str) -> EditorResult<()> {
        if let Some(id) = self
            .records
            .values()
            .find(|r| !r.header.deleted && r.header.path == path)
            .map(|r| r.header.id.clone())
        {
            self.refresh(&id).await?;
        }
        Ok(())
    }
    pub async fn refresh(&mut self, id: &str) -> EditorResult<()> {
        self.refresh_disk(id).await?;
        self.compute_inline_observation(id).await
    }

    /// Observe a requested working set and retain per-document failures in its
    /// state. This policy is shared by native and message-based callers.
    pub async fn observe_files(&mut self, ids: &[String]) -> EditorResult<Vec<EditorDocument>> {
        let mut documents = Vec::with_capacity(ids.len());
        for id in ids {
            if let Err(error) = self.refresh(id).await
                && let Some(record) = self.records.get_mut(id)
            {
                record.error = Some(error.message);
            }
            documents.push(self.read(id)?);
        }
        Ok(documents)
    }

    async fn refresh_disk(&mut self, id: &str) -> EditorResult<()> {
        let record = self.record(id)?;
        if !self.backend.has_projection() || record.header.deleted || self.failure.is_some() {
            return Ok(());
        }
        let disk = match self
            .backend
            .read_file(&record.header.path, Some(MAX_TEXT_BYTES as u64))
            .await
        {
            Ok(disk) => disk,
            Err(error) if matches!(error.code.as_str(), "NotFound" | "NotFile" | "Unsupported") => {
                let record = self.records.get_mut(id).unwrap();
                record.conflict = true;
                record.error = Some(error.message);
                record.observation.queued = None;
                record.observation.failure = None;
                return Ok(());
            }
            Err(error) => return Err(error),
        };
        if !self.recover_completed_write(id, &disk).await? {
            return Ok(());
        }
        if matches!(self.options.external_changes, ExternalChangePolicy::Merge) {
            return self.queue_disk_observation(id, disk).await;
        }
        let record = self.record(id)?;
        if disk.revision == record.header.disk_revision {
            let record = self.records.get_mut(id).unwrap();
            record.conflict = false;
            record.error = None;
            return Ok(());
        }
        if !record.buffer.content_matches(&record.header.saved_text) {
            let record = self.records.get_mut(id).unwrap();
            record.conflict = true;
            record.error = Some("文件已在外部修改，本地编辑仍保留。".into());
            return Ok(());
        }
        let (text, bom, ending) = decode(&disk.data, &record.header.path)?;
        self.adopt_disk(id, (text, bom, ending), disk, false).await
    }

    fn cursor(
        &self,
        id: &str,
        version: Version,
        bytes: Vec<u8>,
    ) -> EditorResult<Option<DiskCursor>> {
        if !matches!(self.options.external_changes, ExternalChangePolicy::Merge) {
            return Ok(None);
        }
        let observation = self
            .record(id)?
            .header
            .disk_cursor
            .as_ref()
            .map_or(0, |c| c.observation)
            .checked_add(1)
            .ok_or_else(|| EditorError::new("IO", "Disk observation counter exhausted", id))?;
        Ok(Some(DiskCursor {
            version,
            observation,
            bytes,
        }))
    }

    /// Commit a previously validated candidate before importing into the live Buffer.
    /// Retrying uses the exact same header and packet even when the receipt was lost.
    async fn finish_observation(&mut self, id: &str) -> EditorResult<()> {
        let Some(candidate) = self.record(id)?.pending_observation.as_ref() else {
            return Ok(());
        };
        let header = candidate.header.clone();
        let entry = candidate.entry.clone();
        if let Err(error) = self.backend.commit(&header, entry.as_ref()).await {
            self.failure = Some(format!("文件协调尚未持久化：{}", error.message));
            return Err(error);
        }
        let candidate = self
            .records
            .get_mut(id)
            .unwrap()
            .pending_observation
            .take()
            .unwrap();
        let update = if let Some(prepared) = candidate.prepared {
            let result = self
                .records
                .get_mut(id)
                .unwrap()
                .buffer
                .commit_import(prepared);
            match result {
                Ok(update) if update.after == header.applied => Some(update),
                _ => {
                    self.requires_reopen = true;
                    self.failure =
                        Some("文件协调已提交，但活动 core 未能应用；必须重新打开。".into());
                    return Err(EditorError::new("IO", self.failure.clone().unwrap(), id));
                }
            }
        } else {
            None
        };
        let record = self.records.get_mut(id).unwrap();
        record.header = header;
        record.dirty = !record.buffer.content_matches(&record.header.saved_text);
        record.persisted_version = self
            .backend
            .persistent()
            .then(|| record.header.applied.clone());
        record.observation.queued = None;
        record.observation.failure = None;
        record.conflict = false;
        record.error = None;
        if record.buffer.content_matches(&record.header.saved_text) {
            record.first_dirty = None;
        } else if record.first_dirty.is_none() {
            record.first_dirty = Some(self.backend.now_ms());
        }
        if let Some(update) = update {
            self.publish_update(id, update, Ok(()))?;
        }
        Ok(())
    }

    async fn stage_observation(
        &mut self,
        id: &str,
        header: DocumentHeader,
        entry: Option<JournalEntry>,
        prepared: Option<PreparedImport>,
    ) -> EditorResult<()> {
        if !self.record(id)?.uncommitted.is_empty()
            || self.record(id)?.pending_observation.is_some()
        {
            return Err(EditorError::new(
                "IO",
                "History must be committed before observing disk",
                id,
            ));
        }
        self.records.get_mut(id).unwrap().pending_observation = Some(ObservationCommit {
            header,
            entry,
            prepared,
        });
        self.finish_observation(id).await
    }

    async fn recover_completed_write(
        &mut self,
        id: &str,
        disk: &FileSnapshot,
    ) -> EditorResult<bool> {
        let Some(pending) = self.record(id)?.header.pending_write.clone() else {
            return Ok(true);
        };
        if pending.phase == WritePhase::Prepared {
            // A persisted Prepared record proves that this attempt had not started file IO.
            let mut header = self.record(id)?.header.clone();
            header.pending_write = None;
            self.stage_observation(id, header, None, None).await?;
            return Ok(true);
        }
        if encode(&self.record(id)?.header, &pending.text) == disk.data {
            let mut header = self.record(id)?.header.clone();
            header.saved_text = pending.text;
            header.saved_version = pending.version.clone();
            header.disk_revision = disk.revision.clone();
            header.pending_write = None;
            if let Some(version) = pending.version {
                header.disk_cursor = self.cursor(id, version, disk.data.clone())?;
            }
            self.stage_observation(id, header, None, None).await?;
            return Ok(true);
        }
        // Even seeing the old bytes cannot distinguish no write from write + external ABA.
        let record = self.records.get_mut(id).unwrap();
        record.conflict = true;
        record.error =
            Some("上次文件写回结果不确定，历史、磁盘基线和写回意图已保留；请核对后恢复。".into());
        Ok(false)
    }
    async fn adopt_disk(
        &mut self,
        id: &str,
        decoded: (String, bool, String),
        disk: FileSnapshot,
        clear_undo: bool,
    ) -> EditorResult<()> {
        let (text, bom, ending) = decoded;
        let mut external = Buffer::from_snapshot(&self.record(id)?.buffer.export_snapshot()?)?;
        let external_update = external.replace_text(&text)?;
        let cursor = self.cursor(id, external_update.after, disk.data)?;
        let update = if let Some(packet) = external_update.operation {
            let prepared = self.prepare_import_with(
                id,
                packet,
                ImportOptions {
                    reset_undo: clear_undo,
                },
            )?;
            Some(
                self.records
                    .get_mut(id)
                    .unwrap()
                    .buffer
                    .commit_import(prepared)?,
            )
        } else if clear_undo {
            Some(self.records.get_mut(id).unwrap().buffer.clear_undo()?)
        } else {
            None
        };
        let record = self.records.get_mut(id).unwrap();
        record.header.saved_text = text;
        record.header.saved_version = Some(record.buffer.version());
        record.header.disk_revision = disk.revision;
        record.header.bom = bom;
        record.header.line_ending = ending;
        record.header.pending_write = None;
        record.header.disk_cursor = cursor;
        record.conflict = false;
        record.error = None;
        record.first_dirty = None;
        if let Some(update) = update {
            self.accept_update(id, update, true)
                .await?
                .require_committed()
        } else {
            self.persist(id).await
        }
    }
    pub fn snapshot(&self, id: &str) -> EditorResult<HistoryPacket> {
        Ok(self.record(id)?.buffer.export_snapshot()?)
    }
    pub fn updates(&self, id: &str, version: &Version) -> EditorResult<HistoryPacket> {
        Ok(self.record(id)?.buffer.export_updates_since(version)?)
    }
    pub async fn apply_host_state(
        &mut self,
        id: &str,
        state: ReplicaHostState,
    ) -> EditorResult<()> {
        if self.backend.has_projection() {
            return Err(EditorError::new(
                "Unsupported",
                "Host receipts require a private replica",
                id,
            ));
        }
        validate_editor_path(&state.path)?;
        validate_text(&state.saved_content, &state.path)?;
        if state.path.is_empty()
            || (!state.deleted
                && self.records.iter().any(|(other, record)| {
                    other != id
                        && record.replica.attached
                        && !record.header.deleted
                        && record.header.path == state.path
                }))
        {
            return Err(EditorError::new(
                "Conflict",
                "Host path belongs to another document",
                &state.path,
            ));
        }
        let version = self.record(id)?.buffer.version();
        if !version.contains(&state.version)
            || !matches!(state.line_ending.as_str(), "\n" | "\r" | "\r\n")
        {
            return Err(EditorError::new(
                "Conflict",
                "Host receipt has an unseen or different history",
                id,
            ));
        }
        let record = self.records.get_mut(id).unwrap();
        record.replica = ReplicaState {
            host_authoritative: true,
            attached: true,
            read_only: state.read_only,
        };
        record.header.path = state.path;
        record.header.saved_text = state.saved_content;
        record.header.disk_revision = state.file_revision;
        record.header.bom = state.bom;
        record.header.line_ending = state.line_ending;
        record.header.deleted = state.deleted;
        record.observation.remote = state.external_change;
        record.conflict = state.conflict;
        record.error = state.error;
        if record.buffer.content_matches(&record.header.saved_text) {
            record.first_dirty = None;
        }
        self.persist(id).await?;
        Ok(())
    }
}
