//! Filesystem observation coordination. The platform executes detached work;
//! this module alone validates its baseline and commits it into current history.
use super::*;
use crate::buffer::filesystem::{DIFF_BUDGET, FilesystemChange};
use std::time::Duration;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "phase",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ExternalChangeStatus {
    Pending,
    Failed {
        code: String,
        message: String,
        retry_at: u64,
    },
}

#[derive(Clone, PartialEq, Eq)]
struct ObservationToken {
    task_id: String,
    id: String,
    identity: DocumentIdentity,
    path: String,
    baseline_revision: String,
    baseline_version: Version,
    observation: Option<u64>,
    revision: String,
}
impl ObservationToken {
    fn applies_to(&self, record: &Record) -> bool {
        !record.header.deleted
            && record.header.pending_write.is_none()
            && self.identity == *record.buffer.identity()
            && self.path == record.header.path
            && self.baseline_revision == record.header.disk_revision
            && Some(&self.baseline_version) == baseline(record)
            && self.observation == record.header.disk_cursor.as_ref().map(|c| c.observation)
    }
}

#[derive(Clone)]
pub(super) struct ObservationFailure {
    token: ObservationToken,
    error: EditorError,
    attempts: u32,
    retry_at: u64,
}

#[derive(Default)]
pub(super) struct ObservationCoordinator {
    active: Option<ObservationToken>,
    pub(super) queued: Option<FileSnapshot>,
    pub(super) failure: Option<ObservationFailure>,
    pub(super) remote: Option<ExternalChangeStatus>,
}
impl ObservationCoordinator {
    pub(super) fn status(&self) -> Option<ExternalChangeStatus> {
        if self.active.is_some() || self.queued.is_some() {
            Some(ExternalChangeStatus::Pending)
        } else if let Some(failure) = &self.failure {
            Some(ExternalChangeStatus::Failed {
                code: failure.error.code.clone(),
                message: failure.error.message.clone(),
                retry_at: failure.retry_at,
            })
        } else {
            self.remote.clone()
        }
    }
}

/// Owns an isolated Buffer branch, never the live editor, backend or undo session.
/// Safe to execute on a worker.
pub struct FileObservationTask {
    token: ObservationToken,
    disk: FileSnapshot,
    change: FilesystemChange,
    decoded: (String, bool, String),
}
pub struct FileObservationResult {
    token: ObservationToken,
    disk: FileSnapshot,
    decoded: (String, bool, String),
    result: EditorResult<(Option<SyncPacket>, Version)>,
}
impl FileObservationTask {
    pub fn path(&self) -> &str {
        &self.token.path
    }
    pub fn compute(self) -> FileObservationResult {
        self.compute_with_budget(DIFF_BUDGET)
    }
    /// An explicit budget changes rejection only. It never changes the accepted algorithm.
    pub fn compute_with_budget(self, budget: Duration) -> FileObservationResult {
        let result = self
            .change
            .compute(&self.decoded.0, budget)
            .map_err(|error| {
                let mut error = EditorError::from(error);
                error.path = self.token.path.clone();
                error
            });
        FileObservationResult {
            token: self.token,
            disk: self.disk,
            decoded: self.decoded,
            result,
        }
    }
}

fn baseline(record: &Record) -> Option<&Version> {
    record
        .header
        .disk_cursor
        .as_ref()
        .map(|c| &c.version)
        .or(record.header.saved_version.as_ref())
}

impl<B: Backend> EditorCore<B> {
    pub fn has_file_observations(&self) -> bool {
        self.failure.is_none()
            && self.records.values().any(|r| {
                !r.header.deleted
                    && r.observation.active.is_none()
                    && r.observation.queued.is_some()
            })
    }

    /// Take at most one task for each document. New disk hints coalesce while it runs.
    pub fn take_file_observation(&mut self) -> EditorResult<Option<FileObservationTask>> {
        if self.failure.is_some() {
            return Ok(None);
        }
        let ready = |record: &Record| {
            !record.header.deleted
                && record.observation.active.is_none()
                && record.observation.queued.is_some()
        };
        let id = self
            .records
            .iter()
            .find(|(id, record)| {
                self.file_observation_cursor
                    .as_ref()
                    .is_none_or(|last| *id > last)
                    && ready(record)
            })
            .or_else(|| self.records.iter().find(|(_, record)| ready(record)))
            .map(|(id, _)| id.clone());
        self.file_observation_cursor = id.clone();
        match id {
            Some(id) => self.take_observation(&id),
            None => Ok(None),
        }
    }

