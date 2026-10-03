use celestite_server::{build_server, Config};
use std::path::PathBuf;
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    let path = match args.as_slice() {
        [] => PathBuf::from("config.toml"),
        [flag, path] if flag == "--config" => PathBuf::from(path),
        _ => {
            eprintln!("Usage: celestite-server [--config config.toml]");
            std::process::exit(2);
        }
    }
    .canonicalize()?;
    let config: Config = toml::from_str(&std::fs::read_to_string(&path)?)?;
    let listen = config.server.listen;
    let ids: Vec<_> = config.vaults.iter().map(|v| v.id.clone()).collect();
    let server = build_server(config, path.parent().unwrap())?;
    let listener = tokio::net::TcpListener::bind(listen).await?;
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
