//! History exchange and admission. No transport or persistence policy lives here.
use crate::{
    Buffer, SOURCE,
    change::TextChangeTask,
    new_peer_id,
    types::{
        BufferError, BufferUpdate, ChangeCause, DocumentIdentity, HistoryPacket, HistoryPacketKind,
        ImportOptions, ImportPreview, Version, crdt_error,
    },
};
use loro::{ContainerTrait, EncodedBlobMode, ExportMode, IdSpan, LoroDoc, VersionVector};
use std::sync::Arc;

pub(super) struct PendingImport {
    pub packet: HistoryPacket,
    pub end: VersionVector,
}

/// Read-only admission result tied to exactly one unchanged Buffer. It cannot
/// be fabricated, serialized or cloned. Dropping it discards the preparation.
#[derive(Debug)]
pub struct PreparedImport {
    owner: Arc<()>,
    state_revision: u64,
    before: Version,
    packet: HistoryPacket,
    options: ImportOptions,
    end: VersionVector,
    preview: ImportPreview,
    new_data: bool,
}

impl PreparedImport {
    pub fn before(&self) -> &Version {
        &self.before
    }
    pub fn preview(&self) -> &ImportPreview {
        &self.preview
    }
    pub fn packet(&self) -> &HistoryPacket {
        &self.packet
    }
    pub fn accepts_operations(&self) -> bool {
        self.new_data
    }
}

impl Buffer {
    pub fn import(&mut self, packet: HistoryPacket) -> Result<BufferUpdate, BufferError> {
        self.import_with(packet, ImportOptions::default())
    }

    pub fn import_with(
        &mut self,
        packet: HistoryPacket,
        options: ImportOptions,
    ) -> Result<BufferUpdate, BufferError> {
        let prepared = self.prepare_import_with(packet, options)?;
        self.commit_import(prepared)
    }

    pub fn prepare_import(&self, packet: HistoryPacket) -> Result<PreparedImport, BufferError> {
        self.prepare_import_with(packet, ImportOptions::default())
    }

    pub fn prepare_import_with(
        &self,
        packet: HistoryPacket,
        options: ImportOptions,
    ) -> Result<PreparedImport, BufferError> {
        self.check_identity(&packet.identity)?;
        let meta = validate_packet(&packet)?;
        let known = self.doc.oplog_vv();
        let peer_id = self.doc.peer_id();
        if meta.partial_end_vv.get(&peer_id).copied().unwrap_or(0)
            > known.get(&peer_id).copied().unwrap_or(0)
        {
            return Err(BufferError::PeerIdCollision);
        }
        // A Loro fork contains integrated history, not pending imports. Admission
        // must inspect both or a newly arrived dependency could bypass validation.
        let trial = self.doc.fork();
        for waiting in &self.pending_imports {
            trial.import(&waiting.packet.data).map_err(crdt_error)?;
        }
        trial.import(&packet.data).map_err(crdt_error)?;
        if trial.is_shallow() {
            return Err(BufferError::UnsupportedHistory);
        }
        validate_document(&trial)?;
        let complete = trial.oplog_vv();
        let missing = |end: &VersionVector| {
            end.iter()
                .any(|(peer, end)| complete.get(peer).copied().unwrap_or(0) < *end)
        };
        let preview = ImportPreview {
            text: trial.get_text(SOURCE).to_string(),
            version: state_version(&self.identity, &trial),
            pending: missing(&meta.partial_end_vv)
                || self
                    .pending_imports
                    .iter()
                    .any(|waiting| missing(&waiting.end)),
        };
        let new_data = preview.version != self.version()
            || (meta
                .partial_end_vv
                .iter()
                .any(|(peer, end)| known.get(peer).copied().unwrap_or(0) < *end)
                && !self.pending_imports.iter().any(|waiting| {
                    waiting.packet.kind == packet.kind && waiting.packet.data == packet.data
                }));
        Ok(PreparedImport {
            owner: self.owner.clone(),
            state_revision: self.state_revision,
            before: self.version(),
            packet,
            options,
            end: meta.partial_end_vv,
            preview,
            new_data,
        })
    }

