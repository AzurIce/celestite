use celestite_server::{build_server, Config};
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
    let config: Config = cli::Cli::parse().load(&cwd)?;
    let listen = config.server.listen;
    let ids: Vec<_> = config.vaults.iter().map(|v| v.id.clone()).collect();
    let server = build_server(config, &cwd)?;
    let listener = tokio::net::TcpListener::bind(listen).await?;
    let listen = listener.local_addr()?;
    tracing::info!(address = %listen, "Celestite server listening");
    for id in ids {
        tracing::info!(vault_id = %id, url = %format!("http://{listen}/api/v1/vaults/{id}"), "Vault available");
    }
    axum::serve(listener, server.router)
        .with_graceful_shutdown(async move {
            shutdown_signal().await;
            tracing::info!("Shutdown requested");
            server.shutdown.send_replace(true);
        })
        .await?;
    tracing::info!("Server stopped");
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
