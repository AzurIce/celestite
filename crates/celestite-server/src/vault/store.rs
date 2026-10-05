//! Host-owned journal. A receipt covers only a committed redb transaction.
use super::fs::{Result, VaultError};
use celestite_core::{DirectoryIntent, DocumentHeader as Header, JournalEntry};
use redb::{Database, ReadableDatabase, ReadableTable, TableDefinition};
use serde::{Deserialize, Serialize};
use std::{fs, path::Path};

const META: TableDefinition<&str, &[u8]> = TableDefinition::new("editor_metadata");
const HEADERS: TableDefinition<&str, &[u8]> = TableDefinition::new("editor_documents");
const JOURNAL: TableDefinition<(&str, u64), &[u8]> = TableDefinition::new("editor_journal");

pub(crate) fn storage_error(error: impl std::fmt::Display) -> VaultError {
    VaultError::new("IO", format!("Editor storage: {error}"), "")
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultIdentity {
    pub id: String,
    pub history_id: String,
}

#[derive(Serialize, Deserialize)]
struct Metadata {
    schema: u32,
    root: String,
    identity: VaultIdentity,
}

pub(crate) struct Store {
    db: Database,
}

impl Store {
    /// Host-only capability seed; deliberately outside the document journal.
    pub fn share_seed(&self) -> Result<[u8; 32]> {
        let tx = self.db.begin_write().map_err(storage_error)?;
        let seed = {
            let mut meta = tx.open_table(META).map_err(storage_error)?;
            let existing = meta
                .get("share-seed")
                .map_err(storage_error)?
                .map(|value| value.value().to_vec());
            if let Some(bytes) = existing {
                bytes
                    .try_into()
                    .map_err(|_| storage_error("Invalid share seed"))?
            } else {
                let mut seed = [0; 32];
                getrandom::fill(&mut seed).map_err(storage_error)?;
                meta.insert("share-seed", seed.as_slice())
                    .map_err(storage_error)?;
                seed
            }
        };
        tx.commit().map_err(storage_error)?;
        Ok(seed)
    }
    pub fn instance_id(&self) -> Result<String> {
        let tx = self.db.begin_read().map_err(storage_error)?;
        let meta = tx.open_table(META).map_err(storage_error)?;
        let value = meta
            .get("instance-id")
            .map_err(storage_error)?
            .ok_or_else(|| storage_error("Missing host instance identity"))?;
        let id = String::from_utf8(value.value().to_vec()).map_err(storage_error)?;
        if uuid::Uuid::parse_str(&id).is_err() {
            return Err(storage_error("Invalid host instance identity"));
        }
        Ok(id)
    }
    pub fn directory_intent(&self) -> Result<Option<DirectoryIntent>> {
        let tx = self.db.begin_read().map_err(storage_error)?;
        let meta = tx.open_table(META).map_err(storage_error)?;
        meta.get("directory-intent")
            .map_err(storage_error)?
            .map(|value| serde_json::from_slice(value.value()).map_err(storage_error))
            .transpose()
    }
    pub fn set_directory_intent(&self, intent: Option<&DirectoryIntent>) -> Result<()> {
        let tx = self.db.begin_write().map_err(storage_error)?;
        {
            let mut meta = tx.open_table(META).map_err(storage_error)?;
            if let Some(intent) = intent {
                let bytes = serde_json::to_vec(intent).map_err(storage_error)?;
                meta.insert("directory-intent", bytes.as_slice())
                    .map_err(storage_error)?;
            } else {
                meta.remove("directory-intent").map_err(storage_error)?;
            }
        }
        tx.commit().map_err(storage_error)
    }
    /// Normal startup never creates a file, table or identity.
    pub fn open(path: &Path, root: &Path) -> Result<(Self, VaultIdentity)> {
        let metadata = fs::symlink_metadata(path).map_err(|error| {
            storage_error(format!(
            "Cannot recover {}: {error}; initialize a new profile explicitly with --init-vault ID",
            path.display()
        ))
        })?;
        if !metadata.is_file() {
            return Err(storage_error(
                "History must be a regular file, not a symlink or directory",
            ));
        }
        let db = Database::open(path).map_err(storage_error)?;
        let identity = {
            let tx = db.begin_read().map_err(storage_error)?;
            let meta = tx.open_table(META).map_err(storage_error)?;
            let bytes = meta
                .get("vault")
                .map_err(storage_error)?
                .ok_or_else(|| storage_error("Missing Vault metadata"))?;
            let record: Metadata = serde_json::from_slice(bytes.value()).map_err(storage_error)?;
            if record.schema != 1 || Some(record.root.as_str()) != root.to_str() {
                return Err(storage_error(
                    "State belongs to another Vault directory or schema",
                ));
            }
            if uuid::Uuid::parse_str(&record.identity.id).is_err()
                || uuid::Uuid::parse_str(&record.identity.history_id).is_err()
            {
                return Err(storage_error("Invalid Vault/history identity"));
            }
            tx.open_table(HEADERS).map_err(storage_error)?;
            tx.open_table(JOURNAL).map_err(storage_error)?;
            record.identity
        };
        let store = Self { db };
        store.instance_id()?;
        Ok((store, identity))
    }

    /// Exclusive creation: repeating initialization cannot overwrite an existing profile.
    pub fn initialize(path: &Path, root: &Path) -> Result<(Self, VaultIdentity)> {
        let root = root
            .to_str()
            .ok_or_else(|| storage_error("Vault root must be UTF-8"))?;
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .map_err(storage_error)?;
        let db = Database::create(path).map_err(storage_error)?;
        let tx = db.begin_write().map_err(storage_error)?;
        let identity = VaultIdentity {
            id: uuid::Uuid::new_v4().to_string(),
            history_id: uuid::Uuid::new_v4().to_string(),
        };
        {
            let record = Metadata {
                schema: 1,
                root: root.into(),
                identity: identity.clone(),
            };
            let bytes = serde_json::to_vec(&record).map_err(storage_error)?;
            let mut meta = tx.open_table(META).map_err(storage_error)?;
            meta.insert("vault", bytes.as_slice())
                .map_err(storage_error)?;
            let instance = uuid::Uuid::new_v4().to_string();
            meta.insert("instance-id", instance.as_bytes())
                .map_err(storage_error)?;
            tx.open_table(HEADERS).map_err(storage_error)?;
            tx.open_table(JOURNAL).map_err(storage_error)?;
        }
        tx.commit().map_err(storage_error)?;
        sync_directory(
            path.parent()
                .ok_or_else(|| storage_error("History has no parent"))?,
        )?;
        tracing::info!(path = %path.display(), vault_identity = %identity.id, history_id = %identity.history_id, "Initialized Vault history");
        Ok((Self { db }, identity))
    }

    /// Reset an exclusively owned, validated profile; retain its complete history as an archive.
    pub fn reset(path: &Path, root: &Path) -> Result<(Self, VaultIdentity)> {
        let (old, _) = Self::open(path, root)?;
        old.load()?;
        old.directory_intent()?;
        let parent = path
            .parent()
            .ok_or_else(|| storage_error("History has no parent"))?;
        let archive = parent.join(format!("reset-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&archive).map_err(storage_error)?;
        fs::rename(path, archive.join("history.redb")).map_err(storage_error)?;
        sync_directory(&archive)?;
        sync_directory(parent)?;
        tracing::warn!(archive = %archive.display(), "Archived old Vault history for explicit reset");
        // Keep the old database's owner lock until the new identity is committed.
        let result = Self::initialize(path, root);
        drop(old);
        result
    }

    pub fn load(&self) -> Result<Vec<(Header, Vec<JournalEntry>)>> {
        let tx = self.db.begin_read().map_err(storage_error)?;
        let headers = tx.open_table(HEADERS).map_err(storage_error)?;
        let journal = tx.open_table(JOURNAL).map_err(storage_error)?;
        let mut records = vec![];
        for item in headers.iter().map_err(storage_error)? {
            let (id, bytes) = item.map_err(storage_error)?;
            let header: Header = serde_json::from_slice(bytes.value()).map_err(storage_error)?;
            if header.id != id.value() {
                return Err(storage_error("Document key mismatch"));
            }
            let mut entries = vec![];
            for sequence in 1..=header.sequence {
                let record = journal
                    .get((header.id.as_str(), sequence))
                    .map_err(storage_error)?
                    .ok_or_else(|| storage_error("Missing journal entry"))?;
                entries.push(serde_json::from_slice(record.value()).map_err(storage_error)?);
            }
            records.push((header, entries));
        }
        Ok(records)
    }

    pub fn commit(&self, header: &Header, entry: Option<&JournalEntry>) -> Result<()> {
        self.commit_many(&[(header, entry)])
    }

    pub fn commit_many(&self, records: &[(&Header, Option<&JournalEntry>)]) -> Result<()> {
        let tx = self.db.begin_write().map_err(storage_error)?;
        {
            let mut headers = tx.open_table(HEADERS).map_err(storage_error)?;
            let mut journal = tx.open_table(JOURNAL).map_err(storage_error)?;
            for (header, entry) in records {
                let previous = headers
                    .get(header.id.as_str())
                    .map_err(storage_error)?
                    .map(|bytes| serde_json::from_slice::<Header>(bytes.value()))
                    .transpose()
                    .map_err(storage_error)?;
                let expected = previous.as_ref().map_or(0, |value| value.sequence);
                // A caller may retry after losing the successful receipt.
                if previous.as_ref().is_some_and(|value| {
                    serde_json::to_vec(value).ok() == serde_json::to_vec(header).ok()
                }) {
                    if let Some(entry) = entry {
                        let stored = journal
                            .get((header.id.as_str(), header.sequence))
                            .map_err(storage_error)?;
                        let wanted = serde_json::to_vec(entry).map_err(storage_error)?;
                        if !stored.is_some_and(|value| value.value() == wanted.as_slice()) {
                            return Err(storage_error("Retried journal content mismatch"));
                        }
                    }
                    continue;
                }
                if header.sequence != expected + u64::from(entry.is_some()) {
                    return Err(storage_error("Journal sequence mismatch"));
                }
                if let Some(entry) = entry {
                    if entry.applied != header.applied
                        || entry.packet.identity != header.seed.identity
                    {
                        return Err(storage_error("Journal identity/version mismatch"));
                    }
                    let bytes = serde_json::to_vec(entry).map_err(storage_error)?;
                    journal
                        .insert((header.id.as_str(), header.sequence), bytes.as_slice())
                        .map_err(storage_error)?;
                }
                let bytes = serde_json::to_vec(header).map_err(storage_error)?;
                headers
                    .insert(header.id.as_str(), bytes.as_slice())
                    .map_err(storage_error)?;
            }
        }
        tx.commit().map_err(storage_error)
    }
}

pub(crate) fn sync_directory(path: &Path) -> Result<()> {
    #[cfg(unix)]
    fs::File::open(path)
        .and_then(|file| file.sync_all())
        .map_err(storage_error)?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}
