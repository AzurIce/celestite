//! Read-only Git status values shared by the native hosts and the Web UI.
//!
//! The types live here so both serialization boundaries use one declaration.
//! Repository discovery and status scanning belong to `celestite-git`; core
//! never interprets Git state or changes text/save behavior based on it.
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "wasm", derive(tsify::Tsify))]
pub enum GitChange {
    Unmodified,
    Modified,
    TypeChanged,
    Added,
    Deleted,
    Renamed,
    Copied,
    Unmerged,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "wasm", derive(tsify::Tsify))]
#[cfg_attr(feature = "wasm", tsify(missing_as_null))]
pub struct GitStatusEntry {
    /// Vault-relative path with `/` separators.
    pub path: String,
    pub index: GitChange,
    pub worktree: GitChange,
    /// Present in the working tree but not tracked by Git.
    #[serde(default)]
    pub untracked: bool,
    /// The entry has unresolved merge stages.
    #[serde(default)]
    pub conflict: bool,
}

/// A complete scan of the repository containing the Vault root.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "wasm", derive(tsify::Tsify))]
#[cfg_attr(feature = "wasm", tsify(missing_as_null))]
pub struct GitStatusSnapshot {
    /// Current branch, or `None` when HEAD is detached or unborn.
    #[serde(default)]
    pub branch: Option<String>,
    /// Sorted, de-duplicated entries below the Vault root.
    pub entries: Vec<GitStatusEntry>,
    /// The host stopped after its entry limit; further entries are omitted.
    #[serde(default)]
    pub truncated: bool,
}
