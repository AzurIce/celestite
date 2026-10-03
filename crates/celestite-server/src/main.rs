use celestite_server::{build_server, Config};
use clap::Parser;
mod cli;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cwd = std::env::current_dir()?;
    let config: Config = cli::Cli::parse().load(&cwd)?;
    let listen = config.server.listen;
    let ids: Vec<_> = config.vaults.iter().map(|v| v.id.clone()).collect();
    let server = build_server(config, &cwd)?;
    let listener = tokio::net::TcpListener::bind(listen).await?;
    let listen = listener.local_addr()?;
    println!("Celestite server listening on http://{listen}");
    for id in ids {
        println!("Vault URL: http://{listen}/api/v1/vaults/{id}");
    }
    axum::serve(listener, server.router)
        .with_graceful_shutdown(async move {
            shutdown_signal().await;
            server.shutdown.send_replace(true);
        })
        .await?;
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