    /// Apply exactly the prepared operations to this replica. No fork, decoding
    /// preflight or policy revalidation is repeated. Stale admission is rejected
    /// before touching the Buffer; callers can prepare again against newer state.
    pub fn commit_import(&mut self, prepared: PreparedImport) -> Result<BufferUpdate, BufferError> {
        if !Arc::ptr_eq(&self.owner, &prepared.owner)
            || self.state_revision != prepared.state_revision
        {
            return Err(BufferError::StalePreparation);
        }
        let before_version = self.version();
        let before_len = self.len();
        // Preparation already knows whether integrated state will advance.
        // Pending-only admission, duplicate packets and personal undo resets
        // need no full BEFORE-text read.
        let before = (prepared.preview.version != before_version).then(|| self.snapshot());
        let old_undo = self.undo_state();
        let PreparedImport {
            packet,
            options,
            end,
            new_data,
            ..
        } = prepared;
        if new_data {
            self.undo.end_group();
            self.doc
                .import(&packet.data)
                .expect("import validated against this unchanged Buffer");
            let known = self.doc.oplog_vv();
            if end
                .iter()
                .any(|(peer, end)| known.get(peer).copied().unwrap_or(0) < *end)
            {
                self.pending_imports.push(PendingImport {
                    packet: packet.clone(),
                    end,
                });
            }
        }
        if options.reset_undo {
            self.undo.clear();
        }
        let changed = new_data || self.undo_state() != old_undo;
        let edits = before
            .as_ref()
            .map_or_else(Vec::new, |before| self.delta_since(before));
        Ok(self.finish(
            before_version,
            before_len,
            ChangeCause::Import,
            edits,
            new_data.then_some(packet),
            None,
            changed,
        ))
    }

    /// A checkpoint for joining/recovery. Per-command updates are already in
    /// BufferUpdate.operation and must not be regenerated by each caller.
    pub fn export_snapshot(&self) -> Result<HistoryPacket, BufferError> {
        Ok(HistoryPacket {
            identity: self.identity.clone(),
            kind: HistoryPacketKind::Snapshot,
            data: self
                .doc
                .export(ExportMode::Snapshot)
                .map_err(crdt_error)?
                .into(),
        })
    }

    /// Anti-entropy/catch-up, independent of producing one local command's operations.
    pub fn export_updates_since(&self, version: &Version) -> Result<HistoryPacket, BufferError> {
        self.check_identity(version.identity())?;
        Ok(HistoryPacket {
            identity: self.identity.clone(),
            kind: HistoryPacketKind::Updates,
            data: self
                .doc
                .export(ExportMode::updates(version.vector()))
                .map_err(crdt_error)?
                .into(),
        })
    }

    pub(super) fn local_counter(&self) -> i32 {
        self.doc
            .oplog_vv()
            .get(&self.doc.peer_id())
            .copied()
            .unwrap_or(0)
    }

    pub(super) fn local_operations(&self, start: i32) -> Option<HistoryPacket> {
        let end = self.local_counter();
        if start == end {
            return None;
        }
        let span = [IdSpan::new(self.doc.peer_id(), start, end)];
        Some(HistoryPacket {
            identity: self.identity.clone(),
            kind: HistoryPacketKind::Updates,
            data: self
                .doc
                .export(ExportMode::updates_in_range(&span[..]))
                .expect("valid local operation span")
                .into(),
        })
    }

    fn historical_branch(&self, version: &Version) -> Result<LoroDoc, BufferError> {
        self.check_identity(version.identity())?;
        let wanted = version.vector();
        let frontiers = self.doc.vv_to_frontiers(wanted);
        if self.doc.frontiers_to_vv(&frontiers).as_ref() != Some(wanted) {
            return Err(BufferError::InvalidVersion);
        }
        let branch = self.doc.fork_at(&frontiers).map_err(crdt_error)?;
        if &branch.state_vv() != wanted {
            return Err(BufferError::InvalidVersion);
        }
        Ok(branch)
    }