    fn take_observation(&mut self, id: &str) -> EditorResult<Option<FileObservationTask>> {
        let record = self.record(id)?;
        if record.observation.active.is_some() {
            return Ok(None);
        }
        let Some(disk) = record.observation.queued.clone() else {
            return Ok(None);
        };
        let base = baseline(record).ok_or_else(|| {
            EditorError::new(
                "Conflict",
                "Missing historical disk baseline",
                &record.header.path,
            )
        })?;
        let token = ObservationToken {
            task_id: self.backend.new_id()?,
            id: id.into(),
            identity: record.buffer.identity().clone(),
            path: record.header.path.clone(),
            baseline_revision: record.header.disk_revision.clone(),
            baseline_version: base.clone(),
            observation: record.header.disk_cursor.as_ref().map(|c| c.observation),
            revision: disk.revision.clone(),
        };
        let change = match record
            .buffer
            .prepare_filesystem_change(base, &record.header.saved_text)
        {
            Ok(change) => change,
            Err(error) => {
                let mut error = EditorError::from(error);
                error.path = token.path.clone();
                self.fail_observation(token, error.clone());
                return Err(error);
            }
        };
        let decoded = decode(&disk.data, &token.path)?;
        let state = &mut self.records.get_mut(id).unwrap().observation;
        state.queued = None;
        state.active = Some(token.clone());
        Ok(Some(FileObservationTask {
            token,
            disk,
            change,
            decoded,
        }))
    }

    /// Reread disk and validate the task token before importing into latest CRDT history.
    /// Concurrent core edits are allowed; a changed physical cursor invalidates the task.
    pub async fn complete_file_observation(
        &mut self,
        result: FileObservationResult,
    ) -> EditorResult<bool> {
        let id = &result.token.id;
        let Some(record) = self.records.get(id) else {
            return Ok(false);
        };
        if record.observation.active.as_ref() != Some(&result.token) {
            return Ok(false);
        }
        let applicable = result.token.applies_to(record) && self.failure.is_none();
        self.records.get_mut(id).unwrap().observation.active = None;
        if !applicable {
            self.records.get_mut(id).unwrap().observation.queued = None;
            if self.failure.is_none() && !self.record(id)?.header.deleted {
                // A new cursor/path may already have newer disk hints. Re-read
                // at that baseline rather than waiting for another watcher event.
                self.refresh_disk(id).await?;
            }
            return Ok(false);
        }
        let disk = match self
            .backend
            .read_file(&result.token.path, Some(MAX_TEXT_BYTES as u64))
            .await
        {
            Ok(disk) => disk,
            Err(error) => {
                self.fail_observation(result.token, error.clone());
                return Err(error);
            }
        };
        if disk.revision != result.token.revision {
            // Ignore even the error from a superseded task. Requeue current bytes.
            self.queue_disk_observation(id, disk).await?;
            return Ok(false);
        }
        self.records.get_mut(id).unwrap().observation.queued = None;
        let (packet, version) = match result.result {
            Ok(value) => value,
            Err(error) => {
                self.fail_observation(result.token, error.clone());
                return Err(error);
            }
        };
        if let Err(mut error) = self
            .commit_disk_change(id, result.disk, result.decoded, packet, version)
            .await
        {
            if error.path.is_empty() {
                error.path = result.token.path.clone();
            }
            if self.failure.is_none() {
                self.fail_observation(result.token, error.clone());
            }
            return Err(error);
        }
        Ok(true)
    }

    fn fail_observation(&mut self, token: ObservationToken, error: EditorError) {
        let now = self.backend.now_ms();
        let state = &mut self.records.get_mut(&token.id).unwrap().observation;
        let attempts = state
            .failure
            .as_ref()
            .filter(|old| {
                old.token.revision == token.revision
                    && old.token.baseline_version == token.baseline_version
                    && old.token.path == token.path
                    && old.token.observation == token.observation
            })
            .map_or(1, |old| old.attempts.saturating_add(1));
        let delay = (30_000_u64 * (1_u64 << attempts.saturating_sub(1).min(4))).min(300_000);
        state.queued = None;
        state.failure = Some(ObservationFailure {
            token,
            error,
            attempts,
            retry_at: now.saturating_add(delay),
        });
    }

