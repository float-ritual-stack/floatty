mod ctx_parser;
mod ctx_watcher;
mod db;
#[cfg(target_os = "macos")]
mod panel;
mod sync_test;

use ctx_parser::{CtxParser, ParserConfig};
use ctx_watcher::{CtxWatcher, WatcherConfig};
use db::{CtxDatabase, CtxMarker};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Arc, RwLock};
use tauri::{Manager, State};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use yrs::{Array, Doc, Map, ReadTxn, StateVector, Transact, Update, updates::decoder::Decode};

/// Aggregator configuration (stored/loaded from ~/.floatty/config.toml)
#[derive(Clone, Serialize, Deserialize)]
pub struct AggregatorConfig {
    pub watch_path: String,
    pub ollama_endpoint: String,
    pub ollama_model: String,
    pub poll_interval_ms: u64,
    pub max_retries: i32,
    pub max_age_hours: u64,
    /// UI theme name (default, dracula, nord, etc.)
    #[serde(default = "default_theme")]
    pub theme: String,
    /// Terminal font size in pixels
    #[serde(default = "default_font_size")]
    pub font_size: u32,
    /// Terminal font weight (300 = light, 400 = normal, 500 = medium)
    #[serde(default = "default_font_weight")]
    pub font_weight: u32,
    /// Terminal bold font weight
    #[serde(default = "default_font_weight_bold")]
    pub font_weight_bold: u32,
    /// Terminal line height multiplier
    #[serde(default = "default_line_height")]
    pub line_height: f32,
}

fn default_theme() -> String {
    "default".to_string()
}

fn default_font_size() -> u32 {
    13
}

fn default_font_weight() -> u32 {
    300
}

fn default_font_weight_bold() -> u32 {
    500
}

fn default_line_height() -> f32 {
    1.2
}

impl Default for AggregatorConfig {
    fn default() -> Self {
        let default_watcher = WatcherConfig::default();
        let default_parser = ParserConfig::default();

        Self {
            watch_path: default_watcher.watch_path.to_string_lossy().to_string(),
            ollama_endpoint: "http://localhost:11434".to_string(),
            ollama_model: "llama3.2:latest".to_string(),
            poll_interval_ms: default_parser.poll_interval_ms,
            max_retries: default_parser.max_retries,
            max_age_hours: 72, // Default: last 3 days (matches CLAUDE.md docs)
            theme: default_theme(),
            font_size: default_font_size(),
            font_weight: default_font_weight(),
            font_weight_bold: default_font_weight_bold(),
            line_height: default_line_height(),
        }
    }
}

impl AggregatorConfig {
    /// Config file path: ~/.floatty/config.toml
    fn config_path() -> PathBuf {
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".floatty")
            .join("config.toml")
    }

    /// Load config from file, falling back to defaults
    pub fn load() -> Self {
        let path = Self::config_path();

        if path.exists() {
            match std::fs::read_to_string(&path) {
                Ok(contents) => {
                    match toml::from_str::<AggregatorConfig>(&contents) {
                        Ok(config) => {
                            log::info!("Loaded config from {:?}", path);
                            return config;
                        }
                        Err(e) => {
                            log::warn!("Failed to parse config: {}, using defaults", e);
                        }
                    }
                }
                Err(e) => {
                    log::warn!("Failed to read config file: {}, using defaults", e);
                }
            }
        } else {
            log::info!("No config file at {:?}, using defaults", path);
        }

        Self::default()
    }

    /// Save current config to file
    pub fn save(&self) -> Result<(), String> {
        let path = Self::config_path();

        // Ensure parent directory exists
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }

        let contents = toml::to_string_pretty(self).map_err(|e| e.to_string())?;
        std::fs::write(&path, contents).map_err(|e| e.to_string())?;

        log::info!("Saved config to {:?}", path);
        Ok(())
    }
}

/// Status counts for sidebar
#[derive(Serialize)]
pub struct MarkerCounts {
    pub pending: i32,
    pub parsed: i32,
    pub error: i32,
    pub total: i32,
}

