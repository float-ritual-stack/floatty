mod commands;
mod config;
mod ctx_parser;
mod ctx_watcher;
mod daily_view;
mod db;
#[cfg(target_os = "macos")]
mod panel;
mod server;
mod services;
mod sync_test;

use commands::{
    check_hooks_installed, clear_ctx_markers, clear_workspace, execute_ai_command,
    execute_ai_conversation, execute_shell_command, get_ctx_config, get_ctx_counts,
    get_ctx_markers, get_theme, get_workspace_state, install_shell_hooks, save_clipboard_image,
    save_workspace_state, set_ctx_config, set_theme, uninstall_shell_hooks,
};
use config::{AggregatorConfig, ServerInfo};
use server::{spawn_server, ServerState};
use ctx_parser::{CtxParser, ParserConfig};
use ctx_watcher::{CtxWatcher, WatcherConfig};
use db::FloattyDb;
use floatty_core::YDocStore;
use std::sync::Arc;
use tauri::{Manager, State};
use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};
use tracing_appender::rolling::{RollingFileAppender, Rotation};

/// Default server port (matches floatty-server)
const DEFAULT_SERVER_PORT: u16 = 8765;

/// Inner state when ctx:: system is available
struct AppStateInner {
    db: Arc<FloattyDb>,
    #[allow(dead_code)] // Held for lifetime, stop() called on drop
    watcher: CtxWatcher,
    #[allow(dead_code)]
    parser: CtxParser,
    /// Y.Doc store with integrated persistence (from floatty-core)
    #[allow(dead_code)] // Y.Doc sync now via server, but store still needed for ctx_parser
    store: YDocStore,
}

/// Managed state wrapper - inner is None when DB initialization fails
pub struct AppState {
    inner: Option<AppStateInner>,
    /// Server subprocess state - None if server failed to spawn
    server: Option<ServerState>,
}

/// Get server info for HTTP client initialization
///
/// Returns the server URL and API key for the frontend to connect.
/// Called once on app startup to initialize the HTTP client.
#[tauri::command]
fn get_server_info(state: State<AppState>) -> Result<ServerInfo, String> {
    state.server.as_ref()
        .map(|s| s.info.clone())
        .ok_or_else(|| "Server not running".to_string())
}

/// Forward JS console messages to Rust tracing (written to log file)
///
/// Levels: "trace", "debug", "info", "warn", "error"
/// Messages appear in ~/.floatty/logs/floatty-{date}.jsonl
#[tauri::command]
fn log_js(level: &str, target: &str, message: &str) {
    match level.to_lowercase().as_str() {
        "trace" => tracing::trace!(target: "js", js_target = %target, "{}", message),
        "debug" => tracing::debug!(target: "js", js_target = %target, "{}", message),
        "info" => tracing::info!(target: "js", js_target = %target, "{}", message),
        "warn" => tracing::warn!(target: "js", js_target = %target, "{}", message),
        "error" => tracing::error!(target: "js", js_target = %target, "{}", message),
        _ => tracing::info!(target: "js", js_target = %target, level = %level, "{}", message),
    }
}

