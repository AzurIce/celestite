use celestite_server::{Config, ServerConfig, VaultConfig};
use clap::Parser;
use std::{
    net::SocketAddr,
    path::{Path, PathBuf},
};

#[derive(Parser)]
#[command(
    name = "celestite-server",
    version,
    about = "Serve one directory Vault over HTTP"
)]
pub struct Cli {
    /// Read TOML configuration (otherwise use ./config.toml if it exists)
    #[arg(short, long, value_name = "FILE", conflicts_with = "no_config")]
    config: Option<PathBuf>,
    /// Ignore ./config.toml and use only command-line settings and defaults
    #[arg(long)]
    no_config: bool,
    /// Listening address (default: 127.0.0.1:7437)
    #[arg(long, value_name = "IP:PORT")]
    listen: Option<SocketAddr>,
    /// Allowed client origin; repeat to replace the configured origin list
    #[arg(
        long = "allowed-origin",
        value_name = "ORIGIN",
        conflicts_with = "clear_allowed_origins"
    )]
    allowed_origins: Vec<String>,
    /// Clear explicitly configured origins (the server's own origin is still allowed)
    #[arg(long)]
    clear_allowed_origins: bool,
    /// Public HTTP(S) origin/deployment prefix used in startup connection URLs
    #[arg(long, value_name = "URL")]
    public_url: Option<String>,
    /// Serve a built Web UI from this directory
    #[arg(long, value_name = "DIRECTORY", conflicts_with = "no_web")]
    web_dir: Option<PathBuf>,
    /// Disable the configured static Web UI
    #[arg(long)]
    no_web: bool,
    /// Vault directory; required without a configuration file
    #[arg(long, value_name = "PATH")]
    vault: Option<PathBuf>,
    /// Override the Vault's display name (default: Vault)
    #[arg(long, value_name = "NAME")]
    name: Option<String>,
    /// Share secret of at least 32 bytes; omitted keys generate temporary links
    #[arg(long, value_name = "KEY")]
    share_key: Option<String>,
    /// Override the Vault's read-only state
    #[arg(long, value_name = "true|false")]
    read_only: Option<bool>,
}

