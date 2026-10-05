use celestite_server::{build_server, Config, HistoryMode};
use clap::Parser;
use std::{io::IsTerminal, process::ExitCode};
use tracing_subscriber::{filter::LevelFilter, EnvFilter};
mod cli;

#[tokio::main]
async fn main() -> ExitCode {
    if let Err(error) = init_tracing() {
        eprintln!("Cannot initialize logging: {error}");
        return ExitCode::FAILURE;
    }
    match run().await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            tracing::error!(%error, "Server failed");
            ExitCode::FAILURE
        }
    }
}

fn init_tracing() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let filter = EnvFilter::builder()
        .with_regex(false)
        .with_default_directive(LevelFilter::INFO.into())
        .from_env()?;
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(std::io::stderr)
        .with_ansi(std::io::stderr().is_terminal())
        .try_init()?;
    Ok(())
}

async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let cwd = std::env::current_dir()?;
    let mut cli = cli::Cli::parse();
    let command = cli.command.take();
    let config: Config = cli.load(&cwd)?;
    let socket = management_socket(&config, &cwd)?;
    if let Some(command) = command {
        return manage(command, &socket).await;
    }
    let protected_roots = config
        .vaults
        .iter()
        .map(|vault| &vault.path)
        .chain(config.server.web_dir.iter())
        .map(|path| cwd.join(path).canonicalize())
        .collect::<Result<Vec<_>, _>>()?;
    let listen = config.server.listen;
    let setup = config
        .vaults
        .iter()
        .any(|v| v.history_mode != HistoryMode::Recover || v.initialize_shares);
    let server = build_server(config, &cwd)?;
    if setup {
        tracing::info!(
            "Vault history setup complete; restart without initialization/reset flags to serve"
        );
        return Ok(());
    }
    let listener = tokio::net::TcpListener::bind(listen).await?;
    let listen = listener.local_addr()?;
    let (management_listener, _socket_guard) = bind_management(&socket, &protected_roots)?;
    let mut management_shutdown = server.shutdown.subscribe();
    let management_task = tokio::spawn(async move {
        axum::serve(management_listener, server.management)
            .with_graceful_shutdown(async move {
                while !*management_shutdown.borrow() {
                    if management_shutdown.changed().await.is_err() {
                        break;
                    }
                }
            })
            .await
    });
    tracing::info!(address = %listen, "Celestite server listening");
    axum::serve(listener, server.router)
        .with_graceful_shutdown(async move {
            shutdown_signal().await;
            tracing::info!("Shutdown requested");
            server.shutdown.send_replace(true);
        })
        .await?;
    management_task.await??;
    tracing::info!("Server stopped");
    Ok(())
}

fn management_socket(
    config: &Config,
    cwd: &std::path::Path,
) -> Result<std::path::PathBuf, Box<dyn std::error::Error>> {
    if let Some(path) = &config.server.management_socket {
        return Ok(cwd.join(path));
    }
    let state = config
        .vaults
        .iter()
        .find_map(|vault| vault.state_dir.as_ref())
        .or(config.server.state_dir.as_ref())
        .ok_or("Configure --management-socket for an ephemeral server")?;
    Ok(cwd.join(state).join("management/socket"))
}

