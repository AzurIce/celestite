//! Shared editor business: platform adapters implement IO, never save/recovery policy.
use self::observation::ObservationCoordinator;
use self::replica::ReplicaState;
use self::state::{DirectoryIntent, DiskCursor, DocumentState, WritePhase};
use self::types::{
    DocumentStatus, DocumentText, EditorDocument, EditorMutation, HostDocument, ReplicaHostState,
};
use crate::error::{EditorError, EditorResult, ErrorCode};
use crate::fs::{FileSnapshot, FileSystem};
use crate::instance::InstanceIdentity;
use crate::source::{DocumentSnapshot, DocumentSourceSnapshot, SourceDocument};
use crate::text::{DecodedText, LineEnding};
use celestite_buffer::Buffer;
use celestite_buffer::history::PreparedImport;
use celestite_buffer::types::{
    Affinity, Anchor, DocumentIdentity, HistoryPacket, ImportOptions, TextSnapshot, Version,
};
use std::{collections::BTreeMap, convert::Infallible, sync::Arc};

mod format;
mod mutation;
pub mod observation;
mod projection;
mod recovery;
pub mod replica;
mod state;
pub mod types;

use crate::fs::validate_path;
use format::encode;
pub(crate) use format::{decode, validate_text, within};

pub const MAX_TEXT_BYTES: usize = 5 * 1024 * 1024;
/// Maximum encoded UTF-8 bytes for an accepted LF body, including CRLF and BOM.
pub const MAX_FILE_BYTES: usize = 2 * MAX_TEXT_BYTES + 3;

#[derive(Clone, Copy, Default)]
pub enum ExternalChangePolicy {
    #[default]
    Conflict,
    Merge,
}
#[derive(Clone)]
pub struct EditorOptions {
    pub external_changes: ExternalChangePolicy,
    /// Platforms take detached tasks and compute without holding the live core.
    pub defer_filesystem_diff: bool,
    /// Epoch milliseconds; tests can control scheduling without replacing storage.
    pub clock: Arc<dyn Fn() -> u64 + Send + Sync>,
}

impl Default for EditorOptions {
    fn default() -> Self {
        Self {
            external_changes: ExternalChangePolicy::default(),
            defer_filesystem_diff: false,
            clock: Arc::new(|| {
                web_time::SystemTime::now()
                    .duration_since(web_time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64
            }),
        }
    }
}

struct Record {
    observation: ObservationCoordinator,
    replica: ReplicaState,
    header: DocumentState,
    buffer: Buffer,
    dirty: bool,
    recovery_file: String,
    recovery_pending_since: Option<u64>,
    conflict: bool,
    error: Option<String>,
    first_dirty: Option<u64>,
}

impl Record {
    fn new(header: DocumentState, buffer: Buffer, replica: ReplicaState) -> Self {
        let dirty = !buffer.content_matches(&header.saved_text);
        Self {
            observation: ObservationCoordinator::default(),
            replica,
            header,
            buffer,
            dirty,
            recovery_file: format!("recovery/{}.json", uuid::Uuid::new_v4()),
            recovery_pending_since: None,
            conflict: false,
            error: None,
            first_dirty: None,
        }
    }
    fn status(&self, id: &str, failure: Option<String>) -> DocumentStatus {
        let header = &self.header;
        DocumentStatus {
            id: id.into(),
            path: header.path.clone(),
            version: self.buffer.version(),
            saved_version: header.saved_version.clone(),
            file_revision: header.disk_revision.clone(),
            dirty: self.dirty,
            deleted: header.deleted,
            conflict: self.conflict,
            error: self.error.clone(),
            external_change: self.observation.status(),
            recovery_error: failure,
        }
    }
    fn refresh_dirty(&mut self) {
        self.dirty = !self.buffer.content_matches(&self.header.saved_text);
    }
}

pub struct EditorCore<F: FileSystem = Infallible, R: FileSystem = F> {
    identity: InstanceIdentity,
    file_observation_cursor: Option<String>,
    files: Option<F>,
    recovery: Option<R>,
    directory_intent: Option<DirectoryIntent>,
    records: BTreeMap<String, Record>,
    recovery_error: Option<EditorError>,
    options: EditorOptions,
    source_epoch: u64,
    mutations: Vec<Arc<EditorMutation>>,
}

impl EditorCore {
    /// Create an in-memory editing session without file or recovery capabilities.
    pub fn memory(identity: InstanceIdentity) -> EditorResult<Self> {
        Self::memory_with_options(identity, EditorOptions::default())
    }