impl Cli {
    pub fn load(self, cwd: &Path) -> Result<Config, Box<dyn std::error::Error>> {
        let path = match self.config {
            Some(path) => Some(cwd.join(path)),
            None if !self.no_config => {
                let path = cwd.join("config.toml");
                path.try_exists()?.then_some(path)
            }
            None => None,
        };
        let mut config = if let Some(path) = path {
            let path = path.canonicalize()?;
            let text = std::fs::read_to_string(&path).map_err(|error| {
                format!("Cannot read configuration {}: {error}", path.display())
            })?;
            let mut config: Config = toml::from_str(&text)
                .map_err(|error| format!("Invalid configuration {}: {error}", path.display()))?;
            // Resolve before overrides so config and CLI retain their own path bases.
            let base = path
                .parent()
                .ok_or("Configuration has no parent directory")?;
            config.vault.path = base.join(config.vault.path);
            config.server.web_dir = config.server.web_dir.map(|path| base.join(path));
            config
        } else {
            let vault = self.vault.as_ref().ok_or("No configuration or Vault provided. Use --config FILE or --vault PATH (see --help).")?;
            Config {
                server: ServerConfig::default(),
                vault: VaultConfig {
                    path: cwd.join(vault),
                    ..Default::default()
                },
            }
        };
        if let Some(listen) = self.listen {
            config.server.listen = listen;
        }
        if self.clear_allowed_origins || !self.allowed_origins.is_empty() {
            config.server.allowed_origins = self.allowed_origins;
        }
        if let Some(url) = self.public_url {
            config.server.public_url = Some(url);
        }
        if self.no_web {
            config.server.web_dir = None;
        } else if let Some(path) = self.web_dir {
            config.server.web_dir = Some(cwd.join(path));
        }
        if let Some(path) = self.vault {
            config.vault.path = cwd.join(path);
        }
        if let Some(name) = self.name {
            config.vault.name = name;
        }
        if let Some(key) = self.share_key {
            config.vault.share_key = Some(key);
        }
        if let Some(read_only) = self.read_only {
            config.vault.read_only = read_only;
        }
        Ok(config)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::{error::ErrorKind, CommandFactory};
    const KEY: &str = "0123456789abcdef0123456789abcdef";
    fn config_file(base: &Path) {
        std::fs::write(
            base.join("config.toml"),
            r#"
[server]
listen = "127.0.0.1:8000"
allowed_origins = ["http://old.example"]
public_url = "https://share.example/deploy"
web_dir = "assets"
[vault]
name = "笔记"
path = "notes"
read_only = true
"#,
        )
        .unwrap();
    }
    #[test]
    fn clap_help_and_invalid_arguments() {
        Cli::command().debug_assert();
        assert_eq!(
            Cli::try_parse_from(["server", "--help"])
                .err()
                .unwrap()
                .kind(),
            ErrorKind::DisplayHelp
        );
        assert_eq!(
            Cli::try_parse_from(["server", "--version"])
                .err()
                .unwrap()
                .kind(),
            ErrorKind::DisplayVersion
        );
        for extra in [
            vec!["--listen", "invalid"],
            vec!["--read-only", "maybe"],
            vec!["--config", "config.toml", "--no-config"],
            vec!["--vault", "a", "--vault", "b"],
            vec!["--share-key", KEY, "--share-key", KEY],
            vec!["--web-dir", "assets", "--no-web"],
            vec![
                "--allowed-origin",
                "http://client",
                "--clear-allowed-origins",
            ],
            vec!["--state-dir", "state"],
            vec!["--ephemeral"],
            vec!["--init-vault"],
            vec!["--reset-vault"],
            vec!["--vault-name", "notes=name"],
            vec!["--vault-share-key", "notes=secret"],
            vec!["--vault-state-dir", "notes=state"],
            vec!["--ephemeral-vault", "notes"],
            vec!["--token-env", "TOKEN"],
        ] {
            let mut args = vec!["server"];
            args.extend(extra);
            assert!(Cli::try_parse_from(args).is_err());
        }
    }
    #[test]
    fn cli_only_accepts_one_directory_and_optional_share_key() {
        let cwd = tempfile::tempdir().unwrap();
        let config = Cli::try_parse_from([
            "server",
            "--vault",
            "path=with=equals",
            "--share-key",
            KEY,
            "--name",
            "我的笔记",
            "--read-only",
            "true",
        ])
        .unwrap()
        .load(cwd.path())
        .unwrap();
        assert_eq!(config.server.listen, ServerConfig::default().listen);
        assert_eq!(config.vault.path, cwd.path().join("path=with=equals"));
        assert_eq!(config.vault.name, "我的笔记");
        assert_eq!(config.vault.share_key.as_deref(), Some(KEY));
        assert!(config.vault.read_only);
        assert!(Cli::try_parse_from(["server", "--vault", "notes"])
            .unwrap()
            .load(cwd.path())
            .unwrap()
            .vault
            .share_key
            .is_none());
    }
    #[test]
    fn overrides_preserve_config_and_cli_path_bases() {
        let cwd = tempfile::tempdir().unwrap();
        let base = cwd.path().join("configuration");
        std::fs::create_dir(&base).unwrap();
        config_file(&base);
        let file = base.join("config.toml");
        let config = Cli::try_parse_from([
            "server",
            "--config",
            file.to_str().unwrap(),
            "--vault",
            "new-notes",
            "--web-dir",
            "new-assets",
            "--share-key",
            KEY,
            "--read-only",
            "false",
            "--listen",
            "127.0.0.1:9000",
            "--allowed-origin",
            "https://client.example",
            "--public-url",
            "https://override.example/deploy",
        ])
        .unwrap()
        .load(cwd.path())
        .unwrap();
        assert_eq!(config.vault.path, cwd.path().join("new-notes"));
        assert_eq!(config.server.web_dir, Some(cwd.path().join("new-assets")));
        assert_eq!(config.vault.name, "笔记");
        assert!(!config.vault.read_only);
        assert_eq!(config.vault.share_key.as_deref(), Some(KEY));
        assert_eq!(config.server.listen, "127.0.0.1:9000".parse().unwrap());
        assert_eq!(config.server.allowed_origins, ["https://client.example"]);
        assert_eq!(
            config.server.public_url.as_deref(),
            Some("https://override.example/deploy")
        );
        let config = Cli::try_parse_from(["server", "--config", file.to_str().unwrap()])
            .unwrap()
            .load(cwd.path())
            .unwrap();
        assert_eq!(config.vault.path, base.join("notes"));
        assert_eq!(config.server.web_dir, Some(base.join("assets")));
        assert!(config.vault.share_key.is_none());
        let text = std::fs::read_to_string(&file).unwrap();
        std::fs::write(&file, text + &format!("share_key = \"{KEY}\"\n")).unwrap();
        assert_eq!(
            Cli::try_parse_from(["server", "--config", file.to_str().unwrap()])
                .unwrap()
                .load(cwd.path())
                .unwrap()
                .vault
                .share_key
                .as_deref(),
            Some(KEY)
        );
    }
    #[test]
    fn default_file_and_explicit_clears() {
        let cwd = tempfile::tempdir().unwrap();
        config_file(cwd.path());
        let load = |extra: &[&str]| {
            let mut args = vec!["server"];
            args.extend_from_slice(extra);
            Cli::try_parse_from(args).unwrap().load(cwd.path()).unwrap()
        };
        assert_eq!(load(&[]).vault.path, cwd.path().join("notes"));
        let config = load(&["--no-web", "--clear-allowed-origins"]);
        assert!(config.server.web_dir.is_none() && config.server.allowed_origins.is_empty());
        let config = load(&["--no-config", "--vault", "other", "--share-key", KEY]);
        assert_eq!(config.vault.name, "Vault");
        assert!(!config.vault.read_only);
    }
    #[test]
    fn invalid_files_never_silently_fall_back() {
        let cwd = tempfile::tempdir().unwrap();
        for args in [
            vec!["server"],
            vec![
                "server",
                "--config",
                "missing.toml",
                "--vault",
                "notes",
                "--share-key",
                KEY,
            ],
        ] {
            assert!(Cli::try_parse_from(args).unwrap().load(cwd.path()).is_err());
        }
        std::fs::write(cwd.path().join("config.toml"), "invalid TOML").unwrap();
        assert!(
            Cli::try_parse_from(["server", "--vault", "notes", "--share-key", KEY])
                .unwrap()
                .load(cwd.path())
                .is_err()
        );
    }
}
