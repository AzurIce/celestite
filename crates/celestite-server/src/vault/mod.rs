pub(crate) mod backend;
pub(crate) mod changes;
pub(crate) mod documents;
pub mod fs;
pub(crate) mod runtime;

use celestite_core::instance::Vault;
use std::path::Path;

/// Derive the stable Vault identity from the secret and canonical root.
/// The history identity is fresh for every process, so links persist but old history does not.
pub(crate) fn vault_identity(root: &Path, seed: &[u8; 32]) -> Vault {
    let mut hash = blake3::Hasher::new_keyed(seed);
    hash.update(b"celestite vault identity v1\0");
    hash.update(root.as_os_str().as_encoded_bytes());
    Vault {
        vault_id: hash.finalize().to_hex().to_string(),
        history_id: uuid::Uuid::new_v4().to_string(),
    }
}
