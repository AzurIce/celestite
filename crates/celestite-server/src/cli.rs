use celestite_server::{Config, ServerConfig, VaultConfig};
use clap::Parser;
use std::{
    collections::HashSet,
    net::SocketAddr,
    path::{Path, PathBuf},
};

#[derive(Parser)]
#[command(
    name = "celestite-server",
    version,
    about = "Serve directory Vaults over HTTP"
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
        alias = "allow-origin",
        value_name = "ORIGIN",
        conflicts_with = "clear_allowed_origins"
    )]
    allowed_origins: Vec<String>,
    /// Clear explicitly configured origins (the server's own origin is still allowed)
    #[arg(long)]
    clear_allowed_origins: bool,
    /// Environment variable containing the Bearer token
    #[arg(long, value_name = "VARIABLE", conflicts_with = "no_token")]
    token_env: Option<String>,
    /// Remove the configured token requirement (only allowed on loopback)
    #[arg(long)]
    no_token: bool,
    /// Serve a built Web UI from this directory
    #[arg(long, value_name = "DIRECTORY", conflicts_with = "no_web")]
    web_dir: Option<PathBuf>,
    /// Disable the configured static Web UI
    #[arg(long)]
    no_web: bool,
    /// Add a Vault or override its directory; repeat for multiple Vaults
    #[arg(long, value_name = "ID=PATH", value_parser = parse_assignment)]
    vault: Vec<Assignment>,
    /// Override a Vault's display name; repeat for multiple Vaults
    #[arg(long, value_name = "ID=NAME", value_parser = parse_assignment)]
    vault_name: Vec<Assignment>,
    /// Override a Vault's read-only state; repeat for multiple Vaults
    #[arg(long, value_name = "ID=true|false", value_parser = parse_read_only)]
    vault_read_only: Vec<ReadOnly>,
}

#[derive(Clone)]
struct Assignment {
    id: String,
    value: String,
}
#[derive(Clone)]
struct ReadOnly {
    id: String,
    value: bool,
}

fn parse_assignment(value: &str) -> Result<Assignment, String> {
    let (id, value) = value.split_once('=').ok_or("Expected ID=VALUE")?;
    if id.is_empty()
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err("Vault IDs must contain only ASCII letters, digits, - or _".into());
    }
    if value.trim().is_empty() {
        return Err("The value after = must not be empty".into());
    }
    Ok(Assignment {
        id: id.into(),
        value: value.into(),
    })
}
fn parse_read_only(value: &str) -> Result<ReadOnly, String> {
    let assignment = parse_assignment(value)?;
    Ok(ReadOnly {
        id: assignment.id,
        value: assignment
            .value
            .parse()
            .map_err(|_| "Read-only must be true or false")?,
    })
}

