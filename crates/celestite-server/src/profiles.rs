//! Validate all configured paths before opening or initializing any history.
use crate::{HistoryMode, VaultConfig};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};

pub(crate) struct PreparedVault {
    pub config: VaultConfig,
    pub root: PathBuf,
    pub history_path: Option<PathBuf>,
}

fn overlap(a: &Path, b: &Path) -> bool {
    a.starts_with(b) || b.starts_with(a)
}

fn directory(base: &Path, path: &Path) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let path = base.join(path).canonicalize()?;
    if !path.is_dir() {
        return Err(format!("Not a directory: {}", path.display()).into());
    }
    Ok(path)
}

pub(crate) fn prepare(
    vaults: Vec<VaultConfig>,
    legacy_state: Option<&Path>,
    web_dir: Option<&Path>,
    base: &Path,
) -> Result<(Vec<PreparedVault>, Option<PathBuf>), Box<dyn std::error::Error>> {
    let web_dir = web_dir.map(|path| directory(base, path)).transpose()?;
    if web_dir
        .as_ref()
        .is_some_and(|path| !path.join("index.html").is_file())
    {
        return Err("web_dir must contain a built index.html".into());
    }
    let mut ids = HashSet::new();
    let mut prepared: Vec<PreparedVault> = vec![];
    // Only legacy profiles may share an identical state directory: their file names are distinct.
    let mut states: Vec<(PathBuf, bool)> = vec![];
    for config in vaults {
        crate::shares::seed(config.share_key.as_deref(), &[0; 32])?;
        if config.id.is_empty()
            || !config
                .id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            return Err("Vault IDs must contain only ASCII letters, digits, - or _".into());
        }
        if config.name.trim().is_empty() || !ids.insert(config.id.clone()) {
            return Err("Vault names must not be empty and IDs must be unique".into());
        }
        let root = directory(base, &config.path)?;
        if prepared.iter().any(|other| overlap(&root, &other.root)) {
            return Err("Vault directories must not overlap".into());
        }
        let history_path = if config.ephemeral {
            if config.state_dir.is_some() || config.history_mode != HistoryMode::Recover {
                return Err(format!("Vault {}: ephemeral cannot be combined with state_dir, initialization or reset", config.id).into());
            }
            None
        } else {
            let (state, legacy) = if let Some(path) = &config.state_dir {
                (directory(base, path)?, false)
            } else if let Some(path) = legacy_state {
                (directory(base, path)?, true)
            } else {
                return Err(format!("Vault {} requires state_dir; use ephemeral = true only for temporary histories", config.id).into());
            };
            if states.iter().any(|(other, other_legacy)| {
                overlap(&state, other) && !(legacy && *other_legacy && state == *other)
            }) {
                return Err("Vault state directories must not overlap".into());
            }
            let history = state.join(if legacy {
                format!("{}.redb", config.id)
            } else {
                "history.redb".into()
            });
            states.push((state, legacy));
            Some(history)
        };
        prepared.push(PreparedVault {
            config,
            root,
            history_path,
        });
    }
    for vault in &prepared {
        if states.iter().any(|(state, _)| overlap(state, &vault.root)) {
            return Err("state_dir must not overlap any Vault directory".into());
        }
        if web_dir
            .as_ref()
            .is_some_and(|web| overlap(web, &vault.root))
        {
            return Err("web_dir must not overlap any Vault directory".into());
        }
    }
    if web_dir
        .as_ref()
        .is_some_and(|web| states.iter().any(|(state, _)| overlap(state, web)))
    {
        return Err("state_dir must not overlap web_dir".into());
    }
    Ok((prepared, web_dir))
}
