//! Host-owned buffers and their committed state feed.
use super::vault_identity;
use celestite_buffer::types::{Anchor, HistoryPacket, HistoryPacketKind, Version};
#[cfg(test)]
use celestite_core::editor::types::EditorMutation;
use celestite_core::editor::{
    observation::{FileObservationResult, FileObservationTask},
    types::{EditorDocument, HostDocument},
    EditorCore, EditorOptions, ExternalChangePolicy,
};
use celestite_core::error::{EditorError, EditorResult, ErrorCode};
use celestite_core::fs::native::FsVault;
use celestite_core::instance::{InstanceIdentity, Vault};
use futures_lite::future::block_on;
use std::path::Path;

pub(crate) struct Documents {
    pub identity: Vault,
    pub files: std::sync::Arc<FsVault>,
    core: EditorCore<std::sync::Arc<FsVault>>,
    feed: super::changes::DocumentFeed,
    peer_ids: std::collections::HashSet<u64>,
}
impl Documents {
    pub fn open(root: &Path, seed: &[u8; 32]) -> EditorResult<Self> {
        let files = std::sync::Arc::new(
            FsVault::open(root)
                .map_err(|error| EditorError::new(ErrorCode::Io, error.to_string(), ""))?,
        );
        let identity = InstanceIdentity {
            instance_id: uuid::Uuid::new_v4().to_string(),
            vault: vault_identity(root, seed),
        };
        let core = block_on(EditorCore::open_with_options(
            identity,
            Some(files.clone()),
            None,
            EditorOptions {
                external_changes: ExternalChangePolicy::Merge,
                defer_filesystem_diff: true,
                ..Default::default()
            },
        ))?;
        let vault = &core.identity().vault;
        let identity = vault.clone();
        let feed = super::changes::DocumentFeed::new(identity.clone());
        Ok(Self {
            identity,
            files,
            core,
            feed,
            peer_ids: Default::default(),
        })
    }
    pub fn reconcile(&mut self) -> EditorResult<()> {
        for error in block_on(self.core.reconcile_files()) {
            tracing::warn!(path = %error.path, code = %error.code, message = %error.message, "File observation failed; preserving history and continuing other files");
        }
        Ok(())
    }
    pub fn resident(&self) -> EditorResult<Vec<EditorDocument>> {
        self.core.resident()
    }
    pub fn has_file_observations(&self) -> bool {
        self.core.has_file_observations()
    }
    pub fn take_file_observation(&mut self) -> EditorResult<Option<FileObservationTask>> {
        self.core.take_file_observation()
    }
    pub fn complete_file_observation(
        &mut self,
        result: FileObservationResult,
    ) -> EditorResult<bool> {
        block_on(self.core.complete_file_observation(result))
    }
    pub fn retry_file_observation(&mut self, id: &str) -> EditorResult<()> {
        block_on(self.core.retry_file_observation(id))
    }
    pub fn publish_changes(&mut self) -> EditorResult<bool> {
        // This transport publishes coalesced committed states; drain the owner's
        // mutation batch so it cannot accumulate behind the state feed.
        self.core.take_mutations();
        let states = self.core.resident_status()?;
        self.feed.publish(states)
    }
    pub fn subscribe(&mut self) -> EditorResult<super::changes::Subscription> {
        self.publish_changes()?;
        Ok(self.feed.subscribe())
    }
    pub fn open_file(&mut self, path: &str) -> EditorResult<String> {
        block_on(self.core.open_file(path))
    }
    pub fn list(&mut self) -> EditorResult<Vec<EditorDocument>> {
        block_on(self.core.list())
    }
    pub fn state(&self, id: &str) -> EditorResult<EditorDocument> {
        self.core.read(id)
    }
    pub fn host_document(
        &self,
        id: &str,
        known_revision: Option<&str>,
    ) -> EditorResult<HostDocument> {
        let status = self.core.status(id)?;
        self.core
            .host_document(id, known_revision != Some(status.file_revision.as_str()))
    }
    pub fn version(&self, id: &str) -> EditorResult<Version> {
        Ok(self.core.status(id)?.version)
    }
    pub fn validate_presence(
        &self,
        id: &str,
        version: &Version,
        anchors: &[Anchor],
    ) -> EditorResult<()> {
        if !self.core.status(id)?.version.contains(version) {
            return Err(EditorError::new(
                ErrorCode::StaleVersion,
                "Unknown presence checkpoint",
                id,
            ));
        }
        self.core.resolve_anchors(id, anchors).map(|_| ())
    }
    pub fn refresh_path(&mut self, path: &str) -> EditorResult<()> {
        block_on(self.core.refresh_path(path))
    }
    pub fn refresh(&mut self, id: &str) -> EditorResult<()> {
        block_on(self.core.refresh(id))
    }
    #[cfg(test)]
    pub fn edit<'a>(
        &mut self,
        id: &str,
        edits: impl IntoIterator<Item = (std::ops::Range<usize>, &'a str)>,
    ) -> EditorResult<std::sync::Arc<EditorMutation>> {
        self.core.edit(id, edits)
    }
    pub fn snapshot(&self, id: &str) -> EditorResult<HistoryPacket> {
        self.core.snapshot(id)
    }
    pub fn updates(&self, id: &str, version: &Version) -> EditorResult<HistoryPacket> {
        self.core.updates(id, version)
    }
    /// Peer IDs are reserved for the lifetime of this host, even before their
    /// first operation. A reconnect always receives a new peer ID.
    pub fn allocate_peer_id(&mut self, id: &str) -> EditorResult<u64> {
        let version = self.core.status(id)?.version;
        let host_peer_id = self.core.peer_id(id)?;
        loop {
            let mut bytes = [0_u8; 8];
            getrandom::fill(&mut bytes)
                .map_err(|e| EditorError::new(ErrorCode::Io, e.to_string(), id))?;
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
    ) -> EditorResult<()> {
        if packet.kind != HistoryPacketKind::Updates || packet.data.len() > 16 * 1024 * 1024 {
            return Err(EditorError::new(
                ErrorCode::InvalidEdit,
                "Expected bounded CRDT updates",
                id,
            ));
        }
        let prepared = self.core.prepare_import(id, packet)?;
        let before = prepared.before();
        let after = &prepared.preview().version;
        if prepared.preview().pending
            || !after.contains(claimed)
            || after
                .iter()
                .any(|(peer, clock)| peer != peer_id && clock > before.clock(peer))
            || claimed.clock(peer_id) != after.clock(peer_id)
        {
            return Err(EditorError::new(
                ErrorCode::InvalidEdit,
                "Invalid session peer ID or causal dependencies",
                id,
            ));
        }
        self.core.commit_import(id, prepared)?;
        Ok(())
    }
    pub fn save(&mut self, id: &str, expected: Version) -> EditorResult<()> {
        block_on(self.core.save(id, Some(expected)))
    }
    pub fn before_replace(&self, path: &str) -> EditorResult<()> {
        self.core.before_replace(path)
    }
    pub fn rename(&mut self, from: &str, to: &str) -> EditorResult<()> {
        block_on(self.core.rename(from, to))
    }
    pub fn remove(&mut self, path: &str, recursive: bool) -> EditorResult<()> {
        block_on(self.core.remove(path, recursive))
    }
}
