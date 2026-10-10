//! Read-only, versioned input for derived consumers. No preview or language policy.
use celestite_buffer::types::{TextSnapshot, Version};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "wasm", derive(tsify::Tsify))]
#[cfg_attr(feature = "wasm", tsify(missing_as_null, hashmap_as_object))]
pub struct SourceDocument {
    pub id: String,
    pub path: String,
    pub version: Version,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "wasm", derive(tsify::Tsify))]
#[cfg_attr(feature = "wasm", tsify(missing_as_null, hashmap_as_object))]
pub struct DocumentSnapshot {
    pub id: String,
    pub path: String,
    pub snapshot: TextSnapshot,
}

/// Capture one document-source state, with text only for explicitly requested IDs.
/// Empty `snapshots` is a cheap catalogue read, not a second text/history store.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "wasm", derive(tsify::Tsify))]
#[cfg_attr(feature = "wasm", tsify(missing_as_null, hashmap_as_object))]
pub struct DocumentSourceSnapshot {
    /// Advances on atomic replacement of this owner's document session.
    pub epoch: u64,
    pub documents: Vec<SourceDocument>,
    pub snapshots: Vec<DocumentSnapshot>,
}
