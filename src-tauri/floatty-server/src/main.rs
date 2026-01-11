//! floatty-server: Standalone HTTP server for floatty block store.
//!
//! Run with:
//!   cargo run -p floatty-server
//!
//! Or install and run:
//!   cargo install --path src-tauri/floatty-server
//!   floatty-server

use axum::{http::Method, middleware, routing::get, Router};
use floatty_core::{HookSystem, YDocStore};
use floatty_server::{api, auth, config::ServerConfig, ws, WsBroadcaster};
use std::net::SocketAddr;
use std::sync::Arc;
use tower_http::cors::{Any, CorsLayer};
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

    // Load config from file
    let config = ServerConfig::load();

    // Environment variables override config file (for Tauri spawn)
    let port: u16 = std::env::var("FLOATTY_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(config.port);

    let api_key = std::env::var("FLOATTY_API_KEY")
        .ok()
        .unwrap_or_else(|| config.get_or_generate_api_key());

    // Check if server is disabled (only from config file, env spawned = always run)
    if std::env::var("FLOATTY_API_KEY").is_err() && !config.enabled {
        tracing::info!("Server disabled in config. Exiting.");
        return;
    }

    tracing::info!("API key: {}", api_key);

    // Create the block store
    let store = match YDocStore::new() {
        Ok(s) => Arc::new(s),
        Err(e) => {
            tracing::error!("Failed to create YDocStore: {}", e);
            std::process::exit(1);
        }
    };

    // Initialize hook system (MetadataExtractionHook + PageNameIndexHook registered, cold start rehydration)
    let hook_system = Arc::new(HookSystem::initialize(Arc::clone(&store)));

    // Wire Y.Doc observation to hook system
    // This makes ALL Y.Doc mutations (including frontend sync) trigger hooks
    {
        let hook_system_clone = Arc::clone(&hook_system);
        store.set_change_callback(move |changes| {
            for change in changes {
                let _ = hook_system_clone.emit_change(change);
            }
        });
    }
    tracing::info!("Y.Doc change observation wired to hook system");

    // Create WebSocket broadcaster for real-time sync
    let broadcaster = Arc::new(WsBroadcaster::new(64));

    // CORS layer - allow requests from Tauri webview (localhost origins)
    let cors = CorsLayer::new()
        .allow_origin(Any) // Tauri uses tauri://localhost or http://localhost
        .allow_methods([Method::GET, Method::POST, Method::PATCH, Method::DELETE, Method::OPTIONS])
        .allow_headers(Any);

    // Build router with CORS and optional auth middleware
    let api_routes = if config.auth_enabled {
        let auth_state = auth::ApiKeyAuth::new(api_key.clone());
        tracing::info!("API authentication enabled");
        api::create_router(Arc::clone(&store), Arc::clone(&broadcaster), Arc::clone(&hook_system))
            .layer(middleware::from_fn_with_state(auth_state, auth::auth_middleware))
    } else {
        tracing::warn!("API authentication DISABLED (auth_enabled = false in config)");
        api::create_router(Arc::clone(&store), Arc::clone(&broadcaster), Arc::clone(&hook_system))
    };

    // WebSocket route (auth via query param since WS can't use headers easily)
    let ws_routes = Router::new()
        .route("/ws", get(ws::ws_handler))
        .with_state(Arc::clone(&broadcaster));

    // Combine routes
    let app = Router::new()
        .merge(api_routes)
        .merge(ws_routes)
        .layer(cors);

    // Bind and serve (port from env overrides config)
    let addr: SocketAddr = format!("{}:{}", config.bind, port)
        .parse()
        .expect("Invalid bind address");

    tracing::info!("floatty-server listening on http://{}", addr);
    tracing::info!("Health check: curl http://{}/api/v1/health", addr);
    if config.auth_enabled {
        tracing::info!(
            "Authenticated: curl -H 'Authorization: Bearer {}' http://{}/api/v1/state",
            api_key,
            addr
        );
    } else {
        tracing::info!("No auth: curl http://{}/api/v1/blocks", addr);
    }

    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