impl Cli {
    pub fn load(self, cwd: &Path) -> Result<Config, Box<dyn std::error::Error>> {
        let path = match self.config {
            Some(path) => Some(cwd.join(path)),
            None if !self.no_config => {
                let path = cwd.join("config.toml");
                match path.try_exists()? {
                    true => Some(path),
                    false => None,
                }
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
            for vault in &mut config.vaults {
                vault.path = base.join(&vault.path);
            }
            config.server.web_dir = config.server.web_dir.map(|path| base.join(path));
            config
        } else {
            if self.vault.is_empty() {
                return Err("No configuration or Vault provided. Use --config FILE or --vault ID=PATH (see --help).".into());
            }
            Config {
                server: ServerConfig::default(),
                vaults: vec![],
            }
        };
        if let Some(listen) = self.listen {
            config.server.listen = listen;
        }
        if self.clear_allowed_origins || !self.allowed_origins.is_empty() {
            config.server.allowed_origins = self.allowed_origins;
        }
        if self.no_token {
            config.server.token_env = None;
        } else if let Some(token_env) = self.token_env {
            config.server.token_env = Some(token_env);
        }
        if self.no_web {
            config.server.web_dir = None;
        } else if let Some(web_dir) = self.web_dir {
            config.server.web_dir = Some(cwd.join(web_dir));
        }

        let mut seen = HashSet::new();
        for Assignment { id, value } in self.vault {
            if !seen.insert(id.clone()) {
                return Err(format!("Duplicate --vault ID: {id}").into());
            }
            let path = cwd.join(value);
            if let Some(vault) = config.vaults.iter_mut().find(|vault| vault.id == id) {
                vault.path = path;
            } else {
                config.vaults.push(VaultConfig {
                    name: id.clone(),
                    id,
                    path,
                    read_only: false,
                });
            }
        }
        let mut seen = HashSet::new();
        for Assignment { id, value } in self.vault_name {
            if !seen.insert(id.clone()) {
                return Err(format!("Duplicate --vault-name ID: {id}").into());
            }
            find_vault(&mut config, &id)?.name = value;
        }
        let mut seen = HashSet::new();
        for ReadOnly { id, value } in self.vault_read_only {
            if !seen.insert(id.clone()) {
                return Err(format!("Duplicate --vault-read-only ID: {id}").into());
            }
            find_vault(&mut config, &id)?.read_only = value;
        }
        Ok(config)
    }
}

fn find_vault<'a>(
    config: &'a mut Config,
    id: &str,
) -> Result<&'a mut VaultConfig, Box<dyn std::error::Error>> {
    config
        .vaults
        .iter_mut()
        .find(|vault| vault.id == id)
        .ok_or_else(|| {
            format!("Unknown Vault ID: {id}; declare it in config or with --vault").into()
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::{error::ErrorKind, CommandFactory};

    fn config_file(base: &Path) {
        std::fs::write(
            base.join("config.toml"),
            r#"
[server]
listen = "127.0.0.1:8000"
allowed_origins = ["http://old.example"]
token_env = "OLD_TOKEN"
web_dir = "assets"
[[vaults]]
id = "notes"
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
        for args in [
            vec!["server", "--listen", "invalid"],
            vec!["server", "--vault", "bad/id=notes"],
            vec!["server", "--vault", "notes="],
            vec!["server", "--vault-read-only", "notes=maybe"],
            vec!["server", "--config", "config.toml", "--no-config"],
            vec!["server", "--token-env", "TOKEN", "--no-token"],
            vec!["server", "--web-dir", "assets", "--no-web"],
            vec![
                "server",
                "--allowed-origin",
                "http://client",
                "--clear-allowed-origins",
            ],
        ] {
            assert!(Cli::try_parse_from(args).is_err());
        }
    }

    #[test]
    fn cli_only_uses_defaults_and_supports_multiple_vaults() {
        let cwd = tempfile::tempdir().unwrap();
        let config = Cli::try_parse_from([
            "server",
            "--vault",
            "notes=notes",
            "--vault",
            "work=path=with=equals",
            "--vault-name",
            "notes=我的笔记",
            "--vault-read-only",
            "work=true",
        ])
        .unwrap()
        .load(cwd.path())
        .unwrap();
        assert_eq!(config.server.listen, ServerConfig::default().listen);
        assert!(config.server.token_env.is_none());
        assert_eq!(config.vaults.len(), 2);
        assert_eq!(config.vaults[0].name, "我的笔记");
        assert_eq!(config.vaults[0].path, cwd.path().join("notes"));
        assert!(!config.vaults[0].read_only);
        assert_eq!(config.vaults[1].path, cwd.path().join("path=with=equals"));
        assert!(config.vaults[1].read_only);
    }

    #[test]
    fn overrides_preserve_config_paths_and_vault_identity() {
        let cwd = tempfile::tempdir().unwrap();
        let config_dir = cwd.path().join("configuration");
        std::fs::create_dir(&config_dir).unwrap();
        config_file(&config_dir);
        let file = config_dir.join("config.toml");
        let args = [
            "server",
            "--config",
            file.to_str().unwrap(),
            "--listen",
            "127.0.0.1:9000",
            "--allowed-origin",
            "http://first.example",
            "--allowed-origin",
            "https://second.example",
            "--token-env",
            "NEW_TOKEN",
            "--vault",
            "work=work",
            "--vault-read-only",
            "notes=false",
        ];
        let config = Cli::try_parse_from(args).unwrap().load(cwd.path()).unwrap();
        assert_eq!(config.server.listen, "127.0.0.1:9000".parse().unwrap());
        assert_eq!(
            config.server.allowed_origins,
            ["http://first.example", "https://second.example"]
        );
        assert_eq!(config.server.token_env.as_deref(), Some("NEW_TOKEN"));
        assert_eq!(config.server.web_dir, Some(config_dir.join("assets")));
        assert_eq!(config.vaults[0].path, config_dir.join("notes"));
        assert_eq!(config.vaults[0].name, "笔记");
        assert!(!config.vaults[0].read_only);
        assert_eq!(config.vaults[1].path, cwd.path().join("work"));

        let config = Cli::try_parse_from([
            "server",
            "--config",
            file.to_str().unwrap(),
            "--web-dir",
            "new-assets",
            "--vault",
            "notes=new-notes",
        ])
        .unwrap()
        .load(cwd.path())
        .unwrap();
        assert_eq!(config.server.web_dir, Some(cwd.path().join("new-assets")));
        assert_eq!(config.vaults[0].path, cwd.path().join("new-notes"));
        assert_eq!(config.vaults[0].name, "笔记");
        assert!(config.vaults[0].read_only);
    }

    #[test]
    fn default_file_and_explicit_clears() {
        let cwd = tempfile::tempdir().unwrap();
        config_file(cwd.path());
        let config = Cli::try_parse_from(["server"])
            .unwrap()
            .load(cwd.path())
            .unwrap();
        assert_eq!(config.vaults[0].path, cwd.path().join("notes"));
        let config = Cli::try_parse_from([
            "server",
            "--no-token",
            "--no-web",
            "--clear-allowed-origins",
        ])
        .unwrap()
        .load(cwd.path())
        .unwrap();
        assert!(config.server.token_env.is_none());
        assert!(config.server.web_dir.is_none());
        assert!(config.server.allowed_origins.is_empty());
        let config = Cli::try_parse_from(["server", "--no-config", "--vault", "work=work"])
            .unwrap()
            .load(cwd.path())
            .unwrap();
        assert_eq!(config.vaults.len(), 1);
        assert_eq!(config.vaults[0].id, "work");
    }

    #[test]
    fn invalid_merges_never_silently_fall_back() {
        let cwd = tempfile::tempdir().unwrap();
        for args in [
            vec!["server"],
            vec![
                "server",
                "--config",
                "missing.toml",
                "--vault",
                "notes=notes",
            ],
            vec!["server", "--vault", "notes=a", "--vault", "notes=b"],
            vec!["server", "--vault", "notes=a", "--vault-name", "other=name"],
            vec![
                "server",
                "--vault",
                "notes=a",
                "--vault-read-only",
                "other=true",
            ],
        ] {
            assert!(Cli::try_parse_from(args).unwrap().load(cwd.path()).is_err());
        }
        std::fs::write(cwd.path().join("config.toml"), "invalid TOML").unwrap();
        assert!(Cli::try_parse_from(["server", "--vault", "notes=notes"])
            .unwrap()
            .load(cwd.path())
            .is_err());
    }
}
