//! floatty-server: Standalone HTTP server for floatty block store.
//!
//! Run with:
//!   cargo run -p floatty-server
//!
//! Or install and run:
//!   cargo install --path src-tauri/floatty-server
//!   floatty-server

use axum::middleware;
use floatty_core::YDocStore;
use floatty_server::{api, auth, config::ServerConfig};
use std::net::SocketAddr;
use std::sync::Arc;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

#[tokio::main]
async fn main() {
    // Initialize tracing
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "floatty_server=info,tower_http=debug".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    // Load config
    let config = ServerConfig::load();

    if !config.enabled {
        tracing::info!("Server disabled in config. Exiting.");
        return;
    }

    // Get or generate API key
    let api_key = config.get_or_generate_api_key();
    tracing::info!("API key: {}", api_key);

    // Create the block store
    let store = match YDocStore::new() {
        Ok(s) => Arc::new(s),
        Err(e) => {
            tracing::error!("Failed to create YDocStore: {}", e);
            std::process::exit(1);
        }
    };

    // Build router with auth middleware
    let auth_state = auth::ApiKeyAuth::new(api_key.clone());
    let app = api::create_router(Arc::clone(&store))
        .layer(middleware::from_fn_with_state(auth_state, auth::auth_middleware));

    // Bind and serve
    let addr: SocketAddr = format!("{}:{}", config.bind, config.port)
        .parse()
        .expect("Invalid bind address");

    tracing::info!("floatty-server listening on http://{}", addr);
    tracing::info!("Health check: curl http://{}/api/v1/health", addr);
    tracing::info!(
        "Authenticated: curl -H 'Authorization: Bearer {}' http://{}/api/v1/state",
        api_key,
        addr
    );

    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