/// Inner state when ctx:: system is available
struct AppStateInner {
    db: Arc<CtxDatabase>,
    #[allow(dead_code)] // Held for lifetime, stop() called on drop
    watcher: CtxWatcher,
    #[allow(dead_code)]
    parser: CtxParser,
    doc: Arc<RwLock<Doc>>,
    /// Counter to avoid SELECT on every keystroke - only check DB periodically
    updates_since_compact_check: std::sync::atomic::AtomicI64,
}

/// Managed state wrapper - inner is None when DB initialization fails
pub struct AppState {
    inner: Option<AppStateInner>,
}

/// Get ctx:: markers for sidebar display
#[tauri::command]
fn get_ctx_markers(
    state: State<AppState>,
    limit: Option<i32>,
    offset: Option<i32>,
) -> Result<Vec<CtxMarker>, String> {
    let inner = state.inner.as_ref()
        .ok_or_else(|| "ctx:: system unavailable: database failed to initialize".to_string())?;

    let limit = limit.unwrap_or(100);
    let offset = offset.unwrap_or(0);

    inner
        .db
        .get_all(limit, offset)
        .map_err(|e| e.to_string())
}

/// Get marker counts by status
#[tauri::command]
fn get_ctx_counts(state: State<AppState>) -> Result<MarkerCounts, String> {
    let inner = state.inner.as_ref()
        .ok_or_else(|| "ctx:: system unavailable: database failed to initialize".to_string())?;

    let (pending, parsed, error) = inner.db.get_counts().map_err(|e| e.to_string())?;
    Ok(MarkerCounts {
        pending,
        parsed,
        error,
        total: pending + parsed + error,
    })
}

/// Get current configuration
#[tauri::command]
fn get_ctx_config() -> AggregatorConfig {
    AggregatorConfig::load()
}

/// Update configuration (requires restart to take effect)
#[tauri::command]
fn set_ctx_config(config: AggregatorConfig) -> Result<(), String> {
    config.save()
}

/// Get current theme name
#[tauri::command]
fn get_theme() -> String {
    AggregatorConfig::load().theme
}

/// Set theme name (persists to config.toml)
#[tauri::command]
fn set_theme(theme: String) -> Result<(), String> {
    let mut config = AggregatorConfig::load();
    config.theme = theme;
    config.save()
}

/// Clear all ctx:: markers and reset database
#[tauri::command]
fn clear_ctx_markers(state: State<AppState>) -> Result<(), String> {
    let inner = state.inner.as_ref()
        .ok_or_else(|| "ctx:: system unavailable: database failed to initialize".to_string())?;

    inner.db.clear_all().map_err(|e| e.to_string())
}

/// Get the initial Yjs document state as Base64
#[tauri::command]
fn get_initial_state(state: State<AppState>) -> Result<String, String> {
    let inner = state.inner.as_ref()
        .ok_or_else(|| "ctx:: system unavailable".to_string())?;
    
    let doc = inner.doc.read().map_err(|e| e.to_string())?;
    let state_vector = StateVector::default();
    let update = doc.transact().encode_state_as_update_v1(&state_vector);
    
    Ok(BASE64.encode(update))
}

/// Default doc key for the outliner (future: support multiple docs)
const YDOC_KEY: &str = "default";
/// Compact when update count exceeds this threshold
const YDOC_COMPACT_THRESHOLD: i64 = 100;
/// Only check DB for compaction every N updates (avoid SELECT per keystroke)
const YDOC_COMPACT_CHECK_INTERVAL: i64 = 10;

use std::sync::atomic::Ordering;