/// Initialize structured logging with tracing
/// 
/// Logs are written to:
/// - File: ~/.floatty/logs/floatty-{date}.jsonl (structured JSON, daily rotation)
/// - Stdout: Human-readable format (dev builds only)
/// 
/// Configure via RUST_LOG env var, defaults to INFO level
fn setup_logging() {
    let log_dir = dirs::home_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join(".floatty")
        .join("logs");
    
    // Create log directory if it doesn't exist
    if let Err(e) = std::fs::create_dir_all(&log_dir) {
        eprintln!("Failed to create log directory: {}", e);
        return;
    }
    
    // File appender: ~/.floatty/logs/floatty-{date}.jsonl
    let file_appender = match RollingFileAppender::builder()
        .rotation(Rotation::DAILY)
        .filename_prefix("floatty")
        .filename_suffix("jsonl")
        .build(log_dir) {
            Ok(appender) => appender,
            Err(e) => {
                eprintln!("Failed to create log appender: {}", e);
                return;
            }
        };
    
    // Structured JSON logs to file (always enabled)
    let file_layer = fmt::layer()
        .json()
        .with_writer(file_appender)
        .with_target(true)
        .with_thread_ids(true)
        .with_thread_names(true)
        .with_file(true)
        .with_line_number(true);
    
    // Human-readable logs to stdout (dev only)
    let stdout_layer = if cfg!(debug_assertions) {
        Some(fmt::layer()
            .with_writer(std::io::stdout)
            .with_target(true)
            .with_level(true)
            .with_ansi(true)
            .pretty())
    } else {
        None
    };
    
    // ENV filter: RUST_LOG=debug or default to info
    let filter = EnvFilter::try_from_default_env()
        .or_else(|_| EnvFilter::try_new("info"))
        .unwrap();
    
    // Initialize tracing subscriber
    tracing_subscriber::registry()
        .with(filter)
        .with(file_layer)
        .with(stdout_layer)
        .init();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Initialize structured logging FIRST (before any other operations)
    setup_logging();
    
    tracing::info!(version = env!("CARGO_PKG_VERSION"), "Floatty starting");
    
    let context = tauri::generate_context!();

    // Load config from ~/.floatty/config.toml (or defaults)
    let config = AggregatorConfig::load();

    // Spawn floatty-server subprocess
    let server_state = spawn_server(DEFAULT_SERVER_PORT);

    // Try to initialize database and ctx aggregation
    let inner = match FloattyDb::open() {
        Ok(db) => {
            // Legacy migration: if ydoc_updates is empty but system_state has data,
            // migrate it BEFORE creating YDocStore (which loads from ydoc_updates)
            const YDOC_KEY: &str = "default";
            const MAX_MIGRATION_ATTEMPTS: u32 = 3;

            let has_updates = db.get_ydoc_update_count(YDOC_KEY).unwrap_or(0) > 0;
            let migration_attempts: u32 = db.get_system_state("ydoc_migration_attempts")
                .ok()
                .flatten()
                .and_then(|bytes| String::from_utf8(bytes).ok())
                .and_then(|s| s.parse().ok())
                .unwrap_or(0);

            if !has_updates && migration_attempts < MAX_MIGRATION_ATTEMPTS {
                if let Ok(Some(state_bytes)) = db.get_system_state("ydoc") {
                    if !state_bytes.is_empty() {
                        log::info!(
                            "Migrating Y.Doc from legacy system_state to append-only ({} bytes, attempt {}/{})",
                            state_bytes.len(), migration_attempts + 1, MAX_MIGRATION_ATTEMPTS
                        );
                        // Write legacy data to ydoc_updates so YDocStore will load it
                        if let Err(e) = db.append_ydoc_update(YDOC_KEY, &state_bytes) {
                            log::error!(
                                "Failed to migrate Y.Doc to append-only storage: {} (attempt {}/{})",
                                e, migration_attempts + 1, MAX_MIGRATION_ATTEMPTS
                            );
                            let new_attempts = migration_attempts + 1;
                            let _ = db.set_system_state("ydoc_migration_attempts", new_attempts.to_string().as_bytes());
                        } else {
                            log::info!("Successfully migrated Y.Doc from legacy to append-only format");
                            // Clear legacy entry to prevent re-migration after schema upgrades
                            let _ = db.set_system_state("ydoc", b"");
                            let _ = db.set_system_state("ydoc_migration_attempts", b"0");
                        }
                    }
                }
            } else if migration_attempts >= MAX_MIGRATION_ATTEMPTS {
                log::warn!("Y.Doc migration skipped: max attempts ({}) reached. Manual intervention may be needed.", MAX_MIGRATION_ATTEMPTS);
            }

            let db = Arc::new(db);

            // Create YDocStore (from floatty-core) - handles Y.Doc loading + persistence
            let store = match YDocStore::new() {
                Ok(s) => s,
                Err(e) => {
                    log::error!("Failed to create YDocStore: {}", e);
                    return; // Can't continue without Y.Doc
                }
            };

            // Create watcher and parser with loaded config
            // Expand ~ in watch_path (PathBuf::from doesn't do this)
            let watch_path = if config.watch_path.starts_with("~/") {
                dirs::home_dir()
                    .unwrap_or_else(|| std::path::PathBuf::from("."))
                    .join(&config.watch_path[2..])
            } else {
                std::path::PathBuf::from(&config.watch_path)
            };
            let watcher_config = WatcherConfig {
                watch_path,
                poll_interval_ms: config.poll_interval_ms,
                max_age_hours: config.max_age_hours,
            };
            let parser_config = ParserConfig {
                endpoint: config.ollama_endpoint.clone(),
                model: config.ollama_model.clone(),
                poll_interval_ms: config.poll_interval_ms,
                max_retries: config.max_retries,
                ..ParserConfig::default()
            };

            let watcher = CtxWatcher::new(Arc::clone(&db), watcher_config);
            // CtxParser needs Arc<RwLock<Doc>> - get it from the store
            let doc_arc = store.doc();

            match CtxParser::new(Arc::clone(&db), parser_config, doc_arc) {
                Ok(parser) => {
                    // Start background workers
                    watcher.start();
                    parser.start();

                    log::info!("ctx:: aggregation system initialized successfully");
                    Some(AppStateInner {
                        db,
                        watcher,
                        parser,
                        store,
                    })
                }
                Err(e) => {
                    log::error!("Failed to create ctx:: parser: {}", e);
                    log::error!("ctx:: sidebar will show errors. Check Ollama/network configuration.");
                    None
                }
            }
        }
        Err(e) => {
            log::error!("Failed to open ctx:: database: {}", e);
            log::error!("ctx:: sidebar will show errors. Check ~/.floatty permissions.");
            None
        }
    };

    // Always register AppState - inner is None when initialization fails
    // Log server status
    if server_state.is_some() {
        log::info!("floatty-server subprocess ready");
    } else {
        log::warn!("floatty-server failed to start - Y.Doc sync will fail");
    }

    let state = AppState { inner, server: server_state };

    // Build app with platform-specific plugins and commands
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_pty::init())
        .plugin(tauri_plugin_clipboard::init())
        .plugin(tauri_plugin_dialog::init());

    // macOS-only: NSPanel floating window support
    #[cfg(target_os = "macos")]
    {
        builder = builder.plugin(tauri_nspanel::init());
    }

    builder
        .manage(state)
        .invoke_handler({
            // Platform-agnostic commands
            #[cfg(not(target_os = "macos"))]
            {
                tauri::generate_handler![
                    get_ctx_markers,
                    get_ctx_counts,
                    get_ctx_config,
                    set_ctx_config,
                    get_theme,
                    set_theme,
                    clear_ctx_markers,
                    get_server_info,
                    log_js,
                    execute_shell_command,
                    execute_ai_command,
                    execute_ai_conversation,
                    daily_view::execute_daily_command,
                    clear_workspace,
                    save_clipboard_image,
                    check_hooks_installed,
                    install_shell_hooks,
                    uninstall_shell_hooks,
                    get_workspace_state,
                    save_workspace_state,
                ]
            }
            // macOS: include panel commands
            #[cfg(target_os = "macos")]
            {
                tauri::generate_handler![
                    get_ctx_markers,
                    get_ctx_counts,
                    get_ctx_config,
                    set_ctx_config,
                    get_theme,
                    set_theme,
                    clear_ctx_markers,
                    get_server_info,
                    log_js,
                    execute_shell_command,
                    execute_ai_command,
                    execute_ai_conversation,
                    daily_view::execute_daily_command,
                    clear_workspace,
                    save_clipboard_image,
                    check_hooks_installed,
                    install_shell_hooks,
                    uninstall_shell_hooks,
                    get_workspace_state,
                    save_workspace_state,
                    panel::show_test_panel,
                    panel::hide_test_panel,
                    panel::toggle_test_panel,
                ]
            }
        })
        .on_window_event(|window, event| {
            // macOS-only: Intercept panel close to hide instead of destroy
            #[cfg(target_os = "macos")]
            {
                use tauri_nspanel::ManagerExt;
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    // Check if this window is managed as an NSPanel
                    if window.app_handle().get_webview_panel(window.label()).is_ok() {
                        // Hide instead of destroy to preserve state/memory
                        let _ = window.hide();
                        api.prevent_close();
                        tracing::info!(window_label = %window.label(), "Panel close intercepted, hiding instead");
                    }
                }
            }
            // Non-macOS: allow default behavior (suppress unused variable warnings)
            #[cfg(not(target_os = "macos"))]
            {
                let _ = (window, event);
            }
        })
        .setup(|app| {
            // Set window title with build mode indicator
            if let Some(window) = app.get_webview_window("main") {
                let build_mode = if cfg!(debug_assertions) { "dev" } else { "release" };
                let title = format!("floatty ({})", build_mode);
                let _ = window.set_title(&title);
                tracing::info!(
                    window_title = %title,
                    debug_mode = cfg!(debug_assertions),
                    "Window title set"
                );
            }
            Ok(())
        })
        .run(context)
        .expect("error while running tauri application");
}

// ============================================================================
