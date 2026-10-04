//! HTTP compatibility facade over the same EditorCore used by Web.
use super::{
    backend::{vault_error, NativeBackend},
    fs::{FsVault, Result},
    store::VaultIdentity,
};
use celestite_core::*;
use futures_lite::future::block_on;
use std::path::Path;

pub type DocumentState = EditorDocument;
pub(crate) struct Documents {
    pub identity: VaultIdentity,
    core: EditorCore<NativeBackend>,
}
impl Documents {
    pub fn open(state: Option<&Path>, root: &Path, mode: crate::HistoryMode) -> Result<Self> {
        let core = block_on(EditorCore::open_with_options(
            NativeBackend::open(state, root, mode)?,
            EditorOptions {
                external_changes: ExternalChangePolicy::Merge,
            },
        ))
        .map_err(vault_error)?;
        let vault = &core.identity().vault;
        Ok(Self {
            identity: VaultIdentity {
                id: vault.vault_id.clone(),
                history_id: vault.history_id.clone(),
            },
            core,
        })
    }
    pub fn persistent(&self) -> bool {
        self.core.persistent()
    }
    pub fn open_file(&mut self, _files: &FsVault, path: &str) -> Result<String> {
        block_on(self.core.open_file(path)).map_err(vault_error)
    }
    pub fn list(&mut self, _files: &FsVault) -> Result<Vec<DocumentState>> {
        block_on(self.core.list()).map_err(vault_error)
    }
    pub fn state(&self, _files: &FsVault, id: &str) -> Result<DocumentState> {
        self.core.read(id).map_err(vault_error)
    }
    pub fn refresh_path(&mut self, _files: &FsVault, path: &str) -> Result<()> {
        block_on(self.core.refresh_path(path)).map_err(vault_error)
    }
    pub fn refresh(&mut self, _files: &FsVault, id: &str) -> Result<()> {
        block_on(self.core.refresh(id)).map_err(vault_error)
    }
    pub fn transact(&mut self, id: &str, transaction: Transaction) -> Result<Option<ChangeEvent>> {
        block_on(self.core.transact(id, transaction)).map_err(vault_error)
    }
    pub fn import(&mut self, id: &str, packet: SyncPacket) -> Result<ImportResult> {
        block_on(self.core.import(id, packet)).map_err(vault_error)
    }
    pub fn undo(
        &mut self,
        id: &str,
        context: UndoContext,
        redo: bool,
    ) -> Result<Option<ChangeEvent>> {
        block_on(self.core.undo(id, context, redo)).map_err(vault_error)
    }
    pub fn snapshot(&self, id: &str) -> Result<SyncPacket> {
        self.core.snapshot(id).map_err(vault_error)
    }
    pub fn updates(&self, id: &str, version: &Version) -> Result<SyncPacket> {
        self.core.updates(id, version).map_err(vault_error)
    }
    pub fn save(&mut self, _files: &FsVault, id: &str, expected: Version) -> Result<()> {
        block_on(self.core.save(id, Some(expected))).map_err(vault_error)
    }
    pub fn before_replace(&self, path: &str) -> Result<()> {
        self.core.before_replace(path).map_err(vault_error)
    }
    pub fn rename(&mut self, _files: &FsVault, from: &str, to: &str) -> Result<()> {
        block_on(self.core.rename(from, to)).map_err(vault_error)
    }
    pub fn remove(&mut self, _files: &FsVault, path: &str, recursive: bool) -> Result<()> {
        block_on(self.core.remove(path, recursive)).map_err(vault_error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn state_profile_cannot_be_reused_for_another_vault_root() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let state = tempfile::tempdir().unwrap();
        let db = state.path().join("notes.redb");
        drop(Documents::open(Some(&db), first.path(), crate::HistoryMode::Initialize).unwrap());
        assert!(Documents::open(Some(&db), second.path(), crate::HistoryMode::Recover).is_err());
    }
}
