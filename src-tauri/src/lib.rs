mod commands;
mod config;
mod ctx_parser;
mod ctx_watcher;
mod daily_view;
mod db;
mod orphan_detector;
#[cfg(target_os = "macos")]
mod panel;
mod paths;
mod server;
mod services;
mod sync_test;

use commands::{
    acp_cancel_prompt, acp_kill_session, acp_respond_permission, acp_send_prompt,
    acp_spawn_agent, check_hooks_installed, clear_ctx_markers, clear_workspace,
    execute_ai_command, execute_ai_conversation, execute_shell_command, get_clipboard_info,
    get_ctx_config, get_ctx_counts, get_ctx_markers, get_send_model, get_theme,
    get_workspace_state, install_shell_hooks, open_url, read_help_file, save_clipboard_image,
    save_workspace_state, set_ctx_config, set_theme, toggle_diagnostics, uninstall_shell_hooks,
};
use services::acp::AcpManager;
use config::{AggregatorConfig, ServerInfo};
use paths::DataPaths;
use server::{spawn_server, ServerState};
use ctx_parser::{CtxParser, ParserConfig};
use ctx_watcher::{CtxWatcher, WatcherConfig};
use db::FloattyDb;
use floatty_core::YDocStore;
use std::sync::Arc;
use tauri::{Emitter, Manager, State};
use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};
use tracing_appender::rolling::{RollingFileAppender, Rotation};

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

/// Run orphan detection against floatty-server and emit results to frontend.
///
/// Fetches blocks from server, runs `find_orphans()`, and emits
/// "orphans-detected" event if any are found.
async fn run_orphan_check(server_url: &str, api_key: &str, app_handle: &tauri::AppHandle) {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let url = format!("{}/api/v1/blocks", server_url);

    let response = match client
        .get(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!(error = %e, "Orphan check: failed to fetch blocks from server");
            return;
        }
    };

    if !response.status().is_success() {
        tracing::warn!(status = %response.status(), "Orphan check: server returned error");
        return;
    }

    let data: orphan_detector::BlocksApiResponse = match response.json().await {
        Ok(d) => d,
        Err(e) => {
            tracing::warn!(error = %e, "Orphan check: failed to parse blocks response");
            return;
        }
    };

    let orphans = orphan_detector::find_orphans(&data.blocks, &data.root_ids);

    if orphans.is_empty() {
        tracing::debug!(block_count = data.blocks.len(), "Orphan check: no orphans found");
        return;
    }

    tracing::warn!(
        orphan_count = orphans.len(),
        block_count = data.blocks.len(),
        "Orphan check: found orphaned blocks"
    );

    // Emit to frontend for quarantine handling
    if let Err(e) = app_handle.emit("orphans-detected", &orphans) {
        tracing::error!(error = %e, "Failed to emit orphans-detected event");
    }
}

/// Manual trigger for orphan detection (for testing/debugging).
#[tauri::command]
async fn check_orphans_now(state: State<'_, AppState>, app_handle: tauri::AppHandle) -> Result<String, String> {
    let server = state.server.as_ref()
        .ok_or_else(|| "Server not running".to_string())?;

    run_orphan_check(&server.info.url, &server.info.api_key, &app_handle).await;
    Ok("Orphan check complete".to_string())
}

