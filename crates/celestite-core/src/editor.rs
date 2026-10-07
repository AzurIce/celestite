//! Shared editor business: platform adapters implement IO, never save/recovery policy.
use crate::{backend::*, *};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, sync::Arc};

mod observation;
mod replica;
use observation::ObservationCoordinator;
pub use observation::{ExternalChangeStatus, FileObservationResult, FileObservationTask};
pub use replica::ReplicaDocument;

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
    hosted: bool,
    read_only: bool,
    header: DocumentHeader,
    buffer: Buffer,
    pending_observation: Option<ObservationCommit>,
    uncommitted: Vec<JournalEntry>,
    durable: Option<Version>,
    conflict: bool,
    error: Option<String>,
    first_dirty: Option<u64>,
}

struct ObservationCommit {
    header: DocumentHeader,
    entry: Option<JournalEntry>,
    prepared: Option<PreparedImport>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorDocument {
    pub external_change: Option<ExternalChangeStatus>,
    pub id: String,
    pub path: String,
    pub snapshot: TextSnapshot,
    pub undo: UndoState,
    pub writer_id: String,
    pub saved_content: String,
    pub bom: bool,
    pub line_ending: String,
    pub dirty: bool,
    pub deleted: bool,
    pub conflict: bool,
    pub backend_revision: String,
    pub saved_version: Option<Version>,
    pub durable_version: Option<Version>,
    pub persistence_error: Option<String>,
    pub error: Option<String>,
    pub autosave_delay: Option<u64>,
}
/// Acceptance of text and commitment of history are different facts. A failed
/// history write never turns an accepted Buffer mutation into a rejected edit.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum HistoryCommit {
    Committed { version: Version, durable: bool },
    Failed { error: EditorError },
}

#[derive(Debug, Serialize)]
pub struct EditorMutation {
    pub document: EditorDocument,
    pub update: BufferUpdate,
    pub history: HistoryCommit,
}

impl EditorMutation {
    /// Network acknowledgements and ordinary-file saves require this separately
    /// from accepting the edit. Local UI still receives the accepted update.
    pub fn require_committed(&self) -> EditorResult<()> {
        match &self.history {
            HistoryCommit::Committed { .. } => Ok(()),
            HistoryCommit::Failed { error } => Err(error.clone()),
        }
    }
}

/// Host receipt for a private client replica. File baselines remain host-owned;
/// receiving a receipt does not claim the client's volatile history is durable.
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplicaHostState {
    #[serde(default)]
    pub external_change: Option<ExternalChangeStatus>,
    pub path: String,
    pub version: Version,
    pub saved_content: String,
    pub backend_revision: String,
    pub bom: bool,
    pub line_ending: String,
    pub deleted: bool,
    pub conflict: bool,
    pub error: Option<String>,
    #[serde(default)]
    pub read_only: bool,
}

