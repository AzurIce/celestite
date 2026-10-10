//! Host-owned buffers and their committed state feed.
use super::{
    backend::{vault_error, NativeBackend},
    fs::{FsVault, Result},
    VaultIdentity,
};
use celestite_buffer::types::{Anchor, HistoryPacket, HistoryPacketKind, Version};
#[cfg(test)]
use celestite_core::editor::types::EditorMutation;
use celestite_core::editor::{
    observation::{FileObservationResult, FileObservationTask},
    types::{EditorDocument, HostDocument},
    EditorCore, EditorOptions, ExternalChangePolicy,
};
use futures_lite::future::block_on;
use std::path::Path;

pub(crate) struct Documents {
    pub identity: VaultIdentity,
    pub files: std::sync::Arc<FsVault>,
    core: EditorCore<NativeBackend>,
    feed: super::changes::DocumentFeed,
    peer_ids: std::collections::HashSet<u64>,
}
impl Documents {
    pub fn open(root: &Path, seed: &[u8; 32]) -> Result<Self> {
        let backend = NativeBackend::open(root, VaultIdentity::new(root, seed))?;
        let files = backend.files.clone();
        let core = block_on(EditorCore::open_with_options(
            backend,
            EditorOptions {
                external_changes: ExternalChangePolicy::Merge,
                defer_filesystem_diff: true,
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
            files,
            core,
            feed,
            peer_ids: Default::default(),
        })
    }
    pub fn reconcile(&mut self) -> Result<()> {
        for error in block_on(self.core.reconcile_files()) {
            tracing::warn!(path = %error.path, code = %error.code, message = %error.message, "File observation failed; preserving history and continuing other files");
        }
        // History failures stay frozen; a filesystem hint is not permission to retry.
        if let Some(error) = self
            .core
            .resident_status()
            .map_err(vault_error)?
            .iter()
            .find_map(|state| state.persistence_error.as_ref())
        {
            return Err(super::fs::VaultError::new("IO", error, ""));
        }
        Ok(())
    }
    pub fn resident(&self) -> Result<Vec<EditorDocument>> {
        self.core.resident().map_err(vault_error)
    }
    pub fn has_file_observations(&self) -> bool {
        self.core.has_file_observations()
    }
    pub fn take_file_observation(&mut self) -> Result<Option<FileObservationTask>> {
        self.core.take_file_observation().map_err(vault_error)
    }
    pub fn complete_file_observation(&mut self, result: FileObservationResult) -> Result<bool> {
        block_on(self.core.complete_file_observation(result)).map_err(vault_error)
    }
    pub fn retry_file_observation(&mut self, id: &str) -> Result<()> {
        block_on(self.core.retry_file_observation(id)).map_err(vault_error)
    }
    pub fn publish_changes(&mut self) -> Result<bool> {
        // This transport publishes coalesced committed states; drain the owner's
        // mutation batch so it cannot accumulate behind the state feed.
        self.core.take_mutations();
        let states = self.core.resident_status().map_err(vault_error)?;
        self.feed.publish(states)
    }
    pub fn subscribe(&mut self) -> Result<super::changes::Subscription> {
        self.publish_changes()?;
        Ok(self.feed.subscribe())
    }
    pub fn persistent(&self) -> bool {
        self.core.persistent()
    }
    pub fn open_file(&mut self, path: &str) -> Result<String> {
        block_on(self.core.open_file(path)).map_err(vault_error)
    }
    pub fn list(&mut self) -> Result<Vec<EditorDocument>> {
        block_on(self.core.list()).map_err(vault_error)
    }
    pub fn state(&self, id: &str) -> Result<EditorDocument> {
        self.core.read(id).map_err(vault_error)
    }
    pub fn host_document(&self, id: &str, known_revision: Option<&str>) -> Result<HostDocument> {
        let status = self.core.status(id).map_err(vault_error)?;
        self.core
            .host_document(id, known_revision != Some(status.file_revision.as_str()))
            .map_err(vault_error)
    }
    pub fn committed_version(&self, id: &str) -> Result<Version> {
        self.require_committed(id)?;
        Ok(self.core.status(id).map_err(vault_error)?.version)
    }
    pub fn validate_presence(&self, id: &str, version: &Version, anchors: &[Anchor]) -> Result<()> {
        self.require_committed(id)?;
        if !self
            .core
            .status(id)
            .map_err(vault_error)?
            .version
            .contains(version)
        {
            return Err(super::fs::VaultError::new(
                "StaleVersion",
                "Unknown presence checkpoint",
                id,
            ));
        }
        self.core
            .resolve_anchors(id, anchors)
            .map(|_| ())
            .map_err(vault_error)
    }
    pub fn refresh_path(&mut self, path: &str) -> Result<()> {
        block_on(self.core.refresh_path(path)).map_err(vault_error)
    }
    pub fn refresh(&mut self, id: &str) -> Result<()> {
        block_on(self.core.refresh(id)).map_err(vault_error)
    }
    #[cfg(test)]
    pub fn edit<'a>(
        &mut self,
        id: &str,
        edits: impl IntoIterator<Item = (std::ops::Range<usize>, &'a str)>,
    ) -> Result<std::sync::Arc<EditorMutation>> {
        block_on(self.core.edit(id, edits)).map_err(vault_error)
    }
    fn require_committed(&self, id: &str) -> Result<()> {
        let state = self.core.status(id).map_err(vault_error)?;
        if !super::changes::exportable(&state, self.persistent()) {
            return Err(super::fs::VaultError::new(
                "IO",
                "Host history is not committed; synchronization is paused",
                &state.path,
            ));
        }
        Ok(())
    }
    pub fn snapshot(&self, id: &str) -> Result<HistoryPacket> {
        self.require_committed(id)?;
        self.core.snapshot(id).map_err(vault_error)
    }
    pub fn updates(&self, id: &str, version: &Version) -> Result<HistoryPacket> {
        self.require_committed(id)?;
        self.core.updates(id, version).map_err(vault_error)
    }
    /// Peer IDs are reserved for the lifetime of this host, even before their
    /// first operation. A reconnect always receives a new peer ID.
    pub fn allocate_peer_id(&mut self, id: &str) -> Result<u64> {
        self.require_committed(id)?;
        let version = self.core.status(id).map_err(vault_error)?.version;
        let host_peer_id = self.core.peer_id(id).map_err(vault_error)?;
        loop {
            let mut bytes = [0_u8; 8];
            getrandom::fill(&mut bytes)
                .map_err(|e| super::fs::VaultError::new("IO", e.to_string(), id))?;
            let peer_id = u64::from_le_bytes(bytes);
            // Loro reserves MAX; a wire-valid integer is not always a peer ID.
            if peer_id != u64::MAX
                && peer_id != host_peer_id
                && version.clock(peer_id) == 0
                && self.peer_ids.insert(peer_id)
            {
                return Ok(peer_id);
            }
        }
    }

    /// Validate on an isolated history before touching live state or undo.
    /// Clients may only advance their assigned peer ID, with complete causal
    /// dependencies; an old session's unsent peer cannot be smuggled in.
    pub fn import_session(
        &mut self,
        id: &str,
        packet: HistoryPacket,
        peer_id: u64,
        claimed: &Version,
    ) -> Result<()> {
        if packet.kind != HistoryPacketKind::Updates || packet.data.len() > 16 * 1024 * 1024 {
            return Err(super::fs::VaultError::new(
                "InvalidEdit",
                "Expected bounded CRDT updates",
                id,
            ));
        }
        self.require_committed(id)?;
        let prepared = self.core.prepare_import(id, packet).map_err(vault_error)?;
        let before = prepared.before();
        let after = &prepared.preview().version;
        if prepared.preview().pending
            || !after.contains(claimed)
            || after
                .iter()
                .any(|(peer, clock)| peer != peer_id && clock > before.clock(peer))
            || claimed.clock(peer_id) != after.clock(peer_id)
        {
            return Err(super::fs::VaultError::new(
                "InvalidEdit",
                "Invalid session peer ID or causal dependencies",
                id,
            ));
        }
        let mutation = block_on(self.core.commit_import(id, prepared)).map_err(vault_error)?;
        mutation.require_committed().map_err(vault_error)
    }
    pub fn save(&mut self, id: &str, expected: Version) -> Result<()> {
        block_on(self.core.save(id, Some(expected))).map_err(vault_error)
    }
    pub fn before_replace(&self, path: &str) -> Result<()> {
        self.core.before_replace(path).map_err(vault_error)
    }
    pub fn rename(&mut self, from: &str, to: &str) -> Result<()> {
        block_on(self.core.rename(from, to)).map_err(vault_error)
    }
    pub fn remove(&mut self, path: &str, recursive: bool) -> Result<()> {
        block_on(self.core.remove(path, recursive)).map_err(vault_error)
    }
}
