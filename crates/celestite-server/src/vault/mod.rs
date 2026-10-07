pub(crate) mod backend;
pub(crate) mod changes;
pub(crate) mod documents;
pub mod fs;
pub(crate) mod runtime;

use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultIdentity {
    pub id: String,
    pub history_id: String,
}

impl VaultIdentity {
    pub(crate) fn new(root: &Path, seed: &[u8; 32]) -> Self {
        let mut hash = blake3::Hasher::new_keyed(seed);
        hash.update(b"celestite vault identity v1\0");
        hash.update(root.as_os_str().as_encoded_bytes());
        Self {
            id: hash.finalize().to_hex().to_string(),
            history_id: uuid::Uuid::new_v4().to_string(),
        }
    }
}
