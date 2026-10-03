//! Headless document host: no view is required to discover or merge a file.
use super::{
    fs::{revision, FsVault, Result, VaultError},
    store::{storage_error, Store, VaultIdentity},
};
use celestite_core::*;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, path::Path};

pub const MAX_TEXT_BYTES: usize = 5 * 1024 * 1024;

pub(crate) fn core_error(error: CoreError) -> VaultError {
    let code = match error {
        CoreError::StaleVersion => "StaleVersion",
        CoreError::IdentityMismatch
        | CoreError::WriterCollision
        | CoreError::WriterAlreadyUsed { .. } => "Conflict",
        _ => "InvalidEdit",
    };
    VaultError::new(code, error.to_string(), "")
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct JournalEntry {
    pub packet: SyncPacket,
    pub applied: Version,
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct PendingWrite {
    text: String,
    version: Version,
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct Header {
    pub id: String,
    pub path: String,
    pub seed: SyncPacket,
    pub sequence: u64,
    pub applied: Version,
    pub saved_text: String,
    pub disk_revision: String,
    pub saved_version: Version,
    pub pending_write: Option<PendingWrite>,
    pub deleted: bool,
    pub bom: bool,
    pub line_ending: String,
}

struct Record {
    header: Header,
    document: Document,
    pending_packets: Vec<SyncPacket>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentState {
    pub id: String,
    pub path: String,
    pub snapshot: TextSnapshot,
    pub undo: UndoState,
    pub dirty: bool,
    pub deleted: bool,
    pub conflict: bool,
    pub backend_revision: String,
    pub saved_version: Version,
    pub durable_version: Option<Version>,
    pub persistence_error: Option<String>,
}

pub(crate) struct Documents {
    pub identity: VaultIdentity,
    records: BTreeMap<String, Record>,
    store: Option<Store>,
    failure: Option<String>,
}

fn decode(bytes: &[u8], path: &str) -> Result<(String, bool, String)> {
    let bom = bytes.starts_with(&[0xef, 0xbb, 0xbf]);
    let raw = std::str::from_utf8(if bom { &bytes[3..] } else { bytes })
        .map_err(|_| VaultError::new("Unsupported", "Not a UTF-8 text file", path))?;
    if raw
        .chars()
        .any(|c| c < ' ' && !matches!(c, '\n' | '\r' | '\t'))
    {
        return Err(VaultError::new(
            "Unsupported",
            "Not an editable text file",
            path,
        ));
    }
    let ending = raw
        .find(['\r', '\n'])
        .map(|i| {
            if raw[i..].starts_with("\r\n") {
                "\r\n"
            } else if raw[i..].starts_with('\r') {
                "\r"
            } else {
                "\n"
            }
        })
        .unwrap_or("\n")
        .to_string();
    Ok((raw.replace("\r\n", "\n").replace('\r', "\n"), bom, ending))
}

fn encode(header: &Header, text: &str) -> Vec<u8> {
    format!(
        "{}{}",
        if header.bom { "\u{feff}" } else { "" },
        text.replace('\n', &header.line_ending)
    )
    .into_bytes()
}

fn within(path: &str, root: &str) -> bool {
    path == root
        || path
            .strip_prefix(root)
            .is_some_and(|tail| tail.starts_with('/'))
}

impl Documents {
    pub fn open(state: Option<&Path>, root: &Path) -> Result<Self> {
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
        let mut this = Self {
            identity,
            store,
            records: BTreeMap::new(),
            failure: None,
        };
        if let Some(store) = &this.store {
            for (header, journal) in store.load()? {
                if header.seed.identity.document_id != header.id {
                    return Err(storage_error("Stored document identity mismatch"));
                }
                super::fs::validate_path(&header.path)?;
                let mut document =
                    Document::from_snapshot(&header.seed, None).map_err(core_error)?;
                let mut pending_packets = vec![];
                for entry in journal {
                    let result = document
                        .import(&entry.packet, "recovery".into())
                        .map_err(core_error)?;
                    if result.pending {
                        pending_packets.push(entry.packet.clone());
                    }
                    if document.version() != entry.applied {
                        return Err(storage_error("Recovered journal version mismatch"));
                    }
                }
                if document.version() != header.applied
                    || document.snapshot().text.len() > MAX_TEXT_BYTES
                {
                    return Err(storage_error("Invalid recovered document"));
                }
                this.records.insert(
                    header.id.clone(),
                    Record {
                        header,
                        document,
                        pending_packets,
                    },
                );
            }
        }
        Ok(this)
    }

    pub fn persistent(&self) -> bool {
        self.store.is_some()
    }

    fn writable(&self) -> Result<()> {
        if let Some(error) = &self.failure {
            return Err(storage_error(error));
        }
        Ok(())
    }

    fn persist(&mut self, id: &str, packet: Option<SyncPacket>) -> Result<()> {
        let record = self
            .records
            .get_mut(id)
            .ok_or_else(|| VaultError::new("NotFound", "Document not found", id))?;
        let entry = packet.map(|packet| {
            record.header.sequence += 1;
            record.header.applied = record.document.version();
            JournalEntry {
                packet,
                applied: record.header.applied.clone(),
            }
        });
        if let Some(store) = &self.store {
            if let Err(error) = store.commit(&record.header, entry.as_ref()) {
                self.failure = Some(error.to_string());
                return Err(error);
            }
        }
        Ok(())
    }

    fn record(&self, id: &str) -> Result<&Record> {
        self.records
            .get(id)
            .ok_or_else(|| VaultError::new("NotFound", "Document not found", id))
    }

    fn live(&self, id: &str) -> Result<()> {
        self.writable()?;
        if self.record(id)?.header.deleted {
            return Err(VaultError::new(
                "NotFound",
                "Document was deleted; its history is retained",
                id,
            ));
        }
        Ok(())
    }

    pub fn open_file(&mut self, files: &FsVault, path: &str) -> Result<String> {
        super::fs::validate_path(path)?;
        if let Some(id) = self
            .records
            .values()
            .find(|r| !r.header.deleted && r.header.path == path)
            .map(|r| r.header.id.clone())
        {
            self.refresh(files, &id)?;
            return Ok(id);
        }
        self.writable()?;
        let bytes = files.read_file_limited(path, MAX_TEXT_BYTES as u64)?;
        let (text, bom, line_ending) = decode(&bytes, path)?;
        let identity = DocumentIdentity {
            document_id: uuid::Uuid::new_v4().to_string(),
            history_id: uuid::Uuid::new_v4().to_string(),
        };
        let document = Document::new(identity.clone(), None, &text).map_err(core_error)?;
        let header = Header {
            id: identity.document_id.clone(),
            path: path.into(),
            seed: document.export_snapshot().map_err(core_error)?,
            sequence: 0,
            applied: document.version(),
            saved_text: text,
            disk_revision: revision(&bytes),
            saved_version: document.version(),
            pending_write: None,
            deleted: false,
            bom,
            line_ending,
        };
        self.records.insert(
            header.id.clone(),
            Record {
                header,
                document,
                pending_packets: vec![],
            },
        );
        self.persist(&identity.document_id, None)?;
        Ok(identity.document_id)
    }

    pub fn list(&mut self, files: &FsVault) -> Result<Vec<DocumentState>> {
        let mut pending = vec![String::new()];
        while let Some(directory) = pending.pop() {
            for entry in files.read_dir(&directory)? {
                if entry.kind == "directory" {
                    pending.push(entry.path);
                } else if entry.kind == "file" {
                    match self.open_file(files, &entry.path) {
                        Ok(_) => {}
                        Err(error) if error.code == "Unsupported" || error.code == "NotFound" => {}
                        Err(error) => return Err(error),
                    }
                }
            }
        }
        let ids: Vec<_> = self.records.keys().cloned().collect();
        let mut states = vec![];
        for id in ids {
            self.refresh(files, &id)?;
            if !self.record(&id)?.header.deleted {
                states.push(self.state(files, &id)?);
            }
        }
        states.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(states)
    }

    pub fn state(&self, files: &FsVault, id: &str) -> Result<DocumentState> {
        let record = self.record(id)?;
        let header = &record.header;
        let snapshot = record.document.snapshot();
        let disk = files
            .read_file_limited(&header.path, MAX_TEXT_BYTES as u64)
            .ok()
            .map(|bytes| revision(&bytes));
        Ok(DocumentState {
            id: id.into(),
            path: header.path.clone(),
            undo: record.document.undo_state(),
            dirty: snapshot.text != header.saved_text,
            deleted: header.deleted,
            conflict: !header.deleted && disk.as_ref() != Some(&header.disk_revision),
            snapshot,
            backend_revision: header.disk_revision.clone(),
            saved_version: header.saved_version.clone(),
            durable_version: if self.persistent() && self.failure.is_none() {
                Some(header.applied.clone())
            } else {
                None
            },
            persistence_error: self.failure.clone(),
        })
    }

    pub fn refresh_path(&mut self, files: &FsVault, path: &str) -> Result<()> {
        if let Some(id) = self
            .records
            .values()
            .find(|r| !r.header.deleted && r.header.path == path)
            .map(|r| r.header.id.clone())
        {
            self.refresh(files, &id)?;
        }
        Ok(())
    }

    pub fn refresh(&mut self, files: &FsVault, id: &str) -> Result<()> {
        let record = self.record(id)?;
        if record.header.deleted || self.failure.is_some() {
            return Ok(());
        }
        let bytes = match files.read_file_limited(&record.header.path, MAX_TEXT_BYTES as u64) {
            Ok(bytes) => bytes,
            Err(error) if matches!(error.code, "NotFound" | "NotFile" | "Unsupported") => {
                return Ok(())
            }
            Err(error) => return Err(error),
        };
        let actual = revision(&bytes);
        if let Some(pending) = &record.header.pending_write {
            if revision(&encode(&record.header, &pending.text)) == actual {
                let pending = pending.clone();
                let header = &mut self.records.get_mut(id).unwrap().header;
                header.saved_text = pending.text;
                header.saved_version = pending.version;
                header.disk_revision = actual.clone();
                header.pending_write = None;
                self.persist(id, None)?;
            }
        }
        let record = self.record(id)?;
        if actual == record.header.disk_revision
            || record.document.snapshot().text != record.header.saved_text
        {
            return Ok(());
        }
        let (text, bom, line_ending) = match decode(&bytes, &record.header.path) {
            Ok(value) => value,
            Err(_) => return Ok(()),
        };
        // External edits use another writer so the server's undo does not undo them.
        let mut external = Document::from_snapshot(
            &record.document.export_snapshot().map_err(core_error)?,
            None,
        )
        .map_err(core_error)?;
        external
            .transact(Transaction {
                expected_version: external.version(),
                origin: "filesystem".into(),
                edits: text_difference(&record.header.saved_text, &text),
                undo_metadata: None,
                undo_positions: vec![],
            })
            .map_err(core_error)?;
        let packet = external
            .export_updates_since(&record.document.version())
            .map_err(core_error)?;
        let record = self.records.get_mut(id).unwrap();
        record
            .document
            .import(&packet, "filesystem".into())
            .map_err(core_error)?;
        record.header.saved_text = text;
        record.header.disk_revision = actual;
        record.header.saved_version = record.document.version();
        record.header.bom = bom;
        record.header.line_ending = line_ending;
        record.header.pending_write = None;
        self.persist(id, Some(packet))
    }

    pub fn transact(&mut self, id: &str, transaction: Transaction) -> Result<Option<ChangeEvent>> {
        self.live(id)?;
        let record = self.record(id)?;
        let before = record.document.version();
        if transaction.expected_version != before {
            return Err(core_error(CoreError::StaleVersion));
        }
        let text = record.document.snapshot().text;
        let mut size = text.len();
        for edit in &transaction.edits {
            validate_insert(&edit.insert, id)?;
            let from = utf16_to_byte(&text, edit.from).map_err(core_error)?;
            let to = utf16_to_byte(&text, edit.to).map_err(core_error)?;
            size = size
                .checked_sub(to.saturating_sub(from))
                .and_then(|n| n.checked_add(edit.insert.len()))
                .ok_or_else(|| VaultError::new("InvalidEdit", "Invalid edit size", id))?;
        }
        if size > MAX_TEXT_BYTES {
            return Err(VaultError::new("Unsupported", "Text exceeds 5 MiB", id));
        }
        let record = self.records.get_mut(id).unwrap();
        let event = record.document.transact(transaction).map_err(core_error)?;
        if event.is_some() {
            let packet = record
                .document
                .export_updates_since(&before)
                .map_err(core_error)?;
            self.persist(id, Some(packet))?;
        }
        Ok(event)
    }

    pub fn import(&mut self, id: &str, packet: SyncPacket) -> Result<ImportResult> {
        self.writable()?;
        let record = self.record(id)?;
        if packet.data.len() > 16 * 1024 * 1024 {
            return Err(VaultError::new(
                "Unsupported",
                "CRDT packet exceeds 16 MiB",
                id,
            ));
        }
        let mut trial = Document::from_snapshot(
            &record.document.export_snapshot().map_err(core_error)?,
            None,
        )
        .map_err(core_error)?;
        for waiting in &record.pending_packets {
            trial
                .import(waiting, "validation".into())
                .map_err(core_error)?;
        }
        trial
            .import(&packet, "validation".into())
            .map_err(core_error)?;
        validate_insert(&trial.snapshot().text, id)?;
        if trial.snapshot().text.len() > MAX_TEXT_BYTES {
            return Err(VaultError::new("Unsupported", "Text exceeds 5 MiB", id));
        }
        let result = self
            .records
            .get_mut(id)
            .unwrap()
            .document
            .import(&packet, "peer".into())
            .map_err(core_error)?;
        if result.pending {
            self.records
                .get_mut(id)
                .unwrap()
                .pending_packets
                .push(packet.clone());
        }
        // Keep even causally pending packets: snapshots do not retain the waiting queue.
        self.persist(id, Some(packet))?;
        Ok(result)
    }

    pub fn undo(
        &mut self,
        id: &str,
        context: UndoContext,
        redo: bool,
    ) -> Result<Option<ChangeEvent>> {
        self.live(id)?;
        let record = self.records.get_mut(id).unwrap();
        let before = record.document.version();
        let event = if redo {
            record.document.redo_with_context(context)
        } else {
            record.document.undo_with_context(context)
        }
        .map_err(core_error)?;
        if record.document.version() != before {
            let packet = record
                .document
                .export_updates_since(&before)
                .map_err(core_error)?;
            self.persist(id, Some(packet))?;
        }
        Ok(event)
    }

    pub fn snapshot(&self, id: &str) -> Result<SyncPacket> {
        self.record(id)?
            .document
            .export_snapshot()
            .map_err(core_error)
    }
    pub fn updates(&self, id: &str, version: &Version) -> Result<SyncPacket> {
        self.record(id)?
            .document
            .export_updates_since(version)
            .map_err(core_error)
    }

    pub fn save(&mut self, files: &FsVault, id: &str, expected: Version) -> Result<()> {
        self.live(id)?;
        let record = self.record(id)?;
        if record.document.version() != expected {
            return Err(core_error(CoreError::StaleVersion));
        }
        let snapshot = record.document.snapshot();
        let path = record.header.path.clone();
        let baseline = record.header.disk_revision.clone();
        let bytes = encode(&record.header, &snapshot.text);
        // Persist intent first; recovery recognizes a write that completed before its receipt.
        self.records.get_mut(id).unwrap().header.pending_write = Some(PendingWrite {
            text: snapshot.text.clone(),
            version: snapshot.version.clone(),
        });
        self.persist(id, None)?;
        let saved = files.write_file(&path, &bytes, "replace", Some(&baseline))?;
        let header = &mut self.records.get_mut(id).unwrap().header;
        header.saved_text = snapshot.text;
        header.saved_version = snapshot.version;
        header.disk_revision = saved;
        header.pending_write = None;
        self.persist(id, None)
    }

    pub fn before_replace(&self, path: &str) -> Result<()> {
        self.writable()?;
        if self.records.values().any(|r| {
            !r.header.deleted
                && r.header.path == path
                && r.document.snapshot().text != r.header.saved_text
        }) {
            return Err(VaultError::new(
                "Conflict",
                "File has unsaved CRDT edits; use the document API",
                path,
            ));
        }
        Ok(())
    }

    pub fn rename(&mut self, files: &FsVault, from: &str, to: &str) -> Result<()> {
        self.writable()?;
        files.rename(from, to)?;
        for record in self
            .records
            .values_mut()
            .filter(|r| !r.header.deleted && within(&r.header.path, from))
        {
            record.header.path = format!("{}{}", to, &record.header.path[from.len()..]);
        }
        self.persist_headers()
    }

    pub fn remove(&mut self, files: &FsVault, path: &str, recursive: bool) -> Result<()> {
        self.writable()?;
        // Histories remain recoverable; no late save may recreate the deleted path.
        files.remove(path, recursive)?;
        for record in self
            .records
            .values_mut()
            .filter(|r| !r.header.deleted && within(&r.header.path, path))
        {
            record.header.deleted = true;
        }
        self.persist_headers()
    }

    fn persist_headers(&mut self) -> Result<()> {
        if let Some(store) = &self.store {
            let records: Vec<_> = self.records.values().map(|r| (&r.header, None)).collect();
            if let Err(error) = store.commit_many(&records) {
                self.failure = Some(error.to_string());
                return Err(error);
            }
        }
        Ok(())
    }
}

fn validate_insert(text: &str, id: &str) -> Result<()> {
    if text.chars().any(|c| c < ' ' && !matches!(c, '\n' | '\t')) {
        return Err(VaultError::new(
            "InvalidEdit",
            "Hosted text uses LF; binary control characters and CR are not accepted",
            id,
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recover_write_completed_between_intent_and_receipt() {
        let root = tempfile::tempdir().unwrap();
        let state = tempfile::tempdir().unwrap();
        let db = state.path().join("notes.redb");
        std::fs::write(root.path().join("a.md"), "old").unwrap();
        let files = FsVault::open(root.path()).unwrap();
        let mut docs = Documents::open(Some(&db), root.path()).unwrap();
        let id = docs.open_file(&files, "a.md").unwrap();
        let before = docs.record(&id).unwrap().document.version();
        docs.transact(
            &id,
            Transaction {
                expected_version: before,
                origin: "test".into(),
                edits: vec![TextEdit {
                    from: 0,
                    to: 3,
                    insert: "new".into(),
                }],
                undo_metadata: None,
                undo_positions: vec![],
            },
        )
        .unwrap();
        let record = docs.record(&id).unwrap();
        let snapshot = record.document.snapshot();
        let baseline = record.header.disk_revision.clone();
        // Stop at the same persisted boundary used by save(), before its receipt.
        docs.records.get_mut(&id).unwrap().header.pending_write = Some(PendingWrite {
            text: snapshot.text.clone(),
            version: snapshot.version.clone(),
        });
        docs.persist(&id, None).unwrap();
        files
            .write_file("a.md", b"new", "replace", Some(&baseline))
            .unwrap();
        drop(docs);

        let mut restored = Documents::open(Some(&db), root.path()).unwrap();
        restored.refresh(&files, &id).unwrap();
        let state = restored.state(&files, &id).unwrap();
        assert!(!state.dirty);
        assert!(!state.conflict);
        assert_eq!(state.saved_version, snapshot.version);
        assert_eq!(state.durable_version, Some(snapshot.version));
        assert!(restored.record(&id).unwrap().header.pending_write.is_none());
        drop(restored);

        let restored = Documents::open(Some(&db), root.path()).unwrap();
        assert!(!restored.state(&files, &id).unwrap().dirty);
    }

    #[test]
    fn state_profile_cannot_be_reused_for_another_vault_root() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let state = tempfile::tempdir().unwrap();
        let db = state.path().join("notes.redb");
        drop(Documents::open(Some(&db), first.path()).unwrap());
        assert!(Documents::open(Some(&db), second.path()).is_err());
    }
}
