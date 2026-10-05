//! Persistent, bearer-by-URL grants. Keys never identify a Vault or a writer.
use crate::{failure, ApiError, HostedVault};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use redb::{Database, ReadableDatabase, ReadableTable, TableDefinition};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::Path,
    sync::{Arc, Mutex, RwLock},
};
use tokio::sync::{watch, OwnedRwLockReadGuard};

const META: TableDefinition<&str, &[u8]> = TableDefinition::new("meta");
const SHARES: TableDefinition<&str, &[u8]> = TableDefinition::new("shares");

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, clap::ValueEnum)]
#[serde(rename_all = "lowercase")]
pub enum Permission {
    Readonly,
    Edit,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Share {
    pub id: String,
    pub vault_id: String,
    pub permission: Permission,
    pub label: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record {
    share: Share,
    key_hash: String,
    key_format: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedShare {
    pub share: Share,
    pub key: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Operation {
    Read,
    Edit,
}

pub(crate) struct Grant {
    pub share: Share,
    pub vault: Arc<HostedVault>,
    gate: Arc<tokio::sync::RwLock<()>>,
    revoked: watch::Sender<bool>,
}
impl Grant {
    pub async fn admit(
        self: &Arc<Self>,
        operation: Operation,
    ) -> Result<OwnedRwLockReadGuard<()>, ApiError> {
        let guard = self.gate.clone().read_owned().await;
        self.check(operation)?;
        Ok(guard)
    }
    pub fn check(&self, operation: Operation) -> Result<(), ApiError> {
        if *self.revoked.borrow() {
            return Err(failure("PermissionDenied", "Share revoked"));
        }
        if operation == Operation::Edit && self.read_only() {
            return Err(failure("PermissionDenied", "This share is read-only"));
        }
        Ok(())
    }
    pub fn read_only(&self) -> bool {
        self.share.permission == Permission::Readonly || self.vault.read_only
    }
    pub async fn cancelled(&self) {
        let mut signal = self.revoked.subscribe();
        while !*signal.borrow_and_update() {
            if signal.changed().await.is_err() {
                break;
            }
        }
    }
}

pub(crate) struct Store {
    db: Option<Database>,
    vault_id: String,
    records: Mutex<HashMap<String, Record>>,
}
impl Store {
    pub fn open(
        path: Option<&Path>,
        vault_id: &str,
        initialize: bool,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        let Some(path) = path else {
            return Ok(Self {
                db: None,
                vault_id: vault_id.into(),
                records: Mutex::new(HashMap::new()),
            });
        };
        if initialize {
            std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(path)?;
            let db = Database::create(path)?;
            let tx = db.begin_write()?;
            {
                let mut meta = tx.open_table(META)?;
                meta.insert("schema", &b"1"[..])?;
                meta.insert("vault-id", vault_id.as_bytes())?;
                tx.open_table(SHARES)?;
            }
            tx.commit()?;
            crate::vault::store::sync_directory(path.parent().ok_or("Missing share directory")?)?;
        }
        if !std::fs::symlink_metadata(path)?.is_file() {
            return Err("Share store must be a regular file".into());
        }
        let db = Database::open(path)?;
        let mut records = HashMap::new();
        {
            let tx = db.begin_read()?;
            let meta = tx.open_table(META)?;
            if meta.get("schema")?.map(|v| v.value().to_vec()).as_deref() != Some(b"1")
                || meta.get("vault-id")?.map(|v| v.value().to_vec()).as_deref()
                    != Some(vault_id.as_bytes())
            {
                return Err("Share store schema or Vault identity mismatch".into());
            }
            for entry in tx.open_table(SHARES)?.iter()? {
                let (id, bytes) = entry?;
                let record: Record = serde_json::from_slice(bytes.value())?;
                let share = &record.share;
                if share.id != id.value()
                    || uuid::Uuid::parse_str(&share.id).is_err()
                    || share.vault_id != vault_id
                    || record.key_format != key_format(share.permission)
                    || record.key_hash.len() != 64
                    || blake3::Hash::from_hex(&record.key_hash).is_err()
                {
                    return Err("Invalid share record".into());
                }
                records.insert(share.id.clone(), record);
            }
        }
        Ok(Self {
            db: Some(db),
            vault_id: vault_id.into(),
            records: Mutex::new(records),
        })
    }
    fn insert(&self, record: Record) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let mut records = self.records.lock().map_err(|_| "Share store lock failed")?;
        if let Some(db) = &self.db {
            let tx = db.begin_write()?;
            tx.open_table(SHARES)?.insert(
                record.share.id.as_str(),
                serde_json::to_vec(&record)?.as_slice(),
            )?;
            tx.commit()?;
        }
        records.insert(record.share.id.clone(), record);
        Ok(())
    }
    fn remove(&self, id: &str) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let mut records = self.records.lock().map_err(|_| "Share store lock failed")?;
        if let Some(db) = &self.db {
            let tx = db.begin_write()?;
            tx.open_table(SHARES)?.remove(id)?;
            tx.commit()?;
        }
        records.remove(id);
        Ok(())
    }
    pub fn list(&self) -> Vec<Share> {
        let mut shares: Vec<_> = self
            .records
            .lock()
            .unwrap()
            .values()
            .map(|record| record.share.clone())
            .collect();
        shares.sort_by(|a, b| a.id.cmp(&b.id));
        shares
    }
}

#[derive(Default)]
pub(crate) struct Registry {
    grants: RwLock<HashMap<String, Arc<Grant>>>,
}
pub(crate) fn key_permission(key: &str) -> Option<Permission> {
    let (raw, permission) = if let Some(raw) = key.strip_prefix("ro-") {
        (raw, Permission::Readonly)
    } else {
        (key, Permission::Edit)
    };
    if raw.len() != 43 {
        return None;
    }
    let bytes = URL_SAFE_NO_PAD.decode(raw).ok()?;
    (bytes.len() == 32 && URL_SAFE_NO_PAD.encode(&bytes) == raw).then_some(permission)
}
fn key_format(permission: Permission) -> &'static str {
    match permission {
        Permission::Readonly => "v1-ro",
        Permission::Edit => "v1-edit",
    }
}
fn digest(key: &str) -> String {
    blake3::hash(key.as_bytes()).to_hex().to_string()
}
impl Registry {
    pub fn register(&self, vault: Arc<HostedVault>) -> Result<(), Box<dyn std::error::Error>> {
        let mut grants = self
            .grants
            .write()
            .map_err(|_| "Share registry lock failed")?;
        let records: Vec<_> = vault
            .shares
            .records
            .lock()
            .unwrap()
            .values()
            .cloned()
            .collect();
        for record in records {
            let hash = record.key_hash;
            let share = record.share;
            let (revoked, _) = watch::channel(false);
            if grants
                .insert(
                    hash,
                    Arc::new(Grant {
                        share,
                        vault: vault.clone(),
                        gate: Arc::new(tokio::sync::RwLock::new(())),
                        revoked,
                    }),
                )
                .is_some()
            {
                return Err("Duplicate share credential".into());
            }
        }
        Ok(())
    }
    pub fn resolve(&self, key: &str) -> Result<Arc<Grant>, ApiError> {
        let permission =
            key_permission(key).ok_or_else(|| failure("NotFound", "Share not found"))?;
        let grant = self
            .grants
            .read()
            .map_err(|_| failure("IO", "Share registry lock failed"))?
            .get(&digest(key))
            .cloned()
            .ok_or_else(|| failure("NotFound", "Share not found"))?;
        if grant.share.permission != permission {
            return Err(failure("NotFound", "Share not found"));
        }
        grant.check(Operation::Read)?;
        Ok(grant)
    }
    pub fn create(
        &self,
        vault: Arc<HostedVault>,
        permission: Permission,
        label: String,
    ) -> Result<CreatedShare, Box<dyn std::error::Error + Send + Sync>> {
        if label.len() > 1024 {
            return Err("Share label is too long".into());
        }
        let mut grants = self
            .grants
            .write()
            .map_err(|_| "Share registry lock failed")?;
        let key = loop {
            let mut bytes = [0; 32];
            getrandom::fill(&mut bytes)?;
            let raw = URL_SAFE_NO_PAD.encode(bytes);
            if raw.starts_with("ro-") {
                continue;
            }
            let key = if permission == Permission::Readonly {
                format!("ro-{raw}")
            } else {
                raw
            };
            if !grants.contains_key(&digest(&key)) {
                break key;
            }
        };
        let share = Share {
            id: uuid::Uuid::new_v4().to_string(),
            vault_id: vault.shares.vault_id.clone(),
            permission,
            label,
        };
        let hash = digest(&key);
        vault.shares.insert(Record {
            share: share.clone(),
            key_hash: hash.clone(),
            key_format: key_format(permission).into(),
        })?;
        let (revoked, _) = watch::channel(false);
        grants.insert(
            hash,
            Arc::new(Grant {
                share: share.clone(),
                vault,
                gate: Arc::new(tokio::sync::RwLock::new(())),
                revoked,
            }),
        );
        Ok(CreatedShare { share, key })
    }
    pub async fn revoke(
        &self,
        vault: &Arc<HostedVault>,
        id: &str,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let grant = self
            .grants
            .read()
            .map_err(|_| "Share registry lock failed")?
            .values()
            .find(|g| Arc::ptr_eq(&g.vault, vault) && g.share.id == id)
            .cloned()
            .ok_or("Share not found")?;
        let _guard = grant.gate.write().await;
        if *grant.revoked.borrow() {
            return Err("Share already revoked".into());
        }
        vault.shares.remove(id)?;
        grant.revoked.send_replace(true);
        self.grants
            .write()
            .map_err(|_| "Share registry lock failed")?
            .retain(|_, value| !Arc::ptr_eq(value, &grant));
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn revocation_waits_for_admitted_work_and_rejects_queued_work() {
        let root = tempfile::tempdir().unwrap();
        let server = Arc::new(
            crate::build_server(
                crate::Config {
                    server: Default::default(),
                    vaults: vec![crate::VaultConfig {
                        id: "notes".into(),
                        name: "Notes".into(),
                        path: root.path().into(),
                        ephemeral: true,
                        ..Default::default()
                    }],
                },
                root.path(),
            )
            .unwrap(),
        );
        let share = server
            .create_share("notes", Permission::Edit, "Gate".into())
            .unwrap();
        let grant = server.state.shares.resolve(&share.key).unwrap();
        let admitted = grant.admit(Operation::Edit).await.unwrap();
        let host = server.clone();
        let id = share.share.id.clone();
        let revoke = tokio::spawn(async move { host.revoke_share("notes", &id).await.unwrap() });
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        assert!(!revoke.is_finished());
        let pending = grant.clone();
        let queued = tokio::spawn(async move { pending.admit(Operation::Edit).await.is_err() });
        drop(admitted);
        revoke.await.unwrap();
        assert!(queued.await.unwrap());
        assert!(server.state.shares.resolve(&share.key).is_err());
    }
}