pub struct EditorCore<B: Backend> {
    file_observation_cursor: Option<String>,
    backend: B,
    records: BTreeMap<String, Record>,
    failure: Option<String>,
    requires_reopen: bool,
    options: EditorOptions,
    previews: preview::PreviewSessions,
    preview_environment: BTreeMap<String, Version>,
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
            let mut document = Buffer::from_snapshot(&header.seed, None)?;
            for entry in journal {
                let _ = document.apply(BufferCommand::Import(Import::new(
                    entry.packet.clone(),
                    "recovery",
                )))?;
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
            let durable = backend.persistent().then(|| header.applied.clone());
            records.insert(
                header.id.clone(),
                Record {
                    observation: ObservationCoordinator::default(),
                    hosted: false,
                    read_only: false,
                    header,
                    buffer: document,
                    pending_observation: None,
                    uncommitted: vec![],
                    durable,
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
            previews: preview::PreviewSessions::default(),
            preview_environment: BTreeMap::new(),
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
    /// View subscriptions belong to the caller's transport session. The platform
    /// supplies this identity, rather than trusting a value in a UI request.
    pub fn subscribe_preview(
        &mut self,
        id: &str,
        client_session: &str,
    ) -> EditorResult<PreviewSubscription> {
        if client_session.is_empty() {
            return Err(EditorError::new(
                "InvalidPreview",
                "Missing client session",
                id,
            ));
        }
        self.preview_document(id)?;
        self.sync_preview(id);
        let record = self.record(id)?;
        let snapshot = record.buffer.snapshot();
        let path = record.header.path.clone();
        Ok(self
            .previews
            .subscribe(id, client_session, &snapshot, &path, self.backend.now_ms()))
    }
    pub fn unsubscribe_preview(&mut self, subscription_id: &str, client_session: &str) -> bool {
        self.previews.unsubscribe(subscription_id, client_session)
    }
    pub fn release_preview_client(&mut self, client_session: &str) {
        self.previews.release_client(client_session);
    }
    pub fn preview_state(&mut self, id: &str) -> EditorResult<PreviewState> {
        self.sync_preview(id);
        self.previews.state(id)
    }
    pub fn take_preview_task(&mut self, id: &str) -> EditorResult<Option<PreviewTask>> {
        self.preview_document(id)?;
        self.sync_preview(id);
        if !self.previews.contains(id) {
            return Ok(None);
        }
        let snapshot = self.record(id)?.buffer.snapshot();
        let mut task = self.previews.take_task(id, snapshot, self.backend.now_ms());
        if let Some(task) = &mut task {
            task.overlays = self
                .records
                .values()
                .filter(|record| {
                    !record.header.deleted && !preview::supports_preview(&record.header.path)
                })
                .map(|record| (record.header.path.clone(), record.buffer.snapshot().text))
                .collect();
            if task.overlays.values().map(String::len).sum::<usize>() > 32 * 1024 * 1024 {
                self.previews.complete(PreviewCompletion {
                    task_id: task.ticket.task_id.clone(),
                    outcome: PreviewOutcome::Failure {
                        message: "预览项目的未保存内容超过容量，请关闭部分文件。".into(),
                        diagnostics: vec![],
                    },
                });
                return Ok(None);
            }
        }
        Ok(task)
    }
    pub fn complete_preview(&mut self, completion: PreviewCompletion) -> bool {
        if let Some(id) = self.previews.document_for_task(&completion.task_id) {
            self.sync_preview(&id);
        }
        self.previews.complete(completion)
    }
    /// Platform must revoke/terminate its old executor before retrying. Already
    /// running synchronous Rust code cannot be interrupted by this method.
    pub fn retry_preview(&mut self, id: &str) -> EditorResult<PreviewState> {
        self.preview_document(id)?;
        self.sync_preview(id);
        self.previews.retry(id, self.backend.now_ms())?;
        self.previews.state(id)
    }
    pub fn take_preview_events(&mut self) -> Vec<PreviewEvent> {
        self.sync_preview_environment();
        self.previews.take_events()
    }
    pub fn invalidate_preview_project(&mut self) {
        self.previews.invalidate_project(self.backend.now_ms());
    }
    fn sync_preview_environment(&mut self) {
        let current = self
            .records
            .values()
            .filter(|record| {
                !record.header.deleted && !preview::supports_preview(&record.header.path)
            })
            .map(|record| (record.header.path.clone(), record.buffer.version()))
            .collect();
        if self.preview_environment != current {
            self.preview_environment = current;
            self.invalidate_preview_project();
        }
    }
    pub fn preview_link(
        &mut self,
        id: &str,
        task_id: &str,
        target: &str,
    ) -> EditorResult<PreviewLink> {
        let state = self.preview_state(id)?;
        if state.status != PreviewStatus::Ready || state.target.task_id != task_id {
            return Err(EditorError::new(
                "StaleVersion",
                "预览正在更新，请稍后再打开链接。",
                id,
            ));
        }
        resolve_preview_target(&state.target.path, target)
    }
    fn preview_document(&self, id: &str) -> EditorResult<()> {
        if self.record(id)?.header.deleted {
            return Err(EditorError::new("NotFound", "Document was deleted", id));
        }
        Ok(())
    }
    fn sync_preview(&mut self, id: &str) {
        self.sync_preview_environment();
        if !self.previews.contains(id) {
            return;
        }
        match self.records.get(id) {
            Some(record) if !record.header.deleted => self.previews.reconcile(
                id,
                &record.buffer.version(),
                &record.header.path,
                self.backend.now_ms(),
            ),
            _ => self.previews.close(id),
        }
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
        if self.record(id)?.read_only {
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
    pub fn read(&self, id: &str) -> EditorResult<EditorDocument> {
        let record = self.record(id)?;
        let header = &record.header;
        let snapshot = record.buffer.snapshot();
        let dirty = snapshot.text != header.saved_text;
        Ok(EditorDocument {
            external_change: record.observation.status(),
            id: id.into(),
            path: header.path.clone(),
            undo: record.buffer.undo_state(),
            writer_id: record.buffer.writer_id(),
            saved_content: header.saved_text.clone(),
            bom: header.bom,
            line_ending: header.line_ending.clone(),
            dirty,
            deleted: header.deleted,
            conflict: record.conflict,
            backend_revision: header.disk_revision.clone(),
            saved_version: header.saved_version.clone(),
            durable_version: record.durable.clone(),
            persistence_error: self.failure.clone(),
            error: record.error.clone(),
            autosave_delay: if dirty
                && (self.backend.has_projection() || record.hosted)
                && !record.read_only
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
    fn queue_packet(&mut self, id: &str, packet: SyncPacket) {
        let record = self.records.get_mut(id).unwrap();
        record.uncommitted.push(JournalEntry {
            packet,
            applied: record.buffer.version(),
        });
    }
    fn buffer_changed(&mut self, id: &str) {
        let record = self.records.get_mut(id).unwrap();
        if record.buffer.snapshot().text != record.header.saved_text && record.first_dirty.is_none()
        {
            record.first_dirty = Some(self.backend.now_ms());
        }
        self.sync_preview(id);
    }
    async fn persist(&mut self, id: &str) -> EditorResult<()> {
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
            record.durable = self
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
    /// Join an existing history in a private replica, without creating a file projection.
    /// The host supplies the logical path and full snapshot; never seed from plain text.
    pub async fn join(&mut self, path: &str, packet: SyncPacket) -> EditorResult<String> {
        self.join_with_writer(path, packet, None).await
    }
    pub async fn join_with_writer(
        &mut self,
        path: &str,
        packet: SyncPacket,
        writer: Option<u64>,
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
        let document = Buffer::from_snapshot(&packet, writer)?;
        let snapshot = document.snapshot();
        validate_text(&snapshot.text, path)?;
        let header = DocumentHeader {
            id: id.clone(),
            path: path.into(),
            seed: packet,
            sequence: 0,
            applied: snapshot.version,
            saved_text: snapshot.text,
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
                hosted: false,
                read_only: false,
                header,
                buffer: document,
                pending_observation: None,
                uncommitted: vec![],
                durable: None,
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
        let document = Buffer::new(identity.clone(), None, &text)?;
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
                hosted: false,
                read_only: false,
                header,
                buffer: document,
                uncommitted: vec![],
                pending_observation: None,
                durable: None,
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
        if record.buffer.snapshot().text != record.header.saved_text {
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
        record.durable = self
            .backend
            .persistent()
            .then(|| record.header.applied.clone());
        record.observation.queued = None;
        record.observation.failure = None;
        record.conflict = false;
        record.error = None;
        if record.buffer.snapshot().text == record.header.saved_text {
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
            // A durable Prepared record proves that this attempt had not started file IO.
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
        let mut external =
            Buffer::from_snapshot(&self.record(id)?.buffer.export_snapshot()?, None)?;
        let mut edit = Edit::replace(&external.snapshot(), &text);
        edit.origin = "filesystem".into();
        let external_update = external.apply(BufferCommand::Edit(edit))?;
        let cursor = self.cursor(id, external_update.after, disk.data)?;
        let update = if let Some(packet) = external_update.operation {
            let prepared = self.prepare_import(
                id,
                Import {
                    packet,
                    origin: "filesystem".into(),
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
            Some(
                self.records
                    .get_mut(id)
                    .unwrap()
                    .buffer
                    .apply(BufferCommand::ClearUndo)?,
            )
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
    /// One mutation contract for UI, headless callers and collaboration. Only
    /// admission errors are returned as Err; accepted text always has a receipt,
    /// including when committing its history fails.
    pub async fn apply(
        &mut self,
        id: &str,
        command: BufferCommand,
    ) -> EditorResult<Arc<EditorMutation>> {
        if let BufferCommand::Import(input) = command {
            let prepared = self.prepare_import(id, input)?;
            return self.commit_import(id, prepared).await;
        }
        self.live(id)?;
        if let BufferCommand::Edit(edit) = &command {
            let current = self.record(id)?.buffer.snapshot();
            if edit.base != current.version {
                return Err(CoreError::StaleVersion.into());
            }
            match &edit.input {
                TextInput::Text { text } => validate_text(text, id)?,
                TextInput::Edits { edits } => {
                    let mut size = current.text.len();
                    for change in edits {
                        validate_text(&change.insert, id)?;
                        let from = utf16_to_byte(&current.text, change.from)?;
                        let to = utf16_to_byte(&current.text, change.to)?;
                        size = size
                            .checked_sub(to.saturating_sub(from))
                            .and_then(|n| n.checked_add(change.insert.len()))
                            .ok_or_else(|| {
                                EditorError::new("InvalidEdit", "Invalid edit size", id)
                            })?;
                    }
                    if size > MAX_TEXT_BYTES {
                        return Err(EditorError::new("Unsupported", "Text exceeds 5 MiB", id));
                    }
                }
            }
        }
        let update = self.records.get_mut(id).unwrap().buffer.apply(command)?;
        self.accept_update(id, update, false).await
    }

    pub fn prepare_import(&self, id: &str, input: Import) -> EditorResult<PreparedImport> {
        if input.packet.data.len() > 16 * 1024 * 1024 {
            return Err(EditorError::new(
                "Unsupported",
                "CRDT packet exceeds 16 MiB",
                id,
            ));
        }
        let prepared = self.record(id)?.buffer.prepare_import(input)?;
        validate_text(&prepared.preview().text, id)?;
        Ok(prepared)
    }

    pub async fn commit_import(
        &mut self,
        id: &str,
        prepared: PreparedImport,
    ) -> EditorResult<Arc<EditorMutation>> {
        // A hosted replica can receive accepted history even while read-only or deleted.
        if self.record(id)?.hosted {
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

    async fn accept_update(
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

    fn publish_update(
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
                durable: self.backend.persistent(),
            },
            Err(error) => HistoryCommit::Failed { error },
        };
        let mutation = Arc::new(EditorMutation {
            document: self.read(id)?,
            update,
            history,
        });
        self.mutations.push(mutation.clone());
        Ok(mutation)
    }

    /// The owning runtime drains once after each command, including commands
    /// that report an IO error after accepting a filesystem update.
    pub fn take_mutations(&mut self) -> Vec<Arc<EditorMutation>> {
        std::mem::take(&mut self.mutations)
    }

    pub fn snapshot(&self, id: &str) -> EditorResult<SyncPacket> {
        Ok(self.record(id)?.buffer.export_snapshot()?)
    }
    pub fn updates(&self, id: &str, version: &Version) -> EditorResult<SyncPacket> {
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
                    other != id && !record.header.deleted && record.header.path == state.path
                }))
        {
            return Err(EditorError::new(
                "Conflict",
                "Host path belongs to another document",
                &state.path,
            ));
        }
        let version = self.record(id)?.buffer.version();
        if version.identity != state.version.identity
            || state.version.clocks.iter().any(|(writer, count)| {
                *count < 0 || version.clocks.get(writer).copied().unwrap_or(0) < *count
            })
            || !matches!(state.line_ending.as_str(), "\n" | "\r" | "\r\n")
        {
            return Err(EditorError::new(
                "Conflict",
                "Host receipt has an unseen or different history",
                id,
            ));
        }
        let record = self.records.get_mut(id).unwrap();
        record.hosted = true;
        record.read_only = state.read_only;
        record.header.path = state.path;
        record.header.saved_text = state.saved_content;
        record.header.disk_revision = state.backend_revision;
        record.header.bom = state.bom;
        record.header.line_ending = state.line_ending;
        record.header.deleted = state.deleted;
        record.observation.remote = state.external_change;
        record.conflict = state.conflict;
        record.error = state.error;
        if record.buffer.snapshot().text == record.header.saved_text {
            record.first_dirty = None;
        }
        self.persist(id).await?;
        self.sync_preview(id);
        Ok(())
    }
    /// Commit a client replica through the host's normal conditional save path.
    /// A file revision mismatch is detected before importing the client's edits.
    pub async fn commit_replica(
        &mut self,
        id: &str,
        packet: Option<SyncPacket>,
        expected_revision: &str,
        action: &str,
    ) -> EditorResult<()> {
        self.live(id)?;
        if !self.backend.has_projection() {
            return Err(EditorError::new(
                "Unsupported",
                "Replica commits require a host file projection",
                id,
            ));
        }
        if action == "discard" {
            let record = self.record(id)?;
            if record.buffer.snapshot().text != record.header.saved_text {
                return Err(EditorError::new(
                    "Conflict",
                    "Host has unsaved edits; resolve the host save before discarding the client draft",
                    &record.header.path,
                ));
            }
            return self.resolve(id, "discard").await;
        }
        if !matches!(action, "save" | "overwrite") {
            return Err(EditorError::new(
                "InvalidEdit",
                "Unknown replica commit action",
                id,
            ));
        }
        let packet =
            packet.ok_or_else(|| EditorError::new("InvalidEdit", "Missing client snapshot", id))?;
        if packet.data.len() > 16 * 1024 * 1024
            || packet.identity != *self.record(id)?.buffer.identity()
        {
            return Err(EditorError::new(
                "Conflict",
                "Invalid client snapshot identity or size",
                id,
            ));
        }
        let client = Buffer::from_snapshot(&packet, None)?;
        let client_text = client.snapshot().text;
        validate_text(&client_text, id)?;
        if action == "save" {
            let disk = self
                .backend
                .read_file(&self.record(id)?.header.path, Some(MAX_TEXT_BYTES as u64))
                .await?;
            if expected_revision.is_empty() || disk.revision != expected_revision {
                return Err(EditorError::new(
                    "Conflict",
                    "文件已被其他客户端或程序修改。",
                    &self.record(id)?.header.path,
                ));
            }
        }
        self.apply(id, BufferCommand::Import(Import::new(packet, "replica")))
            .await?
            .require_committed()?;
        if action == "overwrite" {
            // Explicit overwrite chooses exactly the client's text even if the
            // host has already adopted another writer's filesystem changes.
            let state = self.read(id)?.snapshot;
            let mut edit = Edit::replace(&state, &client_text);
            edit.origin = "input.overwrite".into();
            self.apply(id, BufferCommand::Edit(edit))
                .await?
                .require_committed()?;
            self.resolve(id, "overwrite").await
        } else {
            self.save(id, None).await
        }
    }
    pub async fn save(&mut self, id: &str, expected: Option<Version>) -> EditorResult<()> {
        let result = self.save_inner(id, expected).await;
        if let Err(error) = &result
            && let Some(record) = self.records.get_mut(id)
        {
            record.error = Some(error.message.clone());
            record.conflict = error.code == "Conflict";
        }
        result
    }
    async fn save_inner(&mut self, id: &str, expected: Option<Version>) -> EditorResult<()> {
        if self.failure.is_some() {
            self.retry_history().await?;
        }
        self.live(id)?;
        let record = self.record(id)?;
        if expected
            .as_ref()
            .is_some_and(|version| version != &record.buffer.version())
        {
            return Err(CoreError::StaleVersion.into());
        }
        if !self.backend.has_projection() {
            return self.persist(id).await;
        }
        let path = record.header.path.clone();
        let disk = self
            .backend
            .read_file(&path, Some(MAX_TEXT_BYTES as u64))
            .await?;
        if !self.recover_completed_write(id, &disk).await? {
            return Err(EditorError::new(
                "Conflict",
                "Uncertain file write requires recovery",
                &path,
            ));
        }
        if matches!(self.options.external_changes, ExternalChangePolicy::Merge) {
            self.merge_disk(id, disk.clone()).await?;
            self.require_observed(id)?;
        }
        let record = self.record(id)?;
        if disk.revision != record.header.disk_revision {
            self.records.get_mut(id).unwrap().conflict = true;
            return Err(EditorError::new(
                "Conflict",
                "文件已被其他客户端或程序修改。",
                &path,
            ));
        }
        // Reconciliation may have accepted a new version after the client's save request.
        if expected
            .as_ref()
            .is_some_and(|version| version != &record.buffer.version())
        {
            return Err(CoreError::StaleVersion.into());
        }
        let snapshot = record.buffer.snapshot();
        if snapshot.text == record.header.saved_text {
            let record = self.records.get_mut(id).unwrap();
            record.error = None;
            record.conflict = false;
            record.first_dirty = None;
            return Ok(());
        }
        let bytes = encode(&record.header, &snapshot.text);
        let baseline = record.header.disk_revision.clone();
        self.records.get_mut(id).unwrap().header.pending_write = Some(PendingWrite {
            text: snapshot.text.clone(),
            version: Some(snapshot.version.clone()),
            phase: WritePhase::Prepared,
            id: Some(self.backend.new_id()?),
            expected_revision: Some(baseline.clone()),
        });
        self.persist(id).await?;
        self.records
            .get_mut(id)
            .unwrap()
            .header
            .pending_write
            .as_mut()
            .unwrap()
            .phase = WritePhase::Started;
        if let Err(error) = self.persist(id).await {
            // In this running instance we know that write_file was never called.
            // A restart which only sees Started still must treat it as uncertain.
            self.records
                .get_mut(id)
                .unwrap()
                .header
                .pending_write
                .as_mut()
                .unwrap()
                .phase = WritePhase::Prepared;
            return Err(error);
        }
        let revision = match self
            .backend
            .write_file(&path, &bytes, "replace", Some(&baseline))
            .await
        {
            Ok(revision) => revision,
            Err(error) => {
                if error.write_not_started {
                    // A platform-specific failure proves that no projected bytes changed.
                    // Persist that proof before permitting another attempt or a restart.
                    self.records
                        .get_mut(id)
                        .unwrap()
                        .header
                        .pending_write
                        .as_mut()
                        .unwrap()
                        .phase = WritePhase::Prepared;
                    self.persist(id).await?;
                }
                let record = self.records.get_mut(id).unwrap();
                record.error = Some(error.message.clone());
                record.conflict = error.code == "Conflict";
                return Err(error);
            }
        };
        let mut header = self.record(id)?.header.clone();
        header.saved_text = snapshot.text;
        header.saved_version = Some(snapshot.version.clone());
        header.disk_revision = revision;
        header.pending_write = None;
        header.disk_cursor = self.cursor(id, snapshot.version, bytes)?;
        self.stage_observation(id, header, None, None).await
    }
    pub async fn resolve(&mut self, id: &str, action: &str) -> EditorResult<()> {
        if self.failure.is_some() {
            self.retry_history().await?;
        }
        self.live(id)?;
        let path = self.record(id)?.header.path.clone();
        let disk = self
            .backend
            .read_file(&path, Some(MAX_TEXT_BYTES as u64))
            .await?;
        if matches!(self.options.external_changes, ExternalChangePolicy::Merge)
            && !self.recover_completed_write(id, &disk).await?
        {
            return Err(EditorError::new(
                "Conflict",
                "Uncertain file write requires evidence-aware recovery",
                &path,
            ));
        }
        match action {
            "discard" => {
                let (text, bom, ending) = decode(&disk.data, &path)?;
                self.adopt_disk(id, (text, bom, ending), disk, true).await
            }
            "overwrite" => {
                if matches!(self.options.external_changes, ExternalChangePolicy::Merge) {
                    let desired = self.record(id)?.buffer.snapshot().text;
                    self.merge_disk(id, disk).await?;
                    self.require_observed(id)?;
                    let snapshot = self.record(id)?.buffer.snapshot();
                    let mut edit = Edit::replace(&snapshot, &desired);
                    edit.origin = "filesystem-overwrite".into();
                    self.apply(id, BufferCommand::Edit(edit))
                        .await?
                        .require_committed()?;
                } else {
                    self.records.get_mut(id).unwrap().header.disk_revision = disk.revision;
                }
                self.save(id, None).await
            }
            _ => Err(EditorError::new(
                "InvalidEdit",
                "Unknown conflict action",
                &path,
            )),
        }
    }
    pub fn before_replace(&self, path: &str) -> EditorResult<()> {
        self.writable()?;
        if self.records.values().any(|r| {
            !r.header.deleted
                && r.header.path == path
                && r.buffer.snapshot().text != r.header.saved_text
        }) {
            return Err(EditorError::new(
                "Conflict",
                "File has unsaved CRDT edits; use the document API",
                path,
            ));
        }
        Ok(())
    }
    async fn persist_headers(&mut self) -> EditorResult<()> {
        let ids: Vec<_> = self.records.keys().cloned().collect();
        for id in ids {
            self.persist(&id).await?;
        }
        Ok(())
    }
    async fn finish_directory(&mut self, intent: &DirectoryIntent) -> EditorResult<()> {
        for (id, path) in &intent.entries {
            if let Some(record) = self.records.get_mut(id) {
                if intent.operation == "rename" {
                    record.header.path = format!(
                        "{}{}",
                        intent.to.as_ref().unwrap(),
                        &path[intent.from.len()..]
                    );
                } else if self.backend.stat(path).await?.is_none() {
                    record.header.deleted = true;
                    record.first_dirty = None;
                }
            }
            self.sync_preview(id);
        }
        self.persist_headers().await?;
        self.backend.set_directory_intent(None).await
    }
    async fn recover_directory(&mut self) -> EditorResult<()> {
        let Some(intent) = self.backend.directory_intent().await? else {
            return Ok(());
        };
        validate_editor_path(&intent.from)?;
        for (_, path) in &intent.entries {
            validate_editor_path(path)?;
            if !within(path, &intent.from) {
                return Err(EditorError::new(
                    "IO",
                    "Invalid directory recovery intent",
                    path,
                ));
            }
        }
        if intent.operation == "remove" {
            return self.finish_directory(&intent).await;
        }
        if intent.operation != "rename" || intent.to.is_none() {
            return Err(EditorError::new(
                "IO",
                "Unknown directory recovery intent",
                &intent.from,
            ));
        }
        let to = intent.to.as_ref().unwrap();
        validate_editor_path(to)?;
        let source = self.backend.stat(&intent.from).await?;
        let target = self.backend.stat(to).await?;
        match (source, target) {
            (None, Some(_)) => self.finish_directory(&intent).await,
            (Some(_), None) => self.backend.set_directory_intent(None).await,
            _ => Err(EditorError::new(
                "Conflict",
                "上次移动未完成，源与目标状态存在歧义；文件与历史已保留。",
                &intent.from,
            )),
        }
    }
    pub async fn rename(&mut self, from: &str, to: &str) -> EditorResult<()> {
        self.writable()?;
        validate_editor_path(from)?;
        validate_editor_path(to)?;
        self.recover_directory().await?;
        if from == to && !from.is_empty() {
            return self.backend.rename(from, to).await;
        }
        if from.is_empty() || to.is_empty() || within(to, from) {
            return Err(EditorError::new(
                "InvalidPath",
                "Cannot move root or a directory into itself",
                from,
            ));
        }
        let intent = DirectoryIntent {
            operation: "rename".into(),
            from: from.into(),
            to: Some(to.into()),
            entries: self
                .records
                .values()
                .filter(|r| !r.header.deleted && within(&r.header.path, from))
                .map(|r| (r.header.id.clone(), r.header.path.clone()))
                .collect(),
        };
        self.backend.set_directory_intent(Some(&intent)).await?;
        if let Err(error) = self.backend.rename(from, to).await {
            if error
                .rename
                .as_ref()
                .is_some_and(|r| r.phase == "remove-source")
            {
                // Keep the complete target and its identity; retain the intent for
                // an explicit resolution of remaining source files on recovery.
                for (id, path) in &intent.entries {
                    self.records.get_mut(id).unwrap().header.path =
                        format!("{}{}", to, &path[from.len()..]);
                    self.sync_preview(id);
                }
                self.persist_headers().await?;
            } else if matches!(
                error.code.as_str(),
                "AlreadyExists" | "InvalidPath" | "Unsupported" | "NotFound"
            ) || (self.backend.stat(from).await?.is_some()
                && self.backend.stat(to).await?.is_none())
            {
                self.backend.set_directory_intent(None).await?;
            }
            return Err(error);
        }
        self.finish_directory(&intent).await
    }
    pub async fn remove(&mut self, path: &str, recursive: bool) -> EditorResult<()> {
        self.writable()?;
        validate_editor_path(path)?;
        self.recover_directory().await?;
        if path.is_empty() {
            return Err(EditorError::new(
                "InvalidPath",
                "Cannot remove Vault root",
                path,
            ));
        }
        let intent = DirectoryIntent {
            operation: "remove".into(),
            from: path.into(),
            to: None,
            entries: self
                .records
                .values()
                .filter(|r| !r.header.deleted && within(&r.header.path, path))
                .map(|r| (r.header.id.clone(), r.header.path.clone()))
                .collect(),
        };
        self.backend.set_directory_intent(Some(&intent)).await?;
        let result = self.backend.remove(path, recursive).await;
        self.finish_directory(&intent).await?;
        result
    }
    pub async fn flush(&mut self) -> EditorResult<()> {
        let ids: Vec<_> = self
            .records
            .values()
            .filter(|r| !r.header.deleted)
            .map(|r| r.header.id.clone())
            .collect();
        for id in ids {
            self.save(&id, None).await?;
        }
        Ok(())
    }
    pub async fn file_operation(
        &mut self,
        method: &str,
        params: serde_json::Value,
    ) -> EditorResult<serde_json::Value> {
        let path = params
            .get("path")
            .or_else(|| params.get("from"))
            .and_then(|p| p.as_str())
            .unwrap_or("");
        validate_editor_path(path)?;
        if matches!(method, "readFile" | "writeFile" | "rename" | "remove") {
            let ids: Vec<_> = self
                .records
                .values()
                .filter(|r| !r.header.deleted && within(&r.header.path, path))
                .map(|r| r.header.id.clone())
                .collect();
            for id in ids {
                self.save(&id, None).await?;
            }
        }
        let value = match method {
            "stat" => serde_json::to_value(self.backend.stat(path).await?),
            "readDir" => serde_json::to_value(self.backend.read_dir(path).await?),
            "readFile" => serde_json::to_value(self.backend.read_file(path, None).await?.data),
            "readFileSnapshot" => serde_json::to_value(self.backend.read_file(path, None).await?),
            "mkdir" => {
                self.backend
                    .mkdir(
                        path,
                        params["options"]["recursive"].as_bool().unwrap_or(false),
                    )
                    .await?;
                Ok(serde_json::Value::Null)
            }
            "writeFile" => {
                self.before_replace(path)?;
                let data: Vec<u8> = serde_json::from_value(params["data"].clone())
                    .map_err(|e| EditorError::new("InvalidEdit", e.to_string(), path))?;
                let revision = self
                    .backend
                    .write_file(
                        path,
                        &data,
                        params["options"]["mode"].as_str().unwrap_or("create"),
                        params["options"]["expectedRevision"].as_str(),
                    )
                    .await?;
                self.refresh_path(path).await?;
                Ok(serde_json::Value::String(revision))
            }
            "rename" => {
                self.rename(
                    path,
                    params["to"].as_str().ok_or_else(|| {
                        EditorError::new("InvalidPath", "Missing destination", path)
                    })?,
                )
                .await?;
                Ok(serde_json::Value::Null)
            }
            "remove" => {
                self.remove(
                    path,
                    params["options"]["recursive"].as_bool().unwrap_or(false),
                )
                .await?;
                Ok(serde_json::Value::Null)
            }
            _ => {
                return Err(EditorError::new(
                    "Unsupported",
                    "Unknown file operation",
                    path,
                ));
            }
        };
        value.map_err(|e| EditorError::new("IO", e.to_string(), path))
    }
    /// Same service commands over Worker, IPC, or a headless reference caller.
    pub async fn execute_service(
        &mut self,
        method: &str,
        params: serde_json::Value,
    ) -> EditorResult<serde_json::Value> {
        use serde_json::{Value, to_value};
        let id = params["id"].as_str().unwrap_or("");
        let value = match method {
            "preview_subscribe" => {
                let client = params["clientSession"].as_str().unwrap_or("");
                to_value(self.subscribe_preview(id, client)?)
            }
            "preview_unsubscribe" => to_value(self.unsubscribe_preview(
                params["subscriptionId"].as_str().unwrap_or(""),
                params["clientSession"].as_str().unwrap_or(""),
            )),
            "preview_state" => to_value(self.preview_state(id)?),
            "preview_release_client" => {
                self.release_preview_client(params["clientSession"].as_str().unwrap_or(""));
                Ok(Value::Null)
            }
            "preview_take_task" => to_value(self.take_preview_task(id)?),
            "preview_complete" => {
                let completion = serde_json::from_value(params["completion"].clone())
                    .map_err(|e| EditorError::new("InvalidPreview", e.to_string(), id))?;
                to_value(self.complete_preview(completion))
            }
            "preview_retry" => to_value(self.retry_preview(id)?),
            "preview_link" => to_value(self.preview_link(
                id,
                params["taskId"].as_str().unwrap_or(""),
                params["target"].as_str().unwrap_or(""),
            )?),
            "preview_events" => to_value(self.take_preview_events()),
            "preview_invalidate_project" => {
                self.invalidate_preview_project();
                to_value(())
            }
            "join" => {
                let path = params["path"]
                    .as_str()
                    .ok_or_else(|| EditorError::new("InvalidPath", "Missing file path", ""))?;
                let packet = serde_json::from_value(params["packet"].clone())
                    .map_err(|e| EditorError::new("InvalidEdit", e.to_string(), path))?;
                let writer = params["writerId"]
                    .as_str()
                    .map(str::parse::<u64>)
                    .transpose()
                    .map_err(|e| EditorError::new("InvalidEdit", e.to_string(), path))?;
                let id = self.join_with_writer(path, packet, writer).await?;
                to_value(self.read(&id)?)
            }
            "replica_session" => {
                let documents = serde_json::from_value(params["documents"].clone())
                    .map_err(|e| EditorError::new("InvalidEdit", e.to_string(), ""))?;
                self.replace_replica_session(documents).await?;
                to_value(self.resident()?)
            }
            "replica_join" => {
                let document = serde_json::from_value(params["document"].clone())
                    .map_err(|e| EditorError::new("InvalidEdit", e.to_string(), ""))?;
                let id = self.join_replica_document(document).await?;
                to_value(self.read(&id)?)
            }
            "replica_host_state" => {
                let state = serde_json::from_value(params["state"].clone())
                    .map_err(|e| EditorError::new("InvalidEdit", e.to_string(), id))?;
                self.apply_host_state(id, state).await?;
                to_value(self.read(id)?)
            }
            "export_snapshot" => to_value(self.snapshot(id)?),
            "export_updates" => {
                let version = serde_json::from_value(params["version"].clone())
                    .map_err(|e| EditorError::new("InvalidEdit", e.to_string(), id))?;
                to_value(self.updates(id, &version)?)
            }
            "apply" => {
                let command = serde_json::from_value(params["command"].clone())
                    .map_err(|e| EditorError::new("InvalidEdit", e.to_string(), id))?;
                self.apply(id, command).await?;
                // The mutation itself is delivered exactly once in the runtime's
                // mutation batch. The reply only identifies the target document.
                to_value(id)
            }
            "open" => {
                let path = params["path"]
                    .as_str()
                    .ok_or_else(|| EditorError::new("InvalidPath", "Missing file path", ""))?;
                let id = self.open_file(path).await?;
                to_value(self.read(&id)?)
            }
            "read" => to_value(self.read(id)?),
            "resident" => to_value(self.resident()?),
            "observe_files" => {
                let ids: Vec<String> = serde_json::from_value(params["ids"].clone())
                    .map_err(|e| EditorError::new("InvalidEdit", e.to_string(), ""))?;
                let mut documents = vec![];
                for id in ids {
                    if let Err(error) = self.refresh(&id).await {
                        if let Some(record) = self.records.get_mut(&id) {
                            record.error = Some(error.message);
                        }
                    }
                    documents.push(self.read(&id)?);
                }
                to_value(documents)
            }
            "save" => {
                let _ = self.save(id, None).await;
                to_value(self.read(id)?)
            }
            "retry_observation" => {
                self.retry_file_observation(id).await?;
                to_value(self.read(id)?)
            }
            "retry_history" => {
                self.retry_history().await?;
                to_value(self.read(id)?)
            }
            "resolve" => {
                self.resolve(id, params["action"].as_str().unwrap_or(""))
                    .await?;
                to_value(self.read(id)?)
            }
            "flush" => {
                self.flush().await?;
                Ok(Value::Null)
            }
            "flush_history" | "close" => {
                self.retry_history().await?;
                if method == "close" {
                    self.previews.clear();
                }
                Ok(Value::Null)
            }
            "file" => {
                let method = params["method"].as_str().unwrap_or("").to_string();
                return self.file_operation(&method, params).await;
            }
            _ => {
                return Err(EditorError::new(
                    "Unsupported",
                    "Unknown editor service operation",
                    "",
                ));
            }
        };
        value.map_err(|e| EditorError::new("IO", e.to_string(), ""))
    }
}
