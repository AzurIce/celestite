//! Native platform IO for the shared EditorCore. The caller runs it on a blocking worker.
use super::{
    fs::{self, FsVault},
    VaultIdentity,
};
use celestite_core::*;
use std::{
    path::Path,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

pub(crate) fn editor_error(error: fs::VaultError) -> EditorError {
    EditorError::new(error.code, error.message, &error.path)
}
pub(crate) fn vault_error(error: EditorError) -> fs::VaultError {
    let code = match error.code.as_str() {
        "InvalidPath" => "InvalidPath",
        "NotFound" => "NotFound",
        "AlreadyExists" => "AlreadyExists",
        "NotDirectory" => "NotDirectory",
        "NotFile" => "NotFile",
        "DirectoryNotEmpty" => "DirectoryNotEmpty",
        "PermissionDenied" => "PermissionDenied",
        "QuotaExceeded" => "QuotaExceeded",
        "Busy" => "Busy",
        "Unsupported" => "Unsupported",
        "Closed" => "Closed",
        "Conflict" => "Conflict",
        "StaleVersion" => "StaleVersion",
        "InvalidEdit" => "InvalidEdit",
        "FilesystemDiffTimeout" => "FilesystemDiffTimeout",
        "FilesystemReconciliationPending" => "FilesystemReconciliationPending",
        _ => "IO",
    };
    fs::VaultError::new(code, error.message, &error.path)
}

pub(crate) struct NativeBackend {
    pub(crate) files: Arc<FsVault>,
    identity: InstanceIdentity,
    intent: Option<DirectoryIntent>,
}
impl NativeBackend {
    pub fn open(root: &Path, vault: VaultIdentity) -> fs::Result<Self> {
        Ok(Self {
            files: Arc::new(
                FsVault::open(root).map_err(|e| fs::VaultError::new("IO", e.to_string(), ""))?,
            ),
            identity: InstanceIdentity {
                instance_id: uuid::Uuid::new_v4().to_string(),
                vault: Vault {
                    vault_id: vault.id,
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
        Ok(self.files.stat(path).map_err(editor_error)?.map(entry))
    }
    async fn read_dir(&self, path: &str) -> EditorResult<Vec<FileEntry>> {
        Ok(self
            .files
            .read_dir(path)
            .map_err(editor_error)?
            .into_iter()
            .map(entry)
            .collect())
    }
    async fn read_file(&self, path: &str, limit: Option<u64>) -> EditorResult<FileSnapshot> {
        let data = self
            .files
            .read_file_limited(path, limit.unwrap_or(u64::MAX))
            .map_err(editor_error)?;
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
        self.files
            .write_file(path, data, mode, expected)
            .map_err(editor_error)
    }
    async fn mkdir(&self, path: &str, recursive: bool) -> EditorResult<()> {
        self.files.mkdir(path, recursive).map_err(editor_error)
    }
    async fn rename(&self, from: &str, to: &str) -> EditorResult<()> {
        self.files.rename(from, to).map_err(editor_error)
    }
    async fn remove(&self, path: &str, recursive: bool) -> EditorResult<()> {
        self.files.remove(path, recursive).map_err(editor_error)
    }
}
fn entry(entry: fs::Entry) -> FileEntry {
    FileEntry {
        path: entry.path,
        kind: entry.kind.into(),
        size: entry.size,
        modified_at: entry.modified_at,
    }
}
