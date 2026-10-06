//! Shared editor business: platform adapters implement IO, never save/recovery policy.
use crate::{backend::*, *};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

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
    document: Document,
    pending_packets: Vec<SyncPacket>,
    pending_observation: Option<ObservationCommit>,
    uncommitted: Vec<JournalEntry>,
    durable: Option<Version>,
    conflict: bool,
    error: Option<String>,
    last_group: String,
    last_edit: u64,
    first_dirty: Option<u64>,
}

#[derive(Clone)]
struct ObservationCommit {
    header: DocumentHeader,
    entry: Option<JournalEntry>,
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
#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectionContext {
    pub ranges: Vec<SelectionRange>,
    pub main_index: usize,
}
#[derive(Deserialize, Serialize)]
pub struct SelectionRange {
    pub anchor: usize,
    pub head: usize,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorEditResult {
    pub document: EditorDocument,
    pub edits: Vec<TextEdit>,
    pub restored_selection: Option<SelectionContext>,
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
            let mut document = Document::from_snapshot(&header.seed, None)?;
            let mut pending_packets = vec![];
            for entry in journal {
                let result = document.import(&entry.packet, "recovery".into())?;
                if result.pending {
                    pending_packets.push(entry.packet);
                }
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
                    document,
                    pending_packets,
                    pending_observation: None,
                    uncommitted: vec![],
                    durable,
                    conflict: false,
                    error: None,
                    last_group: String::new(),
                    last_edit: 0,
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
        let snapshot = record.document.snapshot();
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
        let snapshot = self.record(id)?.document.snapshot();
        let mut task = self.previews.take_task(id, snapshot, self.backend.now_ms());
        if let Some(task) = &mut task {
            task.overlays = self
                .records
                .values()
                .filter(|record| {
                    !record.header.deleted && !preview::supports_preview(&record.header.path)
                })
                .map(|record| (record.header.path.clone(), record.document.snapshot().text))
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
            .map(|record| (record.header.path.clone(), record.document.version()))
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
                &record.document.version(),
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
        let snapshot = record.document.snapshot();
        let dirty = snapshot.text != header.saved_text;
        Ok(EditorDocument {
            external_change: record.observation.status(),
            id: id.into(),
            path: header.path.clone(),
            undo: record.document.undo_state(),
            writer_id: record.document.writer_id(),
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
            applied: record.document.version(),
        });
        if record.document.snapshot().text != record.header.saved_text
            && record.first_dirty.is_none()
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
            if record.header.path != path || record.document.identity() != &packet.identity {
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
        let document = Document::from_snapshot(&packet, writer)?;
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
                document,
                pending_packets: vec![],
                pending_observation: None,
                uncommitted: vec![],
                durable: None,
                conflict: false,
                error: None,
                last_group: String::new(),
                last_edit: 0,
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
        let document = Document::new(identity.clone(), None, &text)?;
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
                document,
                uncommitted: vec![],
                pending_packets: vec![],
                pending_observation: None,
                durable: None,
                conflict: false,
                error: None,
                last_group: String::new(),
                last_edit: 0,
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

    /// Best-effort full observation. One unreadable/invalid file must not starve
    /// unrelated documents. A history failure freezes the instance until explicit retry.
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
        let mut known_paths: std::collections::BTreeSet<_> = self
            .records
            .values()
            .filter(|record| !record.header.deleted)
            .map(|record| record.header.path.clone())
            .collect();
        let mut directories = vec![String::new()];
        while let Some(directory) = directories.pop() {
            let entries = match self.backend.read_dir(&directory).await {
                Ok(entries) => entries,
                Err(error) => {
                    errors.push(error);
                    continue;
                }
            };
            for entry in entries {
                if entry.kind == "directory" {
                    directories.push(entry.path);
                } else if entry.kind == "file" && known_paths.insert(entry.path.clone()) {
                    match self.open_file(&entry.path).await {
                        Ok(_) => {}
                        Err(error) if matches!(error.code.as_str(), "Unsupported" | "NotFound") => {
                        }
                        Err(error) => errors.push(error),
                    }
                    if self.failure.is_some() {
                        return errors;
                    }
                }
            }
        }
        errors
    }

    pub async fn list(&mut self) -> EditorResult<Vec<EditorDocument>> {
        let mut pending = vec![String::new()];
        while let Some(directory) = pending.pop() {
            for entry in self.backend.read_dir(&directory).await? {
                if entry.kind == "directory" {
                    pending.push(entry.path);
                } else if entry.kind == "file" {
                    match self.open_file(&entry.path).await {
                        Ok(_) => {}
                        Err(error) if matches!(error.code.as_str(), "Unsupported" | "NotFound") => {
                        }
                        Err(error) => return Err(error),
                    }
                }
            }
        }
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
        if record.document.snapshot().text != record.header.saved_text {
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

    /// Commit a previously validated candidate before importing into the live Document.
    /// Retrying uses the exact same header and packet even when the receipt was lost.
    async fn finish_observation(&mut self, id: &str) -> EditorResult<()> {
        let Some(candidate) = self.record(id)?.pending_observation.clone() else {
            return Ok(());
        };
        if let Err(error) = self
            .backend
            .commit(&candidate.header, candidate.entry.as_ref())
            .await
        {
            self.failure = Some(format!("文件协调尚未持久化：{}", error.message));
            return Err(error);
        }
        if let Some(entry) = &candidate.entry {
            let result = self
                .records
                .get_mut(id)
                .unwrap()
                .document
                .import(&entry.packet, "filesystem".into());
            if result.is_err() || self.record(id)?.document.version() != candidate.header.applied {
                self.requires_reopen = true;
                self.failure = Some("文件协调已提交，但活动 core 未能应用；必须重新打开。".into());
                return Err(EditorError::new("IO", self.failure.clone().unwrap(), id));
            }
        }
        let record = self.records.get_mut(id).unwrap();
        record.header = candidate.header;
        record.durable = self
            .backend
            .persistent()
            .then(|| record.header.applied.clone());
        record.pending_observation = None;
        record.observation.queued = None;
        record.observation.failure = None;
        record.conflict = false;
        record.error = None;
        if record.document.snapshot().text == record.header.saved_text {
            record.first_dirty = None;
        } else if record.first_dirty.is_none() {
            record.first_dirty = Some(self.backend.now_ms());
        }
        if let Some(entry) = candidate.entry {
            // Reuse the existing accepted-change notification path (including previews).
            // This entry has already been committed; do not enqueue a second journal write.
            self.queue_packet(id, entry.packet);
            self.records.get_mut(id).unwrap().uncommitted.pop();
        }
        Ok(())
    }

    async fn stage_observation(
        &mut self,
        id: &str,
        header: DocumentHeader,
        entry: Option<JournalEntry>,
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
        self.records.get_mut(id).unwrap().pending_observation =
            Some(ObservationCommit { header, entry });
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
            self.stage_observation(id, header, None).await?;
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
        decoded: (String, bool, String),
        disk: FileSnapshot,
        clear_undo: bool,
    ) -> EditorResult<()> {
        let (text, bom, ending) = decoded;
        let revision = disk.revision;
        let bytes = disk.data;
        let record = self.record(id)?;
        let before = record.document.version();
        let mut external = Document::from_snapshot(&record.document.export_snapshot()?, None)?;
        external.transact(Transaction {
            expected_version: external.version(),
            origin: "filesystem".into(),
            edits: text_difference(&external.snapshot().text, &text),
            undo_metadata: None,
            undo_positions: vec![],
        })?;
        let packet = external.export_updates_since(&before)?;
        let cursor = self.cursor(id, external.version(), bytes)?;
        let record = self.records.get_mut(id).unwrap();
        record.document.import(&packet, "filesystem".into())?;
        if clear_undo {
            record.document.end_undo_group();
            record.document.clear_undo();
            record.last_group.clear();
        }
        record.header.saved_text = text;
        record.header.saved_version = Some(record.document.version());
        record.header.disk_revision = revision;
        record.header.bom = bom;
        record.header.line_ending = ending;
        record.header.pending_write = None;
        record.header.disk_cursor = cursor;
        record.conflict = false;
        record.error = None;
        record.first_dirty = None;
        self.queue_packet(id, packet);
        self.persist(id).await
    }
    fn apply_transaction(
        &mut self,
        id: &str,
        transaction: Transaction,
    ) -> EditorResult<Option<ChangeEvent>> {
        self.live(id)?;
        let record = self.record(id)?;
        let before = record.document.version();
        if transaction.expected_version != before {
            return Err(CoreError::StaleVersion.into());
        }
        let text = record.document.snapshot().text;
        let mut size = text.len();
        for edit in &transaction.edits {
            validate_text(&edit.insert, id)?;
            let from = utf16_to_byte(&text, edit.from)?;
            let to = utf16_to_byte(&text, edit.to)?;
            size = size
                .checked_sub(to.saturating_sub(from))
                .and_then(|n| n.checked_add(edit.insert.len()))
                .ok_or_else(|| EditorError::new("InvalidEdit", "Invalid edit size", id))?;
        }
        if size > MAX_TEXT_BYTES {
            return Err(EditorError::new("Unsupported", "Text exceeds 5 MiB", id));
        }
        let record = self.records.get_mut(id).unwrap();
        let event = record.document.transact(transaction)?;
        if record.document.version() != before {
            let packet = record.document.export_updates_since(&before)?;
            self.queue_packet(id, packet);
        }
        Ok(event)
    }
    pub async fn transact(
        &mut self,
        id: &str,
        transaction: Transaction,
    ) -> EditorResult<Option<ChangeEvent>> {
        let event = self.apply_transaction(id, transaction)?;
        if !self.record(id)?.uncommitted.is_empty() {
            self.persist(id).await?;
        }
        Ok(event)
    }
    pub async fn edit(
        &mut self,
        id: &str,
        version: Version,
        edits: Vec<TextEdit>,
        context: SelectionContext,
        user_event: String,
    ) -> EditorResult<EditorEditResult> {
        self.live(id)?;
        let now = self.backend.now_ms();
        let vim_group = user_event.starts_with("input.vim.");
        let group = if vim_group
            || user_event.starts_with("input.type")
            || user_event.starts_with("delete.")
        {
            user_event.clone()
        } else {
            String::new()
        };
        let record = self.records.get_mut(id).unwrap();
        if group.is_empty()
            || group != record.last_group
            || (!vim_group && now.saturating_sub(record.last_edit) > 500)
        {
            record.document.end_undo_group();
            if !group.is_empty() {
                record.document.begin_undo_group()?;
            }
        }
        let event = self.apply_transaction(
            id,
            Transaction {
                expected_version: version,
                edits,
                origin: user_event,
                undo_metadata: Some(serde_json::json!({"mainIndex":context.main_index})),
                undo_positions: context
                    .ranges
                    .iter()
                    .flat_map(|r| [r.anchor, r.head])
                    .collect(),
            },
        )?;
        let record = self.records.get_mut(id).unwrap();
        record.last_group = group;
        record.last_edit = now;
        // Return accepted text even if IO failed; the UI must retain the draft.
        if !record.uncommitted.is_empty() {
            let _ = self.persist(id).await;
        }
        Ok(EditorEditResult {
            document: self.read(id)?,
            edits: event.map_or(vec![], |e| e.edits),
            restored_selection: None,
        })
    }
    pub async fn import(&mut self, id: &str, packet: SyncPacket) -> EditorResult<ImportResult> {
        // Hosted replicas must still receive accepted history while their UI
        // is read-only (including retained tombstones). Local writes remain gated.
        if self.record(id)?.hosted {
            self.writable()?;
        } else {
            self.live(id)?;
        }
        if packet.data.len() > 16 * 1024 * 1024 {
            return Err(EditorError::new(
                "Unsupported",
                "CRDT packet exceeds 16 MiB",
                id,
            ));
        }
        let record = self.record(id)?;
        let mut trial = Document::from_snapshot(&record.document.export_snapshot()?, None)?;
        for waiting in &record.pending_packets {
            trial.import(waiting, "validation".into())?;
        }
        trial.import(&packet, "validation".into())?;
        validate_text(&trial.snapshot().text, id)?;
        let record = self.records.get_mut(id).unwrap();
        let result = record.document.import(&packet, "peer".into())?;
        if result.pending {
            record.pending_packets.push(packet.clone());
        }
        self.queue_packet(id, packet);
        self.persist(id).await?;
        Ok(result)
    }
    fn apply_undo(
        &mut self,
        id: &str,
        context: UndoContext,
        redo: bool,
    ) -> EditorResult<Option<ChangeEvent>> {
        self.live(id)?;
        let record = self.records.get_mut(id).unwrap();
        record.document.end_undo_group();
        record.last_group.clear();
        let before = record.document.version();
        let event = if redo {
            record.document.redo_with_context(context)?
        } else {
            record.document.undo_with_context(context)?
        };
        if record.document.version() != before {
            let packet = record.document.export_updates_since(&before)?;
            self.queue_packet(id, packet);
        }
        Ok(event)
    }
    pub async fn undo(
        &mut self,
        id: &str,
        context: UndoContext,
        redo: bool,
    ) -> EditorResult<Option<ChangeEvent>> {
        let event = self.apply_undo(id, context, redo)?;
        if !self.record(id)?.uncommitted.is_empty() {
            self.persist(id).await?;
        }
        Ok(event)
    }
    pub async fn undo_view(
        &mut self,
        id: &str,
        context: SelectionContext,
        redo: bool,
    ) -> EditorResult<EditorEditResult> {
        let event = self.apply_undo(
            id,
            UndoContext {
                metadata: Some(serde_json::json!({"mainIndex":context.main_index})),
                positions: context
                    .ranges
                    .iter()
                    .flat_map(|r| [r.anchor, r.head])
                    .collect(),
            },
            redo,
        )?;
        if !self.record(id)?.uncommitted.is_empty() {
            let _ = self.persist(id).await;
        }
        let selection = event.as_ref().and_then(|e| {
            let ranges: Vec<_> = e
                .restored_positions
                .as_chunks::<2>()
                .0
                .iter()
                .map(|p| SelectionRange {
                    anchor: p[0],
                    head: p[1],
                })
                .collect();
            (!ranges.is_empty()).then(|| SelectionContext {
                ranges,
                main_index: e
                    .restored_metadata
                    .as_ref()
                    .and_then(|m| m.get("mainIndex"))
                    .and_then(|m| m.as_u64())
                    .unwrap_or(0) as usize,
            })
        });
        Ok(EditorEditResult {
            document: self.read(id)?,
            edits: event.map_or(vec![], |e| e.edits),
            restored_selection: selection,
        })
    }
    pub fn snapshot(&self, id: &str) -> EditorResult<SyncPacket> {
        Ok(self.record(id)?.document.export_snapshot()?)
    }
    pub fn updates(&self, id: &str, version: &Version) -> EditorResult<SyncPacket> {
        Ok(self.record(id)?.document.export_updates_since(version)?)
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
        let version = self.record(id)?.document.version();
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
        if record.document.snapshot().text == record.header.saved_text {
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
            if record.document.snapshot().text != record.header.saved_text {
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
            || packet.identity != *self.record(id)?.document.identity()
        {
            return Err(EditorError::new(
                "Conflict",
                "Invalid client snapshot identity or size",
                id,
            ));
        }
        let client = Document::from_snapshot(&packet, None)?;
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
        self.import(id, packet).await?;
        if action == "overwrite" {
            // Explicit overwrite chooses exactly the client's text even if the
            // host has already adopted another writer's filesystem changes.
            let state = self.read(id)?.snapshot;
            self.edit(
                id,
                state.version,
                text_difference(&state.text, &client_text),
                SelectionContext::default(),
                "input.overwrite".into(),
            )
            .await?;
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
            .is_some_and(|version| version != &record.document.version())
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
            .is_some_and(|version| version != &record.document.version())
        {
            return Err(CoreError::StaleVersion.into());
        }
        let snapshot = record.document.snapshot();
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
        self.stage_observation(id, header, None).await
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
                    let desired = self.record(id)?.document.snapshot().text;
                    self.merge_disk(id, disk).await?;
                    self.require_observed(id)?;
                    let snapshot = self.record(id)?.document.snapshot();
                    self.transact(
                        id,
                        Transaction {
                            expected_version: snapshot.version,
                            edits: text_difference(&snapshot.text, &desired),
                            origin: "filesystem-overwrite".into(),
                            undo_metadata: None,
                            undo_positions: vec![],
                        },
                    )
                    .await?;
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
                && r.document.snapshot().text != r.header.saved_text
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
            "import" => {
                let packet = serde_json::from_value(params["packet"].clone())
                    .map_err(|e| EditorError::new("InvalidEdit", e.to_string(), id))?;
                let result = self.import(id, packet).await?;
                to_value(serde_json::json!({"result":result,"document":self.read(id)?}))
            }
            "replace_text" => {
                let text = params["text"]
                    .as_str()
                    .ok_or_else(|| EditorError::new("InvalidEdit", "Missing text", id))?;
                let version = serde_json::from_value(params["version"].clone())
                    .map_err(|e| EditorError::new("InvalidEdit", e.to_string(), id))?;
                let edits = text_difference(&self.read(id)?.snapshot.text, text);
                to_value(
                    self.edit(
                        id,
                        version,
                        edits,
                        SelectionContext::default(),
                        "input.replace".into(),
                    )
                    .await?,
                )
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
            "text_changes" => {
                let before = params["before"]
                    .as_str()
                    .ok_or_else(|| EditorError::new("InvalidEdit", "Missing previous text", ""))?;
                let after = params["after"]
                    .as_str()
                    .ok_or_else(|| EditorError::new("InvalidEdit", "Missing current text", ""))?;
                to_value(text_difference(before, after))
            }
            "edit" => {
                #[derive(Deserialize)]
                #[serde(rename_all = "camelCase")]
                struct Edit {
                    id: String,
                    version: Version,
                    edits: Vec<TextEdit>,
                    context: SelectionContext,
                    user_event: String,
                }
                let p: Edit = serde_json::from_value(params)
                    .map_err(|e| EditorError::new("InvalidEdit", e.to_string(), ""))?;
                to_value(
                    self.edit(&p.id, p.version, p.edits, p.context, p.user_event)
                        .await?,
                )
            }
            "undo" => {
                let context = serde_json::from_value(params["context"].clone())
                    .map_err(|e| EditorError::new("InvalidEdit", e.to_string(), id))?;
                to_value(
                    self.undo_view(id, context, params["redo"].as_bool().unwrap_or(false))
                        .await?,
                )
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