/// Apply a Yjs update from the frontend
#[tauri::command]
fn apply_update(state: State<AppState>, update_b64: String) -> Result<(), String> {
    let inner = state.inner.as_ref()
        .ok_or_else(|| "ctx:: system unavailable".to_string())?;

    // Decode base64 and validate update format before any mutations
    let update_bytes = BASE64.decode(update_b64)
        .map_err(|e| format!("Base64 decode failed: {}", e))?;

    let update = Update::decode_v1(&update_bytes)
        .map_err(|e| format!("Y.Doc update decode failed: {}", e))?;

    // PERSIST FIRST: Write to DB before applying to memory
    // This prevents memory/DB divergence if DB write fails
    inner.db.append_ydoc_update(YDOC_KEY, &update_bytes)
        .map_err(|e| format!("Failed to persist Y.Doc update: {}", e))?;

    // Now apply to in-memory doc (update is already persisted)
    let doc = inner.doc.write()
        .map_err(|e| format!("Failed to acquire Y.Doc write lock: {}", e))?;
    {
        let mut txn = doc.transact_mut();
        txn.apply_update(update)
            .map_err(|e| {
                // Log for debugging, return error so frontend can react
                log::error!("Y.Doc apply failed (persisted, will replay on restart): {}", e);
                format!("Y.Doc apply failed (data saved, restart may be needed): {}", e)
            })?;
    }

    // Increment counter and only check DB periodically (avoid SELECT per keystroke)
    let updates_since_check = inner.updates_since_compact_check.fetch_add(1, Ordering::Relaxed) + 1;

    if updates_since_check >= YDOC_COMPACT_CHECK_INTERVAL {
        // Reset counter and check actual count from DB
        inner.updates_since_compact_check.store(0, Ordering::Relaxed);

        let update_count = inner.db.get_ydoc_update_count(YDOC_KEY).unwrap_or(0);
        if update_count > YDOC_COMPACT_THRESHOLD {
            let full_state = doc.transact().encode_state_as_update_v1(&StateVector::default());
            if let Err(e) = inner.db.compact_ydoc(YDOC_KEY, &full_state) {
                log::warn!(
                    "Y.Doc compaction failed (will retry later): {}. Update count: {}",
                    e, update_count
                );
            }
        }
    }

    Ok(())
}

use ollama_rs::{Ollama, generation::completion::request::GenerationRequest};
use std::time::{SystemTime, UNIX_EPOCH};

/// Execute a shell command and return stdout/stderr
///
/// # Security Model
/// This command is intentionally exposed for the outliner's `sh::` block feature,
/// which allows users to execute arbitrary shell commands from within blocks.
/// This is a power-user feature - commands run with the user's shell privileges.
/// No validation/allowlist is applied since this is equivalent to the user's terminal.
/// Runs command through user's shell to inherit PATH and other environment setup.
#[tauri::command]
async fn execute_shell_command(command: String) -> Result<String, String> {
    if command.trim().is_empty() {
        return Ok("".to_string());
    }

    tauri::async_runtime::spawn_blocking(move || {
        // Use user's shell to inherit PATH from .zshrc/.bashrc
        // This ensures commands like `floatctl` in ~/.cargo/bin work
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());

        let output = std::process::Command::new(&shell)
            .arg("-l")  // Login shell to source profile
            .arg("-c")  // Execute command string
            .arg(&command)
            .output()
            .map_err(|e| format!("Failed to execute shell: {}", e))?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);

        if output.status.success() {
            Ok(stdout.to_string())
        } else {
            Ok(format!("{}\nError: {}", stdout, stderr))
        }
    }).await.map_err(|e| e.to_string())?
}

/// Execute an AI prompt using Ollama
#[tauri::command]
async fn execute_ai_command(prompt: String) -> Result<String, String> {
    // Get config for endpoint/model
    let config = AggregatorConfig::load();

    // Parse endpoint - ollama-rs expects "http://host" format, not just hostname
    let url = url::Url::parse(&config.ollama_endpoint).map_err(|e| e.to_string())?;
    let scheme = url.scheme();
    let host = url.host_str().unwrap_or("localhost");
    let port = url.port().unwrap_or(11434);
    let host_with_scheme = format!("{}://{}", scheme, host);

    log::info!("ai:: executing prompt on {}:{} model={}", host_with_scheme, port, &config.ollama_model);

    let ollama = Ollama::new(host_with_scheme, port);
    let model = config.ollama_model;

    let request = GenerationRequest::new(model, prompt);

    log::info!("ai:: sending request to Ollama...");
    match ollama.generate(request).await {
        Ok(res) => {
            log::info!("ai:: got response ({} chars)", res.response.len());
            Ok(res.response)
        },
        Err(e) => {
            log::error!("ai:: Ollama error: {}", e);
            Err(format!("Ollama error: {}", e))
        },
    }
}

