//! Validate the Vault's paths before opening or initializing its history.
use crate::{HistoryMode, VaultConfig};
use std::path::{Path, PathBuf};

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
    config: VaultConfig,
    web_dir: Option<&Path>,
    base: &Path,
) -> Result<(PreparedVault, Option<PathBuf>), Box<dyn std::error::Error>> {
    crate::shares::seed(config.share_key.as_deref(), &[0; 32])?;
    if config.name.trim().is_empty() {
        return Err("Vault name must not be empty".into());
    }
    let root = directory(base, &config.path)?;
    let web_dir = web_dir.map(|path| directory(base, path)).transpose()?;
    if let Some(web) = &web_dir {
        if !web.join("index.html").is_file() {
            return Err("web_dir must contain a built index.html".into());
        }
        if overlap(web, &root) {
            return Err("web_dir must not overlap the Vault directory".into());
        }
    }
    let history_path = if config.ephemeral {
        if config.state_dir.is_some() || config.history_mode != HistoryMode::Recover {
            return Err(
                "ephemeral cannot be combined with state_dir, initialization or reset".into(),
            );
        }
        None
    } else {
        let path = config
            .state_dir
            .as_ref()
            .ok_or("Vault requires state_dir; use ephemeral = true only for temporary histories")?;
        let state = directory(base, path)?;
        if overlap(&state, &root) {
            return Err("state_dir must not overlap the Vault directory".into());
        }
        if web_dir.as_ref().is_some_and(|web| overlap(&state, web)) {
            return Err("state_dir must not overlap web_dir".into());
        }
        Some(state.join("history.redb"))
    };
    Ok((
        PreparedVault {
            config,
            root,
            history_path,
        },
        web_dir,
    ))
}
