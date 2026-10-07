//! Two host-derived capability keys per Vault, rotated through configuration.
use crate::{failure, ApiError, HostedVault};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use std::{collections::HashMap, sync::Arc};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Permission {
    Readonly,
    Edit,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Operation {
    Read,
    Edit,
}

pub struct VaultLinks {
    pub readonly: String,
    pub edit: String,
}
impl VaultLinks {
    pub fn key(&self, permission: Permission) -> &str {
        match permission {
            Permission::Readonly => &self.readonly,
            Permission::Edit => &self.edit,
        }
    }
}

pub(crate) struct Grant {
    pub id: String,
    pub permission: Permission,
    pub vault: Arc<HostedVault>,
}
impl Grant {
    pub fn check(&self, operation: Operation) -> Result<(), ApiError> {
        if operation == Operation::Edit && self.read_only() {
            return Err(failure("PermissionDenied", "This link is read-only"));
        }
        Ok(())
    }
    pub fn read_only(&self) -> bool {
        self.permission == Permission::Readonly || self.vault.read_only
    }
}

pub(crate) fn seed(configured: Option<&str>) -> Result<[u8; 32], Box<dyn std::error::Error>> {
    match configured {
        Some(value) => {
            if value.is_empty() {
                return Err("share_key must be a non-empty string".into());
            }
            if value.len() < 32 {
                tracing::warn!(
                    len = value.len(),
                    "share_key is shorter than 32 bytes; anyone guessing it can derive both links, prefer `openssl rand -hex 32`"
                );
            }
            Ok(blake3::derive_key(
                "celestite configured share secret v1",
                value.as_bytes(),
            ))
        }
        None => {
            let mut seed = [0; 32];
            getrandom::fill(&mut seed)
                .map_err(|error| format!("Cannot generate share key: {error}"))?;
            Ok(seed)
        }
    }
}

fn derive(seed: &[u8; 32], vault: &str, permission: Permission) -> String {
    // Separate domains prevent a reader from obtaining edit access by changing the prefix.
    let purpose = match permission {
        Permission::Readonly => b"readonly".as_slice(),
        Permission::Edit => b"edit".as_slice(),
    };
    let mut nonce = 0_u64;
    loop {
        let mut hash = blake3::Hasher::new_keyed(seed);
        hash.update(b"celestite vault capability v1\0");
        hash.update(&(vault.len() as u64).to_le_bytes());
        hash.update(vault.as_bytes());
        hash.update(purpose);
        hash.update(&nonce.to_le_bytes());
        let raw = URL_SAFE_NO_PAD.encode(hash.finalize().as_bytes());
        if permission == Permission::Readonly {
            return format!("ro-{raw}");
        }
        if !raw.starts_with("ro-") {
            return raw;
        }
        nonce += 1;
    }
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
fn digest(key: &str) -> String {
    blake3::hash(key.as_bytes()).to_hex().to_string()
}

pub(crate) struct Registry {
    grants: HashMap<String, Arc<Grant>>,
}
impl Registry {
    pub fn new(
        vault: Arc<HostedVault>,
        seed: &[u8; 32],
        identity: &str,
    ) -> Result<(Self, VaultLinks), Box<dyn std::error::Error>> {
        let mut grants = HashMap::new();
        let readonly = derive(seed, identity, Permission::Readonly);
        let edit = derive(seed, identity, Permission::Edit);
        for (key, permission) in [(&readonly, Permission::Readonly), (&edit, Permission::Edit)] {
            let id = blake3::derive_key("celestite non-secret share identity v1", key.as_bytes());
            let grant = Arc::new(Grant {
                id: blake3::Hash::from_bytes(id).to_hex().to_string(),
                permission,
                vault: vault.clone(),
            });
            if grants.insert(digest(key), grant).is_some() {
                return Err("Duplicate Vault capability".into());
            }
        }
        Ok((Self { grants }, VaultLinks { readonly, edit }))
    }
    pub fn resolve(&self, key: &str) -> Result<Arc<Grant>, ApiError> {
        let permission =
            key_permission(key).ok_or_else(|| failure("NotFound", "Link not found"))?;
        let grant = self
            .grants
            .get(&digest(key))
            .cloned()
            .ok_or_else(|| failure("NotFound", "Link not found"))?;
        if grant.permission != permission {
            return Err(failure("NotFound", "Link not found"));
        }
        Ok(grant)
    }
}
