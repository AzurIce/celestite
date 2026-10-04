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
    feed: super::changes::DocumentFeed,
    writers: std::collections::HashSet<String>,
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
        let identity = VaultIdentity {
            id: vault.vault_id.clone(),
            history_id: vault.history_id.clone(),
        };
        let feed = super::changes::DocumentFeed::new(identity.clone(), core.persistent());
        Ok(Self {
            identity,
            core,
            feed,
            writers: Default::default(),
        })
    }
    pub fn reconcile(&mut self) -> Result<()> {
        for error in block_on(self.core.reconcile_files()) {
            tracing::warn!(path = %error.path, code = %error.code, message = %error.message, "File observation failed; preserving history and continuing other files");
        }
        // History failures stay frozen; a filesystem hint is not permission to retry.
        if let Some(error) = self
            .core
            .resident()
            .map_err(vault_error)?
            .iter()
            .find_map(|state| state.persistence_error.as_ref())
        {
            return Err(super::fs::VaultError::new("IO", error, ""));
        }
        Ok(())
    }
    pub fn resident(&self) -> Result<Vec<DocumentState>> {
        self.core.resident().map_err(vault_error)
    }
    pub fn publish_changes(&mut self) -> Result<bool> {
        let states = self.resident()?;
        self.feed.publish(states)
    }
    pub fn subscribe(&mut self) -> Result<super::changes::Subscription> {
        self.publish_changes()?;
        Ok(self.feed.subscribe())
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
    fn require_committed(&self, id: &str) -> Result<()> {
        let state = self.core.read(id).map_err(vault_error)?;
        if !super::changes::exportable(&state, self.persistent()) {
            return Err(super::fs::VaultError::new(
                "IO",
                "Host history is not committed; synchronization is paused",
                &state.path,
            ));
        }
        Ok(())
    }
    pub fn snapshot(&self, id: &str) -> Result<SyncPacket> {
        self.require_committed(id)?;
        self.core.snapshot(id).map_err(vault_error)
    }
    pub fn updates(&self, id: &str, version: &Version) -> Result<SyncPacket> {
        self.require_committed(id)?;
        self.core.updates(id, version).map_err(vault_error)
    }
    /// Writers are reserved for the lifetime of this host, even before their
    /// first operation. A reconnect always receives a new writer.
    pub fn allocate_writer(&mut self, id: &str) -> Result<String> {
        let snapshot = self.snapshot(id)?;
        loop {
            let replica =
                Document::from_snapshot(&snapshot, None).map_err(|e| vault_error(e.into()))?;
            let writer = replica.writer_id();
            if self.writers.insert(writer.clone()) {
                return Ok(writer);
            }
        }
    }
    /// Validate on an isolated history before touching live state or undo.
    /// Clients may only advance their assigned writer, with complete causal
    /// dependencies; an old session's unsent writer cannot be smuggled in.
    pub fn import_session(
        &mut self,
        id: &str,
        packet: SyncPacket,
        writer: &str,
        claimed: &Version,
    ) -> Result<()> {
        if packet.kind != PacketKind::Updates || packet.data.len() > 16 * 1024 * 1024 {
            return Err(super::fs::VaultError::new(
                "InvalidEdit",
                "Expected bounded CRDT updates",
                id,
            ));
        }
        let snapshot = self.snapshot(id)?;
        let mut trial =
            Document::from_snapshot(&snapshot, None).map_err(|e| vault_error(e.into()))?;
        let before = trial.version();
        let result = trial
            .import(&packet, "session-validation".into())
            .map_err(|e| vault_error(e.into()))?;
        let after = trial.version();
        if result.pending
            || !super::super::sync::contains(&after, claimed)
            || after.clocks.iter().any(|(peer, clock)| {
                peer != writer && *clock > before.clocks.get(peer).copied().unwrap_or(0)
            })
            || claimed.clocks.get(writer) != after.clocks.get(writer)
        {
            return Err(super::fs::VaultError::new(
                "InvalidEdit",
                "Invalid session writer or causal dependencies",
                id,
            ));
        }
        self.import(id, packet)?;
        self.require_committed(id)
    }
    pub fn save(&mut self, _files: &FsVault, id: &str, expected: Version) -> Result<()> {
        block_on(self.core.save(id, Some(expected))).map_err(vault_error)
    }
    pub fn commit_replica(
        &mut self,
        id: &str,
        packet: Option<SyncPacket>,
        expected: &str,
        action: &str,
    ) -> Result<()> {
        block_on(self.core.commit_replica(id, packet, expected, action)).map_err(vault_error)
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