/// Initialize structured logging with tracing
///
/// Logs are written to:
/// - File: {data_dir}/logs/floatty-{date}.jsonl (structured JSON, daily rotation)
/// - Stdout: Human-readable format (dev builds only)
///
/// Configure via RUST_LOG env var, defaults to INFO level
fn setup_logging(log_dir: &std::path::Path) {
    // Create log directory if it doesn't exist
    if let Err(e) = std::fs::create_dir_all(log_dir) {
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
    // Resolve data paths from FLOATTY_DATA_DIR or default ~/.floatty
    let paths = DataPaths::resolve();

    // Preflight: verify data dir matches build profile (FLO-317 "never again")
    #[cfg(debug_assertions)]
    if paths.root.ends_with(".floatty") && std::env::var("FLOATTY_DATA_DIR").is_err() {
        panic!("BUG: dev build resolved to release data dir (~/.floatty). Check DataPaths.");
    }
    #[cfg(not(debug_assertions))]
    if paths.root.ends_with(".floatty-dev") && std::env::var("FLOATTY_DATA_DIR").is_err() {
        panic!("BUG: release build resolved to dev data dir (~/.floatty-dev). Check DataPaths.");
    }

    // Ensure directories exist before logging
    if let Err(e) = paths.ensure_dirs() {
        eprintln!("Failed to create data directories: {}", e);
    }

    // Initialize structured logging FIRST (before any other operations)
    setup_logging(&paths.logs);

    tracing::info!(
        version = env!("CARGO_PKG_VERSION"),
        data_dir = ?paths.root,
        "Floatty starting"
    );

    let context = tauri::generate_context!();

    // Load config from {data_dir}/config.toml (or defaults)
    let config = AggregatorConfig::load_from(&paths.config);

    // Use port from config (allows workspace-specific ports)
    let server_port = config.server_port;

    // Spawn floatty-server subprocess (passes FLOATTY_DATA_DIR env)
    let server_state = spawn_server(&paths, server_port);

    // Try to initialize database and ctx aggregation
    let inner = match FloattyDb::open_at(&paths.database) {
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
                model: config.get_ctx_model().to_string(),
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

    // Capture server info for orphan detector before moving into AppState
    let server_url_for_orphan = server_state.as_ref().map(|s| s.info.url.clone());
    let server_api_key_for_orphan = server_state.as_ref().map(|s| s.info.api_key.clone());

    let state = AppState { inner, server: server_state };

    // Build app with platform-specific plugins and commands
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_pty::init())
        .plugin(tauri_plugin_clipboard::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init());

    // macOS-only: NSPanel floating window support
    #[cfg(target_os = "macos")]
    {
        builder = builder.plugin(tauri_nspanel::init());
    }

    #[cfg(debug_assertions)]
    {
        builder = builder.plugin(tauri_plugin_mcp_bridge::init());
    }

    let acp_manager = AcpManager::new();

    builder
        .manage(state)
        .manage(acp_manager)
        .invoke_handler({
            // Platform-agnostic commands
            #[cfg(not(target_os = "macos"))]
            {
                tauri::generate_handler![
                    get_ctx_markers,
                    get_ctx_counts,
                    get_ctx_config,
                    set_ctx_config,
                    get_send_model,
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
                    get_clipboard_info,
                    save_clipboard_image,
                    check_hooks_installed,
                    install_shell_hooks,
                    uninstall_shell_hooks,
                    get_workspace_state,
                    save_workspace_state,
                    read_help_file,
                    toggle_diagnostics,
                    open_url,
                    check_orphans_now,
                    acp_spawn_agent,
                    acp_send_prompt,
                    acp_respond_permission,
                    acp_cancel_prompt,
                    acp_kill_session,
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
                    get_send_model,
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
                    get_clipboard_info,
                    save_clipboard_image,
                    check_hooks_installed,
                    install_shell_hooks,
                    uninstall_shell_hooks,
                    get_workspace_state,
                    save_workspace_state,
                    read_help_file,
                    toggle_diagnostics,
                    open_url,
                    check_orphans_now,
                    acp_spawn_agent,
                    acp_send_prompt,
                    acp_respond_permission,
                    acp_cancel_prompt,
                    acp_kill_session,
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
        .setup({
            // Capture workspace_name for title bar
            let workspace_name = config.workspace_name.clone();
            // Capture server info for orphan detector background worker
            let orphan_server_url = server_url_for_orphan.clone();
            let orphan_api_key = server_api_key_for_orphan.clone();
            move |app| {
                // Set enhanced window title:
                // floatty (dev) - workspace v0.4.2 (abc1234)
                if let Some(window) = app.get_webview_window("main") {
                    let build_mode = if cfg!(debug_assertions) { "dev" } else { "release" };
                    let version = env!("CARGO_PKG_VERSION");

                    // Get git info from vergen (populated at build time)
                    // Falls back to "unknown" if not available (e.g., building without git)
                    let git_sha = option_env!("VERGEN_GIT_SHA").unwrap_or("unknown");
                    let git_dirty = option_env!("VERGEN_GIT_DIRTY")
                        .map(|s| s == "true")
                        .unwrap_or(false);

                    // Format git info: short hash + dirty indicator
                    let git_info = if git_dirty {
                        format!("{}+dirty", &git_sha[..7.min(git_sha.len())])
                    } else {
                        git_sha[..7.min(git_sha.len())].to_string()
                    };

                    let title = format!(
                        "floatty ({}) - {} v{} ({})",
                        build_mode, workspace_name, version, git_info
                    );
                    let _ = window.set_title(&title);
                    tracing::info!(
                        window_title = %title,
                        debug_mode = cfg!(debug_assertions),
                        workspace = %workspace_name,
                        git_sha = %git_sha,
                        "Window title set"
                    );
                }

                // FLO-350: Start orphan detection background worker
                if let (Some(url), Some(key)) = (orphan_server_url, orphan_api_key) {
                    let app_handle = app.handle().clone();
                    tauri::async_runtime::spawn(async move {
                        // Initial check after 30s (let server and frontend settle)
                        tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                        tracing::info!("Orphan detector: running initial check");
                        run_orphan_check(&url, &key, &app_handle).await;

                        // Then every hour
                        let mut interval = tokio::time::interval(std::time::Duration::from_secs(3600));
                        interval.tick().await; // skip immediate tick
                        loop {
                            interval.tick().await;
                            tracing::debug!("Orphan detector: running hourly check");
                            run_orphan_check(&url, &key, &app_handle).await;
                        }
                    });
                }

                Ok(())
            }
        })
        .run(context)
        .expect("error while running tauri application");
}

// ============================================================================
