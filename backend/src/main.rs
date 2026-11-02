use std::net::SocketAddr;
use std::process::ExitCode;

use homebar::config::Config;
use homebar::{AppState, build_app, db, seed};
use tracing_subscriber::EnvFilter;

fn main() -> ExitCode {
    // `homebar healthcheck` is used by the Docker HEALTHCHECK (the slim image has no curl).
    if std::env::args().nth(1).as_deref() == Some("healthcheck") {
        return healthcheck();
    }
    serve()
}

/// Plain-std HTTP GET of `/api/health` on the local port; exit 0 when it answers 200.
fn healthcheck() -> ExitCode {
    use std::io::{Read, Write};
    use std::time::Duration;

    let port = std::env::var("PORT").unwrap_or_else(|_| "8080".into());
    let probe = || -> std::io::Result<bool> {
        let addr: SocketAddr = format!("127.0.0.1:{port}")
            .parse()
            .map_err(std::io::Error::other)?;
        let mut stream = std::net::TcpStream::connect_timeout(&addr, Duration::from_secs(2))?;
        stream.set_read_timeout(Some(Duration::from_secs(2)))?;
        stream.write_all(b"GET /api/health HTTP/1.0\r\nHost: localhost\r\n\r\n")?;
        let mut head = [0u8; 16];
        let n = stream.read(&mut head)?;
        Ok(head[..n].starts_with(b"HTTP/1.0 200") || head[..n].starts_with(b"HTTP/1.1 200"))
    };
    match probe() {
        Ok(true) => ExitCode::SUCCESS,
        _ => ExitCode::FAILURE,
    }
}

#[tokio::main]
async fn serve() -> ExitCode {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    match run().await {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            tracing::error!(error = %e, "fatal error");
            ExitCode::FAILURE
        }
    }
}

async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let config = Config::from_env();
    if config.uses_default_password() {
        tracing::warn!("ADMIN_PASSWORD is the default \"homebar\" — set a real password!");
    }
    if !config.discover_enabled {
        tracing::info!("discover disabled (offline mode)");
    }

    std::fs::create_dir_all(config.uploads_dir())?;
    let pool = db::connect(&config.db_path()).await?;
    seed::seed_if_empty(&pool).await?;

    let addr = SocketAddr::from(([0, 0, 0, 0], config.port));
    let state = AppState::new(pool.clone(), config.clone())?;
    let app = build_app(state.clone());

    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(
        %addr,
        data_dir = %config.data_dir.display(),
        static_dir = %config.static_dir.display(),
        version = env!("CARGO_PKG_VERSION"),
        "HomeBar listening"
    );

    let shutdown_state = state.clone();
    axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            shutdown_signal().await;
            tracing::info!("shutdown signal received, draining connections");
            shutdown_state.trigger_shutdown();
        })
        .await?;

    pool.close().await;
    tracing::info!("bye");
    Ok(())
}

/// Resolves on Ctrl-C or SIGTERM (what `docker stop` sends).
async fn shutdown_signal() {
    let ctrl_c = async {
        if let Err(e) = tokio::signal::ctrl_c().await {
            tracing::error!(error = %e, "cannot listen for ctrl-c");
            std::future::pending::<()>().await;
        }
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut sig) => {
                sig.recv().await;
            }
            Err(e) => {
                tracing::error!(error = %e, "cannot listen for SIGTERM");
                std::future::pending::<()>().await;
            }
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        () = ctrl_c => {},
        () = terminate => {},
    }
}