    pub fn memory_with_options(
        identity: InstanceIdentity,
        options: EditorOptions,
    ) -> EditorResult<Self> {
        Self::new(identity, None, None, options)
    }
}

impl<F: FileSystem, R: FileSystem> EditorCore<F, R> {
    pub async fn open(
        identity: InstanceIdentity,
        files: Option<F>,
        recovery: Option<R>,
    ) -> EditorResult<Self> {
        Self::open_with_options(identity, files, recovery, EditorOptions::default()).await
    }
    pub async fn open_with_options(
        identity: InstanceIdentity,
        files: Option<F>,
        recovery: Option<R>,
        options: EditorOptions,
    ) -> EditorResult<Self> {
        let mut core = Self::new(identity, files, recovery, options)?;
        core.restore().await?;
        core.recover_directory().await?;
        let ids: Vec<_> = core.records.keys().cloned().collect();
        for id in ids {
            // One missing or inaccessible file must not prevent other drafts opening.
            let _ = core.refresh(&id).await;
        }
        Ok(core)
    }
    fn new(
        identity: InstanceIdentity,
        files: Option<F>,
        recovery: Option<R>,
        options: EditorOptions,
    ) -> EditorResult<Self> {
        if identity.instance_id.is_empty()
            || identity.vault.vault_id.is_empty()
            || identity.vault.history_id.is_empty()
        {
            return Err(EditorError::new(
                ErrorCode::Io,
                "Invalid instance identity",
                "",
            ));
        }
        if recovery.is_some() && files.is_none() {
            return Err(EditorError::new(
                ErrorCode::InvalidEdit,
                "Draft recovery requires a file system",
                "",
            ));
        }
        Ok(Self {
            identity,
            file_observation_cursor: None,
            files,
            recovery,
            directory_intent: None,
            records: BTreeMap::new(),
            recovery_error: None,
            options,
            source_epoch: 0,
            mutations: vec![],
        })
    }
    fn files(&self) -> EditorResult<&F> {
        self.files.as_ref().ok_or_else(|| {
            EditorError::new(
                ErrorCode::Unsupported,
                "This session has no ordinary file system",
                "",
            )
        })
    }
    pub fn identity(&self) -> &InstanceIdentity {
        &self.identity
    }
    fn now_ms(&self) -> u64 {
        (self.options.clock)()
    }
    fn new_id() -> String {
        uuid::Uuid::new_v4().to_string()
    }
    fn record(&self, id: &str) -> EditorResult<&Record> {
        self.records
            .get(id)
            .ok_or_else(|| EditorError::new(ErrorCode::NotFound, "Document not found", id))
    }
    fn live(&self, id: &str) -> EditorResult<()> {
        if !self.record(id)?.replica.attached {
            return Err(EditorError::new(
                ErrorCode::Closed,
                "Replica document is not subscribed",
                id,
            ));
        }
        if self.record(id)?.replica.read_only {
            return Err(EditorError::new(
                ErrorCode::PermissionDenied,
                "当前远端文档只读。",
                id,
            ));
        }
        if self.record(id)?.header.deleted {
            return Err(EditorError::new(
                ErrorCode::NotFound,
                "Document was deleted; its history is retained",
                id,
            ));
        }
        Ok(())
    }
    pub fn status(&self, id: &str) -> EditorResult<DocumentStatus> {
        Ok(self
            .record(id)?
            .status(id, self.recovery_error.as_ref().map(|e| e.message.clone())))
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
            line_ending: record.header.line_ending,
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
        let now = self.now_ms();
        let header = &record.header;
        let snapshot = record.buffer.snapshot();
        let status = record.status(id, self.recovery_error.as_ref().map(|e| e.message.clone()));
        Ok(EditorDocument {
            status,
            undo: record.buffer.undo_state(),
            peer_id: record.buffer.peer_id(),
            saved_content: header.saved_text.clone(),
            bom: header.bom,
            line_ending: header.line_ending,
            recovery_delay: record
                .recovery_pending_since
                .map(|first| 500_u64.saturating_sub(now.saturating_sub(first))),
            autosave_delay: if record.dirty
                && self.files.is_some()
                && !record.replica.read_only
                && !header.deleted
                && !record.conflict
                && record.error.is_none()
                && record.observation.status().is_none()
            {
                Some(800.min(
                    5000_u64.saturating_sub(now.saturating_sub(record.first_dirty.unwrap_or(now))),
                ))
            } else {
                None
            },
            snapshot: DocumentText {
                text: snapshot.text,
                state_revision: snapshot.state_revision,
            },
        })
    }
    /// Join an existing history in a private replica, without creating a file projection.
    /// The host supplies the logical path and full snapshot; never seed from plain text.
    pub fn join(&mut self, path: &str, packet: HistoryPacket) -> EditorResult<String> {
        self.join_with_peer_id(path, packet, None)
    }
    pub fn join_with_peer_id(
        &mut self,
        path: &str,
        packet: HistoryPacket,
        peer_id: Option<u64>,
    ) -> EditorResult<String> {
        validate_path(path)?;
        if self.files.is_some() || path.is_empty() {
            return Err(EditorError::new(
                ErrorCode::Unsupported,
                "Joining requires a private replica and a file path",
                path,
            ));
        }
        if packet.data.len() > 16 * 1024 * 1024 {
            return Err(EditorError::new(
                ErrorCode::Unsupported,
                "CRDT snapshot exceeds 16 MiB",
                path,
            ));
        }
        let id = packet.identity.document_id.clone();
        if let Some(record) = self.records.get(&id) {
            if record.header.path != path || record.buffer.identity() != &packet.identity {
                return Err(EditorError::new(
                    ErrorCode::Conflict,
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
                ErrorCode::Conflict,
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
        let header = DocumentState {
            id: id.clone(),
            path: path.into(),
            saved_text: snapshot.text.to_string(),
            disk_revision: String::new(),
            saved_version: None,
            pending_write: None,
            disk_cursor: None,
            deleted: false,
            bom: false,
            line_ending: LineEnding::Lf,
        };
        self.records.insert(
            id.clone(),
            Record::new(header, document, ReplicaState::default()),
        );
        Ok(id)
    }
    pub async fn open_file(&mut self, path: &str) -> EditorResult<String> {
        validate_path(path)?;
        if let Some(id) = self
            .records
            .values()
            .find(|r| !r.header.deleted && r.header.path == path)
            .map(|r| r.header.id.clone())
        {
            self.refresh(&id).await?;
            return Ok(id);
        }
        let disk = self
            .files()?
            .read_file(path, Some(MAX_FILE_BYTES as u64))
            .await?;
        let decoded = decode(&disk.data, path)?;
        let identity = DocumentIdentity {
            document_id: Self::new_id(),
            history_id: Self::new_id(),
        };
        let document = Buffer::new(identity.clone(), &decoded.text)?;
        let header = DocumentState {
            id: identity.document_id.clone(),
            path: path.into(),
            saved_text: decoded.text,
            disk_revision: disk.revision,
            saved_version: Some(document.version()),
            pending_write: None,
            disk_cursor: Some(DiskCursor {
                version: document.version(),
                observation: 0,
                bytes: disk.data.clone(),
            }),
            deleted: false,
            bom: decoded.bom,
            line_ending: decoded.line_ending,
        };
        self.records.insert(
            header.id.clone(),
            Record::new(header, document, ReplicaState::default()),
        );
        self.checkpoint_document(&identity.document_id).await?;
        Ok(identity.document_id)
    }
    /// Inspect already loaded documents without filesystem IO or accepting new changes.
    pub fn resident(&self) -> EditorResult<Vec<EditorDocument>> {
        self.records.keys().map(|id| self.read(id)).collect()
    }

    /// Observe loaded buffers without opening other files. One invalid file must
    /// not starve unrelated documents.
    pub async fn reconcile_files(&mut self) -> Vec<EditorError> {
        let mut errors = vec![];
        if self.files.is_none() {
            return errors;
        }
        let ids: Vec<_> = self.records.keys().cloned().collect();
        for id in ids {
            if let Err(error) = self.refresh(&id).await {
                errors.push(error);
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
        states.sort_by(|a, b| a.status.path.cmp(&b.status.path));
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
        if self.files.is_none() || record.header.deleted {
            return Ok(());
        }
        let disk = match self
            .files()?
            .read_file(&record.header.path, Some(MAX_FILE_BYTES as u64))
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
        let decoded = decode(&disk.data, &record.header.path)?;
        self.adopt_disk(id, decoded, disk, false).await
    }

    fn cursor(&self, id: &str, version: Version, bytes: Vec<u8>) -> EditorResult<DiskCursor> {
        let observation = self
            .record(id)?
            .header
            .disk_cursor
            .as_ref()
            .map_or(0, |c| c.observation)
            .checked_add(1)
            .ok_or_else(|| {
                EditorError::new(ErrorCode::Io, "Disk observation counter exhausted", id)
            })?;
        Ok(DiskCursor {
            version,
            observation,
            bytes,
        })
    }

    async fn stage_observation(
        &mut self,
        id: &str,
        header: DocumentState,
        prepared: Option<PreparedImport>,
    ) -> EditorResult<()> {
        let update = prepared
            .map(|value| {
                self.records
                    .get_mut(id)
                    .unwrap()
                    .buffer
                    .commit_import(value)
            })
            .transpose()?;
        let now = self.now_ms();
        let record = self.records.get_mut(id).unwrap();
        record.header = header;
        record.refresh_dirty();
        record.observation.queued = None;
        record.observation.failure = None;
        record.conflict = false;
        record.error = None;
        if record.dirty {
            record.first_dirty.get_or_insert(now);
        } else {
            record.first_dirty = None;
        }
        let checkpoint = self.checkpoint_document(id).await;
        if let Some(update) = update {
            self.publish_update(id, update)?;
        }
        checkpoint
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
            self.stage_observation(id, header, None).await?;
            return Ok(true);
        }
        if encode(&self.record(id)?.header, &pending.text) == disk.data {
            let mut header = self.record(id)?.header.clone();
            header.saved_text = pending.text;
            header.saved_version = Some(pending.version.clone());
            header.disk_revision = disk.revision.clone();
            header.pending_write = None;
            header.disk_cursor = Some(self.cursor(id, pending.version, disk.data.clone())?);
            self.stage_observation(id, header, None).await?;
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
        decoded: DecodedText,
        disk: FileSnapshot,
        clear_undo: bool,
    ) -> EditorResult<()> {
        let DecodedText {
            text,
            bom,
            line_ending,
        } = decoded;
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
        record.header.line_ending = line_ending;
        record.header.pending_write = None;
        record.header.disk_cursor = Some(cursor);
        record.refresh_dirty();
        record.conflict = false;
        record.error = None;
        record.first_dirty = None;
        let checkpoint = self.checkpoint_document(id).await;
        if let Some(update) = update {
            self.publish_update(id, update)?;
        }
        checkpoint
    }
    pub fn snapshot(&self, id: &str) -> EditorResult<HistoryPacket> {
        Ok(self.record(id)?.buffer.export_snapshot()?)
    }
    pub fn updates(&self, id: &str, version: &Version) -> EditorResult<HistoryPacket> {
        Ok(self.record(id)?.buffer.export_updates_since(version)?)
    }
    pub fn apply_host_state(&mut self, id: &str, state: ReplicaHostState) -> EditorResult<()> {
        if self.files.is_some() {
            return Err(EditorError::new(
                ErrorCode::Unsupported,
                "Host receipts require a private replica",
                id,
            ));
        }
        validate_path(&state.path)?;
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
                ErrorCode::Conflict,
                "Host path belongs to another document",
                &state.path,
            ));
        }
        let version = self.record(id)?.buffer.version();
        if !version.contains(&state.version) {
            return Err(EditorError::new(
                ErrorCode::Conflict,
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
        record.refresh_dirty();
        record.observation.remote = state.external_change;
        record.conflict = state.conflict;
        record.error = state.error;
        if record.buffer.content_matches(&record.header.saved_text) {
            record.first_dirty = None;
        }
        Ok(())
    }
}
