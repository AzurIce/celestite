//! Native platform IO for the shared EditorCore. The caller runs it on a blocking worker.
use super::{
    fs::{self, FsVault},
    store::{Store, VaultIdentity},
};
use celestite_core::*;
use std::{
    path::Path,
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
        _ => "IO",
    };
    fs::VaultError::new(code, error.message, &error.path)
}

pub(crate) struct NativeBackend {
    files: FsVault,
    store: Option<Store>,
    identity: InstanceIdentity,
    intent: Option<DirectoryIntent>,
}
impl NativeBackend {
    pub fn open(state: Option<&Path>, root: &Path) -> fs::Result<Self> {
        let (store, identity) = if let Some(path) = state {
            let (store, identity) = Store::open(path, root)?;
            (Some(store), identity)
        } else {
            (
                None,
                VaultIdentity {
                    id: uuid::Uuid::new_v4().to_string(),
                    history_id: uuid::Uuid::new_v4().to_string(),
                },
            )
        };
        let instance_id = if let Some(store) = &store {
            store.instance_id()?
        } else {
            uuid::Uuid::new_v4().to_string()
        };
        Ok(Self {
            files: FsVault::open(root).map_err(|e| fs::VaultError::new("IO", e.to_string(), ""))?,
            store,
            identity: InstanceIdentity {
                instance_id,
                vault: Vault {
                    vault_id: identity.id,
                    history_id: identity.history_id,
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
        self.store.is_some()
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
        self.store
            .as_ref()
            .map_or(Ok(vec![]), |store| store.load().map_err(editor_error))
    }
    async fn commit(
        &mut self,
        header: &DocumentHeader,
        entry: Option<&JournalEntry>,
    ) -> EditorResult<()> {
        if let Some(store) = &self.store {
            store.commit(header, entry).map_err(editor_error)?;
        }
        Ok(())
    }
    async fn directory_intent(&mut self) -> EditorResult<Option<DirectoryIntent>> {
        if let Some(store) = &self.store {
            store.directory_intent().map_err(editor_error)
        } else {
            Ok(self.intent.clone())
        }
    }
    async fn set_directory_intent(&mut self, intent: Option<&DirectoryIntent>) -> EditorResult<()> {
        if let Some(store) = &self.store {
            store.set_directory_intent(intent).map_err(editor_error)?;
        }
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