    /// Explicit retry bypasses the backoff, but never starts a second task for one document.
    pub async fn retry_file_observation(&mut self, id: &str) -> EditorResult<()> {
        if let Some(failure) = &mut self
            .records
            .get_mut(id)
            .ok_or_else(|| EditorError::new("NotFound", "Document not found", id))?
            .observation
            .failure
        {
            failure.retry_at = 0;
        }
        self.refresh(id).await
    }

    pub(super) fn require_observed(&self, id: &str) -> EditorResult<()> {
        let record = self.record(id)?;
        if record.observation.active.is_some() || record.observation.queued.is_some() {
            return Err(EditorError::new(
                "FilesystemReconciliationPending",
                "外部修改尚未同步，完成后再保存。",
                &record.header.path,
            ));
        }
        if let Some(failure) = &record.observation.failure {
            return Err(failure.error.clone());
        }
        Ok(())
    }

    pub(super) async fn merge_disk(&mut self, id: &str, disk: FileSnapshot) -> EditorResult<()> {
        self.queue_disk_observation(id, disk).await?;
        self.compute_inline_observation(id).await
    }

    pub(super) async fn compute_inline_observation(&mut self, id: &str) -> EditorResult<()> {
        if !self.options.defer_filesystem_diff
            && self.failure.is_none()
            && !self.record(id)?.header.deleted
        {
            if let Some(task) = self.take_observation(id)? {
                self.complete_file_observation(task.compute()).await?;
            }
        }
        Ok(())
    }

    pub(super) async fn queue_disk_observation(
        &mut self,
        id: &str,
        disk: FileSnapshot,
    ) -> EditorResult<()> {
        let record = self.record(id)?;
        if disk.revision == record.header.disk_revision && record.header.disk_cursor.is_some() {
            let record = self.records.get_mut(id).unwrap();
            record.conflict = false;
            record.error = None;
            record.observation.queued = None;
            record.observation.failure = None;
            return Ok(());
        }
        let decoded = match decode(&disk.data, &record.header.path) {
            Ok(value) => value,
            Err(error) => {
                let record = self.records.get_mut(id).unwrap();
                record.conflict = true;
                record.error = Some(error.message.clone());
                record.observation.queued = None;
                record.observation.failure = None;
                return Err(error);
            }
        };
        let record = self.record(id)?;
        let base = baseline(record).ok_or_else(|| {
            EditorError::new(
                "Conflict",
                "Missing historical disk baseline",
                &record.header.path,
            )
        })?;
        if decoded.0 == record.header.saved_text {
            if record.buffer.historical_text(base)? != decoded.0 {
                return Err(EditorError::new(
                    "IO",
                    "Historical disk baseline text mismatch",
                    &record.header.path,
                ));
            }
            return self
                .commit_disk_change(id, disk, decoded, None, base.clone())
                .await;
        }
        if let Some(failure) = &record.observation.failure
            && failure.token.applies_to(record)
            && failure.token.revision == disk.revision
            && self.backend.now_ms() < failure.retry_at
        {
            return Ok(());
        }
        let state = &mut self.records.get_mut(id).unwrap().observation;
        if state
            .active
            .as_ref()
            .is_some_and(|active| active.revision == disk.revision)
        {
            state.queued = None;
            return Ok(());
        }
        state.queued = Some(disk);
        Ok(())
    }

    async fn commit_disk_change(
        &mut self,
        id: &str,
        disk: FileSnapshot,
        decoded: (String, bool, String),
        packet: Option<SyncPacket>,
        disk_version: Version,
    ) -> EditorResult<()> {
        let record = self.record(id)?;
        let mut header = record.header.clone();
        let prepared = packet
            .map(|packet| self.prepare_import(id, Import::new(packet, "filesystem")))
            .transpose()?;
        let entry = if let Some(prepared) = prepared.as_ref().filter(|p| p.accepts_operations()) {
            header.sequence = header
                .sequence
                .checked_add(1)
                .ok_or_else(|| EditorError::new("IO", "Journal counter exhausted", &header.path))?;
            header.applied = prepared.preview().version.clone();
            Some(JournalEntry {
                packet: prepared.packet().clone(),
                applied: header.applied.clone(),
            })
        } else {
            None
        };
        header.saved_text = decoded.0;
        header.bom = decoded.1;
        header.line_ending = decoded.2;
        header.saved_version = Some(disk_version.clone());
        header.disk_revision = disk.revision;
        header.disk_cursor = self.cursor(id, disk_version, disk.data)?;
        self.stage_observation(id, header, entry, prepared).await
    }
}
