//! History exchange and admission. No transport or persistence policy lives here.
use super::*;
use loro::{ContainerTrait, EncodedBlobMode, ExportMode, IdSpan, VersionVector};

pub(super) struct PendingImport {
    pub packet: SyncPacket,
    pub end: VersionVector,
}

/// Read-only admission result tied to exactly one unchanged Buffer. It cannot
/// be fabricated, serialized or cloned. Dropping it discards the preparation.
#[derive(Debug)]
pub struct PreparedImport {
    owner: Arc<()>,
    revision: u64,
    before: Version,
    input: Import,
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
    pub fn packet(&self) -> &SyncPacket {
        &self.input.packet
    }
    pub fn accepts_operations(&self) -> bool {
        self.new_data
    }
}

impl Buffer {
    pub fn prepare_import(&self, input: Import) -> Result<PreparedImport, CoreError> {
        self.check_identity(&input.packet.identity)?;
        let meta = validate_packet(&input.packet)?;
        let known = self.doc.oplog_vv();
        let writer = self.doc.peer_id();
        if meta.partial_end_vv.get(&writer).copied().unwrap_or(0)
            > known.get(&writer).copied().unwrap_or(0)
        {
            return Err(CoreError::WriterCollision);
        }
        // A Loro fork contains integrated history, not pending imports. Admission
        // must inspect both or a newly arrived dependency could bypass validation.
        let trial = self.doc.fork();
        for waiting in &self.pending_imports {
            trial.import(&waiting.packet.data).map_err(crdt_error)?;
        }
        trial.import(&input.packet.data).map_err(crdt_error)?;
        if trial.is_shallow() {
            return Err(CoreError::UnsupportedHistory);
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
                    waiting.packet.kind == input.packet.kind
                        && waiting.packet.data == input.packet.data
                }));
        Ok(PreparedImport {
            owner: self.owner.clone(),
            revision: self.revision,
            before: self.version(),
            input,
            end: meta.partial_end_vv,
            preview,
            new_data,
        })
    }

    /// Apply exactly the prepared operations to this replica. No fork, decoding
    /// preflight or policy revalidation is repeated. Stale admission is rejected
    /// before touching the Buffer; callers can prepare again against newer state.
    pub fn commit_import(&mut self, prepared: PreparedImport) -> Result<BufferUpdate, CoreError> {
        if !Arc::ptr_eq(&self.owner, &prepared.owner) || self.revision != prepared.revision {
            return Err(CoreError::StalePreparation);
        }
        let before = self.snapshot();
        let old_undo = self.undo_state();
        let PreparedImport {
            input,
            end,
            new_data,
            ..
        } = prepared;
        if new_data {
            self.undo.end_group();
            self.doc
                .import_with(&input.packet.data, &input.origin)
                .expect("import validated against this unchanged Buffer");
            let known = self.doc.oplog_vv();
            if end
                .iter()
                .any(|(peer, end)| known.get(peer).copied().unwrap_or(0) < *end)
            {
                self.pending_imports.push(PendingImport {
                    packet: input.packet.clone(),
                    end,
                });
            }
        }
        if input.reset_undo {
            self.undo.clear();
        }
        let changed = new_data || self.undo_state() != old_undo;
        Ok(self.finish(
            before,
            ChangeCause::Import {
                origin: input.origin,
            },
            None,
            new_data.then_some(input.packet),
            None,
            changed,
        ))
    }

    /// A checkpoint for joining/recovery. Per-command updates are already in
    /// BufferUpdate.operation and must not be regenerated by each caller.
    pub fn export_snapshot(&self) -> Result<SyncPacket, CoreError> {
        Ok(SyncPacket {
            identity: self.identity.clone(),
            kind: PacketKind::Snapshot,
            data: self
                .doc
                .export(ExportMode::Snapshot)
                .map_err(crdt_error)?
                .into(),
        })
    }

    /// Anti-entropy/catch-up, independent of producing one local command's operations.
    pub fn export_updates_since(&self, version: &Version) -> Result<SyncPacket, CoreError> {
        self.check_identity(&version.identity)?;
        Ok(SyncPacket {
            identity: self.identity.clone(),
            kind: PacketKind::Updates,
            data: self
                .doc
                .export(ExportMode::updates(&version_vector(version)?))
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

    pub(super) fn local_operations(&self, start: i32) -> Option<SyncPacket> {
        let end = self.local_counter();
        if start == end {
            return None;
        }
        let span = [IdSpan::new(self.doc.peer_id(), start, end)];
        Some(SyncPacket {
            identity: self.identity.clone(),
            kind: PacketKind::Updates,
            data: self
                .doc
                .export(ExportMode::updates_in_range(&span[..]))
                .expect("valid local operation span")
                .into(),
        })
    }

    fn historical_branch(&self, version: &Version) -> Result<LoroDoc, CoreError> {
        self.check_identity(&version.identity)?;
        let wanted = version_vector(version)?;
        let frontiers = self.doc.vv_to_frontiers(&wanted);
        if self.doc.frontiers_to_vv(&frontiers).as_ref() != Some(&wanted) {
            return Err(CoreError::InvalidVersion);
        }
        let branch = self.doc.fork_at(&frontiers).map_err(crdt_error)?;
        if branch.state_vv() != wanted {
            return Err(CoreError::InvalidVersion);
        }
        Ok(branch)
    }

    pub(crate) fn historical_text(&self, version: &Version) -> Result<String, CoreError> {
        Ok(self
            .historical_branch(version)?
            .get_text(SOURCE)
            .to_string())
    }

    pub(crate) fn prepare_filesystem_change(
        &self,
        base: &Version,
        expected: &str,
    ) -> Result<FilesystemChange, CoreError> {
        let branch = self.historical_branch(base)?;
        if branch.get_text(SOURCE).to_string() != expected {
            return Err(CoreError::InvalidVersion);
        }
        loop {
            let writer = LoroDoc::new().peer_id();
            if writer != self.doc.peer_id() && self.doc.oplog_vv().get(&writer).is_none() {
                branch.set_peer_id(writer).map_err(crdt_error)?;
                break;
            }
        }
        Ok(FilesystemChange::new(
            Self::attach(self.identity.clone(), branch),
            base.clone(),
            expected.into(),
        ))
    }
}

impl Version {
    pub fn encode(&self) -> Result<Vec<u8>, CoreError> {
        validate_identity(&self.identity)?;
        Ok(version_vector(self)?.encode())
    }
    pub fn decode(identity: DocumentIdentity, bytes: &[u8]) -> Result<Self, CoreError> {
        validate_identity(&identity)?;
        let vector = VersionVector::decode(bytes).map_err(|_| CoreError::InvalidVersion)?;
        let version = Self {
            identity,
            clocks: vector
                .iter()
                .filter(|(_, count)| **count != 0)
                .map(|(peer, count)| (peer.to_string(), *count))
                .collect(),
        };
        version_vector(&version)?;
        Ok(version)
    }
}

impl SyncPacket {
    pub fn from_binary(identity: DocumentIdentity, data: Vec<u8>) -> Result<Self, CoreError> {
        validate_identity(&identity)?;
        let meta = LoroDoc::decode_import_blob_meta(&data, true).map_err(crdt_error)?;
        let kind = match meta.mode {
            EncodedBlobMode::Snapshot => PacketKind::Snapshot,
            EncodedBlobMode::Updates => PacketKind::Updates,
            EncodedBlobMode::ShallowSnapshot => return Err(CoreError::UnsupportedHistory),
            _ => return Err(CoreError::InvalidPacket),
        };
        Ok(Self {
            identity,
            kind,
            data: data.into(),
        })
    }
}

pub(super) fn state_version(identity: &DocumentIdentity, doc: &LoroDoc) -> Version {
    Version {
        identity: identity.clone(),
        clocks: doc
            .state_vv()
            .iter()
            .filter(|(_, count)| **count > 0)
            .map(|(peer, count)| (peer.to_string(), *count))
            .collect(),
    }
}
pub(super) fn validate_document(doc: &LoroDoc) -> Result<(), CoreError> {
    let loro::LoroValue::Map(roots) = doc.get_value() else {
        return Err(CoreError::InvalidPacket);
    };
    if roots.iter().any(|(name, value)| {
        name != SOURCE
            || !matches!(value, loro::LoroValue::Container(id) if *id == doc.get_text(SOURCE).id())
    }) {
        return Err(CoreError::InvalidPacket);
    }
    Ok(())
}
pub(super) fn validate_identity(identity: &DocumentIdentity) -> Result<(), CoreError> {
    if identity.document_id.is_empty() || identity.history_id.is_empty() {
        Err(CoreError::InvalidIdentity)
    } else {
        Ok(())
    }
}
pub(super) fn version_vector(version: &Version) -> Result<VersionVector, CoreError> {
    let mut vector = VersionVector::default();
    for (peer, count) in &version.clocks {
        let peer_id: u64 = peer.parse().map_err(|_| CoreError::InvalidVersion)?;
        if *count <= 0 || peer_id.to_string() != *peer {
            return Err(CoreError::InvalidVersion);
        }
        vector.insert(peer_id, *count);
    }
    Ok(vector)
}
pub(super) fn validate_packet(packet: &SyncPacket) -> Result<loro::ImportBlobMetadata, CoreError> {
    let meta = LoroDoc::decode_import_blob_meta(&packet.data, true).map_err(crdt_error)?;
    match (packet.kind, meta.mode) {
        (PacketKind::Snapshot, EncodedBlobMode::Snapshot)
        | (PacketKind::Updates, EncodedBlobMode::Updates) => Ok(meta),
        (_, EncodedBlobMode::ShallowSnapshot) => Err(CoreError::UnsupportedHistory),
        _ => Err(CoreError::InvalidPacket),
    }
}
