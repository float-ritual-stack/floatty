//! floatty-server: Standalone HTTP server for floatty block store.
//!
//! Run with:
//!   cargo run -p floatty-server
//!
//! Or install and run:
//!   cargo install --path src-tauri/floatty-server
//!   floatty-server

use axum::{extract::DefaultBodyLimit, http::Method, middleware, routing::get, Router};
use floatty_core::{HookSystem, YDocStore};
use floatty_server::{
    api, auth,
    backup::{self, BackupDaemon},
    config::{BackupConfig, ServerConfig},
    start_heartbeat, ws, OutlineManager, WsBroadcaster,
};
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

    // Preflight: verify data dir matches build profile (FLO-317 "never again")
    {
        let data_root = floatty_server::config::data_dir();
        #[cfg(debug_assertions)]
        if data_root.ends_with(".floatty") && std::env::var("FLOATTY_DATA_DIR").is_err() {
            panic!("BUG: dev server resolved to release data dir. Check config::data_dir().");
        }
        #[cfg(not(debug_assertions))]
        if data_root.ends_with(".floatty-dev") && std::env::var("FLOATTY_DATA_DIR").is_err() {
            panic!("BUG: release server resolved to dev data dir. Check config::data_dir().");
        }
    }

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
        store
            .set_change_callback(move |changes| {
                for change in changes {
                    if let Err(e) = hook_system_clone.emit_change(change) {
                        tracing::error!("Hook emission failed: {}", e);
                    }
                }
            })
            .expect("Failed to register change callback - hooks will not fire");
    }
    tracing::info!("Y.Doc change observation wired to hook system");

    // Create WebSocket broadcaster for real-time sync
    // FLO-152: Bumped from 64 to 256 to reduce likelihood of Lagged errors
    let broadcaster = Arc::new(WsBroadcaster::new(256));

    // FLO-391: Wire broadcast callback so hook metadata updates (which persist to
    // SQLite and consume seq numbers) also broadcast via WebSocket. Without this,
    // hook seqs create invisible gaps that trigger client-side gap-fill storms.
    {
        let broadcaster_clone = Arc::clone(&broadcaster);
        store.set_broadcast_callback(move |update, seq| {
            broadcaster_clone.broadcast(update, None, Some(seq));
        });
    }

    // Start heartbeat task - broadcasts latest seq every 30s if no updates sent
    // This closes the non-atomic persist-broadcast window gap
    start_heartbeat(Arc::clone(&broadcaster), Arc::clone(&store));

    // Initialize backup daemon if enabled (FLO-251)
    let backup_config = BackupConfig::load();
    let backup_daemon: Option<Arc<BackupDaemon>> = if backup_config.enabled {
        let backup_dir = backup::backup_dir();
        if let Err(e) = std::fs::create_dir_all(&backup_dir) {
            tracing::error!("Failed to create backup directory: {}", e);
            None
        } else {
            let daemon = BackupDaemon::new(
                Arc::clone(&store),
                backup_config.clone(),
                backup_dir,
            );
            let daemon_arc = Arc::new(daemon);

            // Use the same Arc for both API and background task
            let _handle = Arc::clone(&daemon_arc).start();

            tracing::info!(
                "Backup daemon started (interval: {}h, retain: {}h/{}d/{}w)",
                backup_config.interval_hours,
                backup_config.retain_hourly,
                backup_config.retain_daily,
                backup_config.retain_weekly
            );

            Some(daemon_arc)
        }
    } else {
        tracing::info!("Backup daemon disabled");
        None
    };

    // Create outline manager for multi-outline support
    let data_dir = floatty_server::config::data_dir();
    let default_context = Arc::new(floatty_server::OutlineContext::new_default(
        Arc::clone(&store),
        Arc::clone(&hook_system),
        Arc::clone(&broadcaster),
        Some(data_dir.join("search_index")),
    ));
    let outline_manager = Arc::new(OutlineManager::new_with_default(&data_dir, default_context));
    tracing::info!("Outline manager initialized");

    // CORS layer - allow requests from Tauri webview (localhost origins)
    let cors = CorsLayer::new()
        .allow_origin(Any) // Tauri uses tauri://localhost or http://localhost
        .allow_methods([Method::GET, Method::POST, Method::PATCH, Method::DELETE, Method::OPTIONS])
        .allow_headers(Any);

    // Build router with CORS and optional auth middleware
    let api_routes = if config.auth_enabled {
        let auth_state = auth::ApiKeyAuth::new(api_key.clone());
        tracing::info!("API authentication enabled");
        api::create_router(Arc::clone(&store), Arc::clone(&broadcaster), Arc::clone(&hook_system), backup_daemon.clone(), Arc::clone(&outline_manager))
            .layer(middleware::from_fn_with_state(auth_state, auth::auth_middleware))
    } else {
        tracing::warn!("API authentication DISABLED (auth_enabled = false in config)");
        api::create_router(Arc::clone(&store), Arc::clone(&broadcaster), Arc::clone(&hook_system), backup_daemon.clone(), Arc::clone(&outline_manager))
    };

    // WebSocket route — supports ?outline={name} for per-outline subscriptions
    let ws_state = ws::WsState {
        default_broadcaster: Arc::clone(&broadcaster),
        outline_manager: Arc::clone(&outline_manager),
    };
    let ws_routes = Router::new()
        .route("/ws", get(ws::ws_handler))
        .with_state(ws_state);

    // Combine routes
    // 256MB — intentionally oversized. Single-user local app, no untrusted clients.
    // Y.Doc restore payload grows with outline size (currently ~22MB).
    // Previous incremental bumps (2→16→64) each caused an incident.
    // Set once, set high, never touch again.
    let app = Router::new()
        .merge(api_routes)
        .merge(ws_routes)
        .layer(DefaultBodyLimit::max(256 * 1024 * 1024))
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
    axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
        .await
        .unwrap();
}