/// Save clipboard image (base64) to temp file and return path
/// Used for pasting screenshots - saves to /tmp/floatty-clipboard-{timestamp}.png
#[tauri::command]
fn save_clipboard_image(base64: String) -> Result<String, String> {
    // Decode base64 to bytes
    let bytes = BASE64.decode(&base64).map_err(|e| format!("Base64 decode failed: {}", e))?;

    // Generate unique filename with timestamp
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();

    let temp_dir = std::env::temp_dir();
    let filename = format!("floatty-clipboard-{}.png", timestamp);
    let path = temp_dir.join(&filename);

    // Write image to temp file
    std::fs::write(&path, bytes).map_err(|e| format!("Failed to write image: {}", e))?;

    log::info!("Saved clipboard image to {:?}", path);

    Ok(path.to_string_lossy().to_string())
}

/// Clear the entire workspace (blocks and rootIds) efficiently
#[tauri::command]
fn clear_workspace(state: State<AppState>) -> Result<(), String> {
    let inner = state.inner.as_ref()
        .ok_or_else(|| "ctx:: system unavailable".to_string())?;
    
    let doc = inner.doc.write().map_err(|e| e.to_string())?;

    // Scope mutable transaction to drop before creating read transaction
    {
        let mut txn = doc.transact_mut();

        // Clear rootIds
        let root_ids = txn.get_array("rootIds");
        if let Some(root_ids) = root_ids {
            let len = root_ids.len(&txn);
            if len > 0 {
                root_ids.remove_range(&mut txn, 0, len);
            }
        }

        // Clear blocks map
        let blocks = txn.get_map("blocks");
        if let Some(blocks) = blocks {
            let keys: Vec<String> = blocks.keys(&txn).map(|k| k.to_string()).collect();
            for key in keys {
                blocks.remove(&mut txn, &key);
            }
        }
    } // txn dropped here

    // Persist empty state (compact to single snapshot)
    let full_state = doc.transact().encode_state_as_update_v1(&StateVector::default());
    inner.db.compact_ydoc(YDOC_KEY, &full_state).map_err(|e| e.to_string())?;

    Ok(())
}

// Shell Hooks Management (FLO-55) - TEMP: Appended, needs proper placement
// ============================================================================

const SHELL_HOOKS_SCRIPT: &str = r#"# Floatty Shell Hooks - OSC 133/1337 Semantic Prompts
[[ -n "$FLOATTY_HOOKS_ACTIVE" ]] && return
export FLOATTY_HOOKS_ACTIVE=1
_floatty_cmd_started=0
_floatty_last_exit=0
_floatty_osc() { printf '\e]%s\a' "$1"; }
_floatty_precmd() {
    _floatty_last_exit=$?
    if [[ $_floatty_cmd_started -eq 1 ]]; then
        _floatty_osc "133;D;$_floatty_last_exit"
        _floatty_cmd_started=0
    fi
    _floatty_osc "1337;CurrentDir=$PWD"
    _floatty_osc "133;A"
}
_floatty_preexec() {
    _floatty_cmd_started=1
    _floatty_osc "133;C"
    _floatty_osc "1337;Command=${1//;/\;}"
}
_floatty_chpwd() { _floatty_osc "1337;CurrentDir=$PWD"; }
autoload -Uz add-zsh-hook
add-zsh-hook precmd _floatty_precmd
add-zsh-hook preexec _floatty_preexec
add-zsh-hook chpwd _floatty_chpwd
_floatty_osc "1337;CurrentDir=$PWD"
"#;

const ZSHRC_SOURCE_LINE: &str = "\n# Floatty shell hooks\n[[ -f ~/.floatty/shell-hooks.zsh ]] && source ~/.floatty/shell-hooks.zsh\n";

/// Check if shell hooks are installed in .zshrc
#[tauri::command]
fn check_hooks_installed() -> Result<bool, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let zshrc_path = PathBuf::from(&home).join(".zshrc");
    if !zshrc_path.exists() { return Ok(false); }
    let content = std::fs::read_to_string(&zshrc_path).map_err(|e| e.to_string())?;
    Ok(content.contains("floatty/shell-hooks.zsh"))
}