struct SocketGuard(std::path::PathBuf);
impl Drop for SocketGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}
fn bind_management(
    path: &std::path::Path,
    protected_roots: &[std::path::PathBuf],
) -> Result<(tokio::net::UnixListener, SocketGuard), Box<dyn std::error::Error>> {
    use std::os::unix::fs::{DirBuilderExt, FileTypeExt, PermissionsExt};
    let parent = path
        .parent()
        .ok_or("Management socket requires a private parent directory")?;
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(parent)?;
    let metadata = std::fs::symlink_metadata(parent)?;
    if !metadata.is_dir() || metadata.permissions().mode() & 0o077 != 0 {
        return Err("Management socket directory must have mode 0700".into());
    }
    let canonical_parent = parent.canonicalize()?;
    if protected_roots
        .iter()
        .any(|root| canonical_parent.starts_with(root) || root.starts_with(&canonical_parent))
    {
        return Err(
            "Management socket directory must not overlap Vault or Web UI directories".into(),
        );
    }
    match std::fs::symlink_metadata(path) {
        Ok(metadata) => {
            if !metadata.file_type().is_socket() {
                return Err("Management socket path is occupied".into());
            }
            if std::os::unix::net::UnixStream::connect(path).is_ok() {
                return Err("Management socket is already in use".into());
            }
            std::fs::remove_file(path)?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let listener = tokio::net::UnixListener::bind(path)?;
    let guard = SocketGuard(path.into());
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    Ok((listener, guard))
}

async fn manage(
    command: cli::Command,
    socket: &std::path::Path,
) -> Result<(), Box<dyn std::error::Error>> {
    let client = reqwest::Client::builder()
        .unix_socket(socket)
        .timeout(std::time::Duration::from_secs(30))
        .build()?;
    let cli::Command::Share { action } = command;
    use cli::ShareCommand;
    let (request, base_url) = match action {
        ShareCommand::Create {
            vault,
            permission,
            label,
            base_url,
        } => {
            let url = reqwest::Url::parse(&base_url)?;
            if !matches!(url.scheme(), "http" | "https")
                || !url.username().is_empty()
                || url.password().is_some()
                || url.query().is_some()
                || url.fragment().is_some()
            {
                return Err("base-url must be an HTTP(S) origin/deployment prefix".into());
            }
            (
                client
                    .post(format!("http://localhost/vaults/{vault}/shares"))
                    .json(&serde_json::json!({"permission": permission, "label": label})),
                Some(base_url),
            )
        }
        ShareCommand::List { vault } => (
            client.get(format!("http://localhost/vaults/{vault}/shares")),
            None,
        ),
        ShareCommand::Revoke { vault, share } => (
            client.delete(format!("http://localhost/vaults/{vault}/shares/{share}")),
            None,
        ),
    };
    let response = request.send().await?.error_for_status()?;
    if response.status() == reqwest::StatusCode::NO_CONTENT {
        return Ok(());
    }
    let value: serde_json::Value = response.json().await?;
    if let Some(base) = base_url {
        let key = value["key"]
            .as_str()
            .ok_or("Invalid share creation response")?;
        println!("{}/{}", base.trim_end_matches('/'), key);
        tracing::info!(share_id = %value["share"]["id"], "Share created; preserve the URL printed to stdout");
    } else {
        println!("{}", serde_json::to_string_pretty(&value)?);
    }
    Ok(())
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .expect("install termination handler");
        tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = terminate.recv() => {} }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[tokio::test]
    async fn management_socket_is_private_and_recovers_only_stale_sockets() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("management/socket");
        let (listener, guard) = bind_management(&path, &[]).unwrap();
        assert_eq!(
            std::fs::metadata(path.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert!(bind_management(&path, &[]).is_err());
        drop(listener);
        let (recovered, replacement) = bind_management(&path, &[]).unwrap();
        drop(recovered);
        drop(replacement);
        drop(guard);
        assert!(!path.exists());
    }

    #[tokio::test]
    async fn management_socket_rejects_public_directories_and_vault_overlap() {
        let dir = tempfile::tempdir().unwrap();
        let parent = dir.path().join("public");
        std::fs::create_dir(&parent).unwrap();
        std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(bind_management(&parent.join("socket"), &[]).is_err());
        let vault = dir.path().join("vault");
        std::fs::create_dir(&vault).unwrap();
        assert!(bind_management(
            &vault.join("private/socket"),
            &[vault.canonicalize().unwrap()]
        )
        .is_err());
        let private = dir.path().join("private");
        std::fs::create_dir(&private).unwrap();
        std::fs::set_permissions(&private, std::fs::Permissions::from_mode(0o700)).unwrap();
        let path = private.join("socket");
        std::fs::write(&path, "occupied").unwrap();
        assert!(bind_management(&path, &[]).is_err());
        assert_eq!(std::fs::read_to_string(path).unwrap(), "occupied");
    }
}
