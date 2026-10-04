//! Logical Vault and local instance identities; runtime resources belong to EditorCore.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Vault {
    pub vault_id: String,
    pub history_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstanceIdentity {
    pub vault: Vault,
    pub instance_id: String,
}