    /// Read an exact available causal state after validating its history identity.
    /// No document or branch handle escapes this operation.
    pub fn historical_text(&self, version: &Version) -> Result<String, BufferError> {
        Ok(self
            .historical_branch(version)?
            .get_text(SOURCE)
            .to_string())
    }

    /// Prepare an isolated rewrite from an exact historical state and its text.
    /// Computing it returns operations; only an explicit import changes this Buffer.
    pub fn prepare_text_change(
        &self,
        base: &Version,
        expected: &str,
    ) -> Result<TextChangeTask, BufferError> {
        let branch = self.historical_branch(base)?;
        if branch.get_text(SOURCE).to_string() != expected {
            return Err(BufferError::InvalidVersion);
        }
        loop {
            let peer_id = new_peer_id();
            if peer_id != self.doc.peer_id() && self.doc.oplog_vv().get(&peer_id).is_none() {
                branch.set_peer_id(peer_id).map_err(crdt_error)?;
                break;
            }
        }
        Ok(TextChangeTask::new(
            Self::attach(self.identity.clone(), branch),
            base.clone(),
            expected.into(),
        ))
    }
}

impl Version {
    pub fn encode(&self) -> Result<Vec<u8>, BufferError> {
        Ok(self.vector().encode())
    }
    pub fn decode(identity: DocumentIdentity, bytes: &[u8]) -> Result<Self, BufferError> {
        validate_identity(&identity)?;
        let vector = VersionVector::decode(bytes).map_err(|_| BufferError::InvalidVersion)?;
        Self::from_vector(identity, vector)
    }
}

impl HistoryPacket {
    pub fn from_binary(identity: DocumentIdentity, data: Vec<u8>) -> Result<Self, BufferError> {
        validate_identity(&identity)?;
        let meta = LoroDoc::decode_import_blob_meta(&data, true).map_err(crdt_error)?;
        let kind = match meta.mode {
            EncodedBlobMode::Snapshot => HistoryPacketKind::Snapshot,
            EncodedBlobMode::Updates => HistoryPacketKind::Updates,
            EncodedBlobMode::ShallowSnapshot => return Err(BufferError::UnsupportedHistory),
            _ => return Err(BufferError::InvalidPacket),
        };
        Ok(Self {
            identity,
            kind,
            data: data.into(),
        })
    }
}

pub(super) fn state_version(identity: &DocumentIdentity, doc: &LoroDoc) -> Version {
    Version::from_vector(identity.clone(), doc.state_vv()).expect("valid integrated causal version")
}
pub(super) fn validate_document(doc: &LoroDoc) -> Result<(), BufferError> {
    let loro::LoroValue::Map(roots) = doc.get_value() else {
        return Err(BufferError::InvalidPacket);
    };
    if roots.iter().any(|(name, value)| {
        name != SOURCE
            || !matches!(value, loro::LoroValue::Container(id) if *id == doc.get_text(SOURCE).id())
    }) {
        return Err(BufferError::InvalidPacket);
    }
    Ok(())
}
pub(super) fn validate_identity(identity: &DocumentIdentity) -> Result<(), BufferError> {
    if identity.document_id.is_empty() || identity.history_id.is_empty() {
        Err(BufferError::InvalidIdentity)
    } else {
        Ok(())
    }
}
pub(super) fn validate_packet(
    packet: &HistoryPacket,
) -> Result<loro::ImportBlobMetadata, BufferError> {
    let meta = LoroDoc::decode_import_blob_meta(&packet.data, true).map_err(crdt_error)?;
    match (packet.kind, meta.mode) {
        (HistoryPacketKind::Snapshot, EncodedBlobMode::Snapshot)
        | (HistoryPacketKind::Updates, EncodedBlobMode::Updates) => Ok(meta),
        (_, EncodedBlobMode::ShallowSnapshot) => Err(BufferError::UnsupportedHistory),
        _ => Err(BufferError::InvalidPacket),
    }
}
