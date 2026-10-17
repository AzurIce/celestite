//! Native platform IO for the shared EditorCore. The caller runs it on a blocking worker.
use super::fs::{self, FsVault};
use celestite_core::backend::ErrorCode;
use celestite_core::instance::Vault;
use celestite_core::{
    backend::{
        Backend, DirectoryIntent, DocumentHeader, EditorError, EditorResult, FileEntry,
        FileSnapshot, JournalEntry, StoredDocument,
    },
    instance::InstanceIdentity,
};
use std::{
    path::Path,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

pub(crate) struct NativeBackend {
    pub(crate) files: Arc<FsVault>,
    identity: InstanceIdentity,
    intent: Option<DirectoryIntent>,
}
impl NativeBackend {
    pub fn open(root: &Path, vault: Vault) -> fs::Result<Self> {
        Ok(Self {
            files: Arc::new(
                FsVault::open(root)
                    .map_err(|e| EditorError::new(ErrorCode::Io, e.to_string(), ""))?,
            ),
            identity: InstanceIdentity {
                instance_id: uuid::Uuid::new_v4().to_string(),
                vault: Vault {
                    vault_id: vault.vault_id,
                    history_id: vault.history_id,
                },
            },
            intent: None,
        })
    }
}
impl Backend for NativeBackend {
    fn identity(&self) -> &InstanceIdentity {
        &self.identity
    }
    fn persistent(&self) -> bool {
        false
    }
    fn new_id(&self) -> EditorResult<String> {
        Ok(uuid::Uuid::new_v4().to_string())
    }
    fn has_projection(&self) -> bool {
        true
    }
    fn now_ms(&self) -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64
    }
    async fn load(&mut self) -> EditorResult<Vec<StoredDocument>> {
        Ok(vec![])
    }
    async fn commit(
        &mut self,
        _header: &DocumentHeader,
        _entry: Option<&JournalEntry>,
    ) -> EditorResult<()> {
        Ok(())
    }
    async fn directory_intent(&mut self) -> EditorResult<Option<DirectoryIntent>> {
        Ok(self.intent.clone())
    }
    async fn set_directory_intent(&mut self, intent: Option<&DirectoryIntent>) -> EditorResult<()> {
        self.intent = intent.cloned();
        Ok(())
    }
    async fn stat(&self, path: &str) -> EditorResult<Option<FileEntry>> {
        self.files.stat(path)
    }
    async fn read_dir(&self, path: &str) -> EditorResult<Vec<FileEntry>> {
        self.files.read_dir(path)
    }
    async fn read_file(&self, path: &str, limit: Option<u64>) -> EditorResult<FileSnapshot> {
        let data = self
            .files
            .read_file_limited(path, limit.unwrap_or(u64::MAX))?;
        let revision = fs::revision(&data);
        Ok(FileSnapshot { data, revision })
    }
    async fn write_file(
        &self,
        path: &str,
        data: &[u8],
        mode: &str,
        expected: Option<&str>,
    ) -> EditorResult<String> {
        self.files.write_file(path, data, mode, expected)
    }
    async fn mkdir(&self, path: &str, recursive: bool) -> EditorResult<()> {
        self.files.mkdir(path, recursive)
    }
    async fn rename(&self, from: &str, to: &str) -> EditorResult<()> {
        self.files.rename(from, to)
    }
    async fn remove(&self, path: &str, recursive: bool) -> EditorResult<()> {
        self.files.remove(path, recursive)
    }
}
