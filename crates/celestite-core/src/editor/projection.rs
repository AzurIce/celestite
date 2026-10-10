//! Ordinary-file writes, conflicts and recoverable directory operations.
//! History commitment uses the shared mutation pipeline; observations reconcile disk history.
use super::{
    EditorCore, ExternalChangePolicy, MAX_TEXT_BYTES, decode, encode, validate_editor_path, within,
};
use crate::backend::{
    Backend, DirectoryIntent, EditorError, EditorResult, FileEntry, FileSnapshot, PendingWrite,
    WritePhase,
};
use celestite_buffer::types::{BufferError, Version};

impl<B: Backend> EditorCore<B> {
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
            return Err(BufferError::StaleVersion.into());
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
        header.saved_text = snapshot.text.to_string();
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
                    self.replace_text(id, &desired).await?.require_committed()?;
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
                && !r.buffer.content_matches(&r.header.saved_text)
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
        }
        self.persist_headers().await?;
        self.backend.set_directory_intent(None).await
    }
    pub(super) async fn recover_directory(&mut self) -> EditorResult<()> {
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
    pub async fn file_stat(&self, path: &str) -> EditorResult<Option<FileEntry>> {
        validate_editor_path(path)?;
        self.backend.stat(path).await
    }

    pub async fn file_read_dir(&self, path: &str) -> EditorResult<Vec<FileEntry>> {
        validate_editor_path(path)?;
        self.backend.read_dir(path).await
    }

    /// Read the existing projection without implicitly saving the live text.
    pub async fn file_read_snapshot(&self, path: &str) -> EditorResult<FileSnapshot> {
        validate_editor_path(path)?;
        self.backend.read_file(path, None).await
    }

    /// The ordinary file-download workflow saves loaded text before reading.
    /// Read-only resources instead use file_read_snapshot.
    pub async fn file_read(&mut self, path: &str) -> EditorResult<Vec<u8>> {
        self.save_under(path).await?;
        Ok(self.backend.read_file(path, None).await?.data)
    }

    pub async fn file_mkdir(&mut self, path: &str, recursive: bool) -> EditorResult<()> {
        validate_editor_path(path)?;
        self.backend.mkdir(path, recursive).await
    }

    pub async fn file_write(
        &mut self,
        path: &str,
        data: &[u8],
        mode: &str,
        expected_revision: Option<&str>,
    ) -> EditorResult<String> {
        self.save_under(path).await?;
        self.before_replace(path)?;
        let revision = self
            .backend
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
        validate_editor_path(path)?;
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
