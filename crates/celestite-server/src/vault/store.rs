//! Host-owned journal. A receipt covers only a committed redb transaction.
use super::documents::{Header, JournalEntry};
use super::fs::{Result, VaultError};
use redb::{Database, ReadableDatabase, ReadableTable, TableDefinition};
use serde::{Deserialize, Serialize};
use std::path::Path;

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
    pub fn open(path: &Path, root: &Path) -> Result<(Self, VaultIdentity)> {
        let db = Database::create(path).map_err(storage_error)?;
        let tx = db.begin_write().map_err(storage_error)?;
        let identity;
        {
            let mut meta = tx.open_table(META).map_err(storage_error)?;
            let existing = meta
                .get("vault")
                .map_err(storage_error)?
                .map(|bytes| bytes.value().to_vec());
            let root = root
                .to_str()
                .ok_or_else(|| storage_error("Vault root must be UTF-8"))?;
            let record: Metadata = if let Some(bytes) = existing {
                let record: Metadata = serde_json::from_slice(&bytes).map_err(storage_error)?;
                if record.schema != 1 || record.root != root {
                    return Err(storage_error(
                        "State belongs to another Vault directory or schema",
                    ));
                }
                record
            } else {
                Metadata {
                    schema: 1,
                    root: root.into(),
                    identity: VaultIdentity {
                        id: uuid::Uuid::new_v4().to_string(),
                        history_id: uuid::Uuid::new_v4().to_string(),
                    },
                }
            };
            let bytes = serde_json::to_vec(&record).map_err(storage_error)?;
            meta.insert("vault", bytes.as_slice())
                .map_err(storage_error)?;
            identity = record.identity;
            tx.open_table(HEADERS).map_err(storage_error)?;
            tx.open_table(JOURNAL).map_err(storage_error)?;
        }
        tx.commit().map_err(storage_error)?;
        Ok((Self { db }, identity))
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