/// Install shell hooks: write script and patch .zshrc
#[tauri::command]
fn install_shell_hooks() -> Result<(), String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let floatty_dir = PathBuf::from(&home).join(".floatty");
    let hooks_path = floatty_dir.join("shell-hooks.zsh");
    let zshrc_path = PathBuf::from(&home).join(".zshrc");
    
    std::fs::create_dir_all(&floatty_dir).map_err(|e| e.to_string())?;
    std::fs::write(&hooks_path, SHELL_HOOKS_SCRIPT).map_err(|e| e.to_string())?;
    log::info!("Wrote shell hooks to {:?}", hooks_path);
    
    let zshrc_content = if zshrc_path.exists() {
        std::fs::read_to_string(&zshrc_path).map_err(|e| e.to_string())?
    } else { String::new() };
    
    if !zshrc_content.contains("floatty/shell-hooks.zsh") {
        let mut file = std::fs::OpenOptions::new()
            .create(true).append(true).open(&zshrc_path).map_err(|e| e.to_string())?;
        use std::io::Write;
        file.write_all(ZSHRC_SOURCE_LINE.as_bytes()).map_err(|e| e.to_string())?;
        log::info!("Added source line to {:?}", zshrc_path);
    }
    Ok(())
}

/// Uninstall shell hooks: remove source line from .zshrc  
#[tauri::command]
fn uninstall_shell_hooks() -> Result<(), String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let zshrc_path = PathBuf::from(&home).join(".zshrc");
    if !zshrc_path.exists() { return Ok(()); }
    
    let content = std::fs::read_to_string(&zshrc_path).map_err(|e| e.to_string())?;
    let filtered: Vec<&str> = content.lines()
        .filter(|line| !line.contains("floatty/shell-hooks.zsh") && !line.contains("# Floatty shell hooks"))
        .collect();
    std::fs::write(&zshrc_path, filtered.join("\n")).map_err(|e| e.to_string())?;
    log::info!("Removed floatty hooks from {:?}", zshrc_path);
    Ok(())
}
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = tauri::generate_context!();

    // Load config from ~/.floatty/config.toml (or defaults)
    let config = AggregatorConfig::load();

    // Try to initialize database and ctx aggregation
    let inner = match CtxDatabase::open() {
        Ok(db) => {
            // Load persistent state into in-memory Doc
            let doc = Doc::new();
            let mut loaded_from_updates = false;

            // Try loading from append-only updates first (new format)
            if let Ok(updates) = db.get_ydoc_updates(YDOC_KEY) {
                if !updates.is_empty() {
                    log::info!("Replaying {} Y.Doc updates from append-only storage", updates.len());
                    let mut txn = doc.transact_mut();
                    let mut decode_errors = 0;
                    let mut apply_errors = 0;

                    for update_bytes in updates {
                        match Update::decode_v1(&update_bytes) {
                            Ok(u) => {
                                if let Err(e) = txn.apply_update(u) {
                                    log::error!("Failed to apply Y.Doc update: {}", e);
                                    apply_errors += 1;
                                }
                            }
                            Err(e) => {
                                log::error!("Corrupted Y.Doc update, cannot decode: {}", e);
                                decode_errors += 1;
                            }
                        }
                    }

                    if decode_errors > 0 || apply_errors > 0 {
                        log::warn!(
                            "Y.Doc replay completed with {} decode errors, {} apply errors",
                            decode_errors, apply_errors
                        );
                    }
                    loaded_from_updates = true;
                }
            }

            // Fall back to legacy system_state for migration (bounded retries)
            const MAX_MIGRATION_ATTEMPTS: u32 = 3;
            let migration_attempts: u32 = db.get_system_state("ydoc_migration_attempts")
                .ok()
                .flatten()
                .and_then(|bytes| String::from_utf8(bytes).ok())
                .and_then(|s| s.parse().ok())
                .unwrap_or(0);

            if !loaded_from_updates && migration_attempts < MAX_MIGRATION_ATTEMPTS {
                if let Ok(Some(state_bytes)) = db.get_system_state("ydoc") {
                    if !state_bytes.is_empty() {
                        log::info!(
                            "Migrating Y.Doc from legacy system_state to append-only ({} bytes, attempt {}/{})",
                            state_bytes.len(), migration_attempts + 1, MAX_MIGRATION_ATTEMPTS
                        );
                        let mut txn = doc.transact_mut();
                        match Update::decode_v1(&state_bytes) {
                            Ok(u) => {
                                if let Err(e) = txn.apply_update(u) {
                                    log::error!("Failed to apply legacy Y.Doc state: {}", e);
                                    // Decode worked but apply failed - likely corrupt, increment attempts
                                    let new_attempts = migration_attempts + 1;
                                    let _ = db.set_system_state("ydoc_migration_attempts", new_attempts.to_string().as_bytes());
                                } else {
                                    // Migrate to new format
                                    if let Err(e) = db.append_ydoc_update(YDOC_KEY, &state_bytes) {
                                        log::error!(
                                            "Failed to migrate Y.Doc to append-only storage: {} (attempt {}/{}). \
                                             Legacy data loaded but not migrated. Check disk space/permissions.",
                                            e, migration_attempts + 1, MAX_MIGRATION_ATTEMPTS
                                        );
                                        // Transient failure possible - increment attempts for bounded retry
                                        let new_attempts = migration_attempts + 1;
                                        let _ = db.set_system_state("ydoc_migration_attempts", new_attempts.to_string().as_bytes());
                                    } else {
                                        log::info!("Successfully migrated Y.Doc from legacy to append-only format");
                                        // Clear attempts on success (migration complete)
                                        let _ = db.set_system_state("ydoc_migration_attempts", b"0");
                                    }
                                }
                            },
                            Err(e) => {
                                log::error!("Failed to decode legacy Y.Doc state: {} (attempt {}/{})", e, migration_attempts + 1, MAX_MIGRATION_ATTEMPTS);
                                // Decode failed - likely corrupt data, increment attempts
                                let new_attempts = migration_attempts + 1;
                                let _ = db.set_system_state("ydoc_migration_attempts", new_attempts.to_string().as_bytes());
                            },
                        }
                    }
                }
            } else if migration_attempts >= MAX_MIGRATION_ATTEMPTS {
                log::warn!("Y.Doc migration skipped: max attempts ({}) reached. Manual intervention may be needed.", MAX_MIGRATION_ATTEMPTS);
            }

            let db = Arc::new(db);

            // Create watcher and parser with loaded config
            let watcher_config = WatcherConfig {
                watch_path: std::path::PathBuf::from(&config.watch_path),
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
            let doc_arc = Arc::new(RwLock::new(doc)); // Wrap once here

            match CtxParser::new(Arc::clone(&db), parser_config, Arc::clone(&doc_arc)) {
                Ok(parser) => {
                    // Start background workers
                    watcher.start();
                    parser.start();

                    log::info!("ctx:: aggregation system initialized successfully");
                    Some(AppStateInner {
                        db,
                        watcher,
                        parser,
                        doc: doc_arc,
                        updates_since_compact_check: std::sync::atomic::AtomicI64::new(0),
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
    let state = AppState { inner };

    // Build app with platform-specific plugins and commands
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_pty::init())
        .plugin(tauri_plugin_clipboard::init());

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
                    get_initial_state,
                    apply_update,
                    execute_shell_command,
                    execute_ai_command,
                    clear_workspace,
                    save_clipboard_image,
                    check_hooks_installed,
                    install_shell_hooks,
                    uninstall_shell_hooks,
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
                    get_initial_state,
                    apply_update,
                    execute_shell_command,
                    execute_ai_command,
                    clear_workspace,
                    save_clipboard_image,
                    check_hooks_installed,
                    install_shell_hooks,
                    uninstall_shell_hooks,
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
                        log::info!("[panel] Intercepted close for {}, hiding instead", window.label());
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
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(context)
        .expect("error while running tauri application");
}

// ============================================================================
