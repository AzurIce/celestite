//! Validate the Vault and static Web paths before serving them.
use crate::VaultConfig;
use std::path::{Path, PathBuf};

pub(crate) struct PreparedVault {
    pub config: VaultConfig,
    pub root: PathBuf,
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
    Ok((PreparedVault { config, root }, web_dir))
}
