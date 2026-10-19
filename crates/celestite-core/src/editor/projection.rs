//! Ordinary-file writes, conflicts and recoverable directory operations.
//! Recovery snapshots protect writes; observations reconcile current-session history.
use super::state::{DirectoryIntent, DirectoryOperation, PendingWrite, WritePhase};
use super::{
    EditorCore, ExternalChangePolicy, MAX_FILE_BYTES, decode, encode, validate_path, within,
};
use crate::error::{EditorError, EditorResult, ErrorCode, RenamePhase};
use crate::fs::{FileEntry, FileSnapshot, FileSystem, WriteMode};
use celestite_buffer::types::{BufferError, Version};

impl<F: FileSystem, R: FileSystem> EditorCore<F, R> {
    pub async fn save(&mut self, id: &str, expected: Option<Version>) -> EditorResult<()> {
        let result = self.save_inner(id, expected).await;
        if let Err(error) = &result
            && let Some(record) = self.records.get_mut(id)
        {
            record.error = Some(error.message.clone());
            record.conflict = error.code == ErrorCode::Conflict;
        }
        result
    }
    async fn save_inner(&mut self, id: &str, expected: Option<Version>) -> EditorResult<()> {
        if self.recovery_error.is_some() {
            self.checkpoint().await?;
        }
        self.live(id)?;
        let record = self.record(id)?;
        if expected
            .as_ref()
            .is_some_and(|version| version != &record.buffer.version())
        {
            return Err(BufferError::StaleVersion.into());
        }
        if self.files.is_none() {
            return Err(EditorError::new(
                ErrorCode::Unsupported,
                "This session has no ordinary file system",
                id,
            ));
        }
        let path = record.header.path.clone();
        let disk = self
            .files()?
            .read_file(&path, Some(MAX_FILE_BYTES as u64))
            .await?;
        if !self.recover_completed_write(id, &disk).await? {
            return Err(EditorError::new(
                ErrorCode::Conflict,
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
                ErrorCode::Conflict,
                "文件已被其他客户端或程序修改。",
                &path,
            ));
        }
        // Reconciliation may have accepted a new version after the client's save request.
        if expected
            .as_ref()
            .is_some_and(|version| version != &record.buffer.version())
        {
            return Err(BufferError::StaleVersion.into());
        }
        let snapshot = record.buffer.snapshot();
        if snapshot.text.as_ref() == record.header.saved_text {
            let record = self.records.get_mut(id).unwrap();
            record.error = None;
            record.conflict = false;
            record.first_dirty = None;
            return Ok(());
        }
        let bytes = encode(&record.header, &snapshot.text);
        let baseline = record.header.disk_revision.clone();
        self.records.get_mut(id).unwrap().header.pending_write = Some(PendingWrite {
            text: snapshot.text.to_string(),
            version: snapshot.version.clone(),
            phase: WritePhase::Prepared,
        });
        self.checkpoint_document(id).await?;
        self.records
            .get_mut(id)
            .unwrap()
            .header
            .pending_write
            .as_mut()
            .unwrap()
            .phase = WritePhase::Started;
        if let Err(error) = self.checkpoint_document(id).await {
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
            .files()?
            .write_file(&path, &bytes, WriteMode::Replace, Some(&baseline))
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
                    self.checkpoint_document(id).await?;
                }
                let record = self.records.get_mut(id).unwrap();
                record.error = Some(error.message.clone());
                record.conflict = error.code == ErrorCode::Conflict;
                return Err(error);
            }
        };
        let mut header = self.record(id)?.header.clone();
        header.saved_text = snapshot.text.to_string();
        header.saved_version = Some(snapshot.version.clone());
        header.disk_revision = revision;
        header.pending_write = None;
        header.disk_cursor = Some(self.cursor(id, snapshot.version, bytes)?);
        self.stage_observation(id, header, None).await
    }
    pub async fn resolve(&mut self, id: &str, action: &str) -> EditorResult<()> {
        if self.recovery_error.is_some() {
            self.checkpoint().await?;
        }
        self.live(id)?;
        let path = self.record(id)?.header.path.clone();
        let disk = self
            .files()?
            .read_file(&path, Some(MAX_FILE_BYTES as u64))
            .await?;
        if matches!(self.options.external_changes, ExternalChangePolicy::Merge)
            && !self.recover_completed_write(id, &disk).await?
        {
            return Err(EditorError::new(
                ErrorCode::Conflict,
                "Uncertain file write requires evidence-aware recovery",
                &path,
            ));
        }
        match action {
            "discard" => {
                let decoded = decode(&disk.data, &path)?;
                self.adopt_disk(id, decoded, disk, true).await
            }
            "overwrite" => {
                if matches!(self.options.external_changes, ExternalChangePolicy::Merge) {
                    let desired = self.record(id)?.buffer.snapshot().text;
                    self.merge_disk(id, disk).await?;
                    self.require_observed(id)?;
                    self.replace_text(id, &desired)?;
                } else {
                    self.records.get_mut(id).unwrap().header.disk_revision = disk.revision;
                }
                self.save(id, None).await
            }
            _ => Err(EditorError::new(
                ErrorCode::InvalidEdit,
                "Unknown conflict action",
                &path,
            )),
        }
    }
    pub fn before_replace(&self, path: &str) -> EditorResult<()> {
        if self.records.values().any(|r| {
            !r.header.deleted
                && r.header.path == path
                && !r.buffer.content_matches(&r.header.saved_text)
        }) {
            return Err(EditorError::new(
                ErrorCode::Conflict,
                "File has unsaved CRDT edits; use the document API",
                path,
            ));
        }
        Ok(())
    }
    async fn finish_directory(&mut self, intent: &DirectoryIntent) -> EditorResult<()> {
        for path in &intent.paths {
            let target = if intent.operation == DirectoryOperation::Rename {
                format!(
                    "{}{}",
                    intent.to.as_ref().unwrap(),
                    &path[intent.from.len()..]
                )
            } else {
                path.clone()
            };
            let removed = intent.operation == DirectoryOperation::Remove
                && self.files()?.stat(path).await?.is_none();
            for record in self.records.values_mut().filter(|r| {
                !r.header.deleted && (r.header.path == *path || r.header.path == target)
            }) {
                if intent.operation == DirectoryOperation::Rename {
                    record.header.path = target.clone();
                } else if removed {
                    record.header.deleted = true;
                    record.first_dirty = None;
                }
            }
        }
        self.checkpoint_documents().await?;
        self.set_directory_intent(None).await
    }
    pub(super) async fn recover_directory(&mut self) -> EditorResult<()> {
        let Some(intent) = self.directory_intent.clone() else {
            return Ok(());
        };
        validate_path(&intent.from)?;
        for path in &intent.paths {
            validate_path(path)?;
            if !within(path, &intent.from) {
                return Err(EditorError::new(
                    ErrorCode::Io,
                    "Invalid directory recovery intent",
                    path,
                ));
            }
        }
        if intent.operation == DirectoryOperation::Remove {
            return self.finish_directory(&intent).await;
        }
        if intent.operation != DirectoryOperation::Rename || intent.to.is_none() {
            return Err(EditorError::new(
                ErrorCode::Io,
                "Unknown directory recovery intent",
                &intent.from,
            ));
        }
        let to = intent.to.as_ref().unwrap();
        validate_path(to)?;
        let source = self.files()?.stat(&intent.from).await?;
        let target = self.files()?.stat(to).await?;
        match (source, target) {
            (None, Some(_)) => self.finish_directory(&intent).await,
            (Some(_), None) => self.set_directory_intent(None).await,
            _ => Err(EditorError::new(
                ErrorCode::Conflict,
                "上次移动未完成，源与目标状态存在歧义；文件与历史已保留。",
                &intent.from,
            )),
        }
    }
    pub async fn rename(&mut self, from: &str, to: &str) -> EditorResult<()> {
        if self.recovery.is_some() {
            self.checkpoint().await?;
        }
        validate_path(from)?;
        validate_path(to)?;
        self.recover_directory().await?;
        if from == to && !from.is_empty() {
            return self.files()?.rename(from, to).await;
        }
        if from.is_empty() || to.is_empty() || within(to, from) {
            return Err(EditorError::new(
                ErrorCode::InvalidPath,
                "Cannot move root or a directory into itself",
                from,
            ));
        }
        let intent = DirectoryIntent {
            operation: DirectoryOperation::Rename,
            from: from.into(),
            to: Some(to.into()),
            paths: self
                .records
                .values()
                .filter(|r| !r.header.deleted && within(&r.header.path, from))
                .map(|r| r.header.path.clone())
                .collect(),
        };
        self.set_directory_intent(Some(&intent)).await?;
        if let Err(error) = self.files()?.rename(from, to).await {
            if error
                .rename
                .as_ref()
                .is_some_and(|r| r.phase == RenamePhase::RemoveSource)
            {
                // Keep the complete target and its identity; retain the intent for
                // an explicit resolution of remaining source files on recovery.
                for path in &intent.paths {
                    for record in self
                        .records
                        .values_mut()
                        .filter(|r| !r.header.deleted && r.header.path == *path)
                    {
                        record.header.path = format!("{}{}", to, &path[from.len()..]);
                    }
                }
                self.checkpoint_documents().await?;
            } else if matches!(
                error.code.as_str(),
                "AlreadyExists" | "InvalidPath" | "Unsupported" | "NotFound"
            ) || (self.files()?.stat(from).await?.is_some()
                && self.files()?.stat(to).await?.is_none())
            {
                self.set_directory_intent(None).await?;
            }
            return Err(error);
        }
        self.finish_directory(&intent).await
    }
    pub async fn remove(&mut self, path: &str, recursive: bool) -> EditorResult<()> {
        if self.recovery.is_some() {
            self.checkpoint().await?;
        }
        validate_path(path)?;
        self.recover_directory().await?;
        if path.is_empty() {
            return Err(EditorError::new(
                ErrorCode::InvalidPath,
                "Cannot remove Vault root",
                path,
            ));
        }
        let intent = DirectoryIntent {
            operation: DirectoryOperation::Remove,
            from: path.into(),
            to: None,
            paths: self
                .records
                .values()
                .filter(|r| !r.header.deleted && within(&r.header.path, path))
                .map(|r| r.header.path.clone())
                .collect(),
        };
        self.set_directory_intent(Some(&intent)).await?;
        let result = self.files()?.remove(path, recursive).await;
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
    pub async fn file_stat(&self, path: &str) -> EditorResult<Option<FileEntry>> {
        validate_path(path)?;
        self.files()?.stat(path).await
    }

    pub async fn file_read_dir(&self, path: &str) -> EditorResult<Vec<FileEntry>> {
        validate_path(path)?;
        self.files()?.read_dir(path).await
    }

    /// Read the existing projection without implicitly saving the live text.
    pub async fn file_read_snapshot(&self, path: &str) -> EditorResult<FileSnapshot> {
        validate_path(path)?;
        self.files()?.read_file(path, None).await
    }

    /// The ordinary file-download workflow saves loaded text before reading.
    /// Read-only resources instead use file_read_snapshot.
    pub async fn file_read(&mut self, path: &str) -> EditorResult<Vec<u8>> {
        self.save_under(path).await?;
        Ok(self.files()?.read_file(path, None).await?.data)
    }

    pub async fn file_mkdir(&mut self, path: &str, recursive: bool) -> EditorResult<()> {
        validate_path(path)?;
        self.files()?.mkdir(path, recursive).await
    }

    pub async fn file_write(
        &mut self,
        path: &str,
        data: &[u8],
        mode: WriteMode,
        expected_revision: Option<&str>,
    ) -> EditorResult<String> {
        if mode == WriteMode::Upsert {
            return Err(EditorError::new(
                ErrorCode::InvalidEdit,
                "Ordinary files require create or replace",
                path,
            ));
        }
        self.save_under(path).await?;
        self.before_replace(path)?;
        let revision = self
            .files()?
            .write_file(path, data, mode, expected_revision)
            .await?;
        self.refresh_path(path).await?;
        Ok(revision)
    }

    pub async fn file_rename(&mut self, from: &str, to: &str) -> EditorResult<()> {
        self.save_under(from).await?;
        self.rename(from, to).await
    }

    pub async fn file_remove(&mut self, path: &str, recursive: bool) -> EditorResult<()> {
        self.save_under(path).await?;
        self.remove(path, recursive).await
    }

    async fn save_under(&mut self, path: &str) -> EditorResult<()> {
        validate_path(path)?;
        let ids: Vec<_> = self
            .records
            .values()
            .filter(|r| !r.header.deleted && within(&r.header.path, path))
            .map(|r| r.header.id.clone())
            .collect();
        for id in ids {
            self.save(&id, None).await?;
        }
        Ok(())
    }
}
