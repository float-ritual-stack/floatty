mod ctx_parser;
mod ctx_watcher;
mod db;
mod shelf;

use ctx_parser::{CtxParser, ParserConfig};
use ctx_watcher::{CtxWatcher, WatcherConfig};
use db::{CtxDatabase, CtxMarker};
use serde::{Deserialize, Serialize};
use shelf::{Shelf, ShelfDatabase, ShelfItem, ShelfStorage};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::State;

/// Aggregator configuration (stored/loaded from ~/.floatty/config.toml)
#[derive(Clone, Serialize, Deserialize)]
pub struct AggregatorConfig {
    pub watch_path: String,
    pub ollama_endpoint: String,
    pub ollama_model: String,
    pub poll_interval_ms: u64,
    pub max_retries: i32,
    pub max_age_hours: u64,
}

impl Default for AggregatorConfig {
    fn default() -> Self {
        let default_watcher = WatcherConfig::default();
        let default_parser = ParserConfig::default();

        Self {
            watch_path: default_watcher.watch_path.to_string_lossy().to_string(),
            ollama_endpoint: default_parser.endpoint,
            ollama_model: default_parser.model,
            poll_interval_ms: default_parser.poll_interval_ms,
            max_retries: default_parser.max_retries,
            max_age_hours: 72, // Default: last 3 days (matches CLAUDE.md docs)
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
}

/// Managed state wrapper - inner is None when DB initialization fails
pub struct AppState {
    inner: Option<AppStateInner>,
}

/// Shelf system state
/// - db is Option to allow graceful degradation if database fails to open
/// - storage is Mutex-wrapped for thread-safe concurrent access
pub struct ShelfState {
    db: Option<Arc<ShelfDatabase>>,
    storage: Mutex<ShelfStorage>,
}

// ============================================================================
// Shelf Commands
// ============================================================================

/// Create a new shelf, optionally at a specific position
#[tauri::command]
fn create_shelf(
    app: tauri::AppHandle,
    state: State<ShelfState>,
    position: Option<(f64, f64)>,
) -> Result<Shelf, String> {
    let db = state.db.as_ref()
        .ok_or_else(|| "Shelf system unavailable: database failed to initialize".to_string())?;

    let id = uuid::Uuid::new_v4().to_string();
    let shelf = Shelf::new(id, position);

    // Save to database
    db.create_shelf(&shelf).map_err(|e| e.to_string())?;

    // Create and show the panel (macOS)
    #[cfg(target_os = "macos")]
    shelf::panel::create_panel(&app, &shelf)?;

    log::info!("Created shelf: {}", shelf.id);
    Ok(shelf)
}

/// Get all shelves
#[tauri::command]
fn get_shelves(state: State<ShelfState>) -> Result<Vec<Shelf>, String> {
    let db = state.db.as_ref()
        .ok_or_else(|| "Shelf system unavailable: database failed to initialize".to_string())?;
    db.get_all_shelves().map_err(|e| e.to_string())
}

/// Get a specific shelf
#[tauri::command]
fn get_shelf(state: State<ShelfState>, shelf_id: String) -> Result<Option<Shelf>, String> {
    let db = state.db.as_ref()
        .ok_or_else(|| "Shelf system unavailable: database failed to initialize".to_string())?;
    db.get_shelf(&shelf_id).map_err(|e| e.to_string())
}

/// Add files to a shelf
#[tauri::command]
fn add_to_shelf(
    state: State<ShelfState>,
    shelf_id: String,
    paths: Vec<String>,
) -> Result<Vec<ShelfItem>, String> {
    let db = state.db.as_ref()
        .ok_or_else(|| "Shelf system unavailable: database failed to initialize".to_string())?;
    let storage = state.storage.lock()
        .map_err(|e| format!("Storage lock poisoned: {}", e))?;

    let mut items = Vec::new();

    for path_str in paths {
        let path = PathBuf::from(&path_str);
        if !path.exists() {
            log::warn!("Skipping non-existent path: {}", path_str);
            continue;
        }

        // Copy file to shelf storage
        let item = storage.add_file(&shelf_id, &path)?;

        // Save to database
        db.add_item(&item).map_err(|e| e.to_string())?;

        items.push(item);
    }

    log::info!("Added {} items to shelf {}", items.len(), shelf_id);
    Ok(items)
}

/// Get items in a shelf
#[tauri::command]
fn get_shelf_items(state: State<ShelfState>, shelf_id: String) -> Result<Vec<ShelfItem>, String> {
    let db = state.db.as_ref()
        .ok_or_else(|| "Shelf system unavailable: database failed to initialize".to_string())?;
    db.get_shelf_items(&shelf_id).map_err(|e| e.to_string())
}

/// Delete a shelf and all its contents
#[tauri::command]
fn delete_shelf(
    app: tauri::AppHandle,
    state: State<ShelfState>,
    shelf_id: String,
) -> Result<(), String> {
    let db = state.db.as_ref()
        .ok_or_else(|| "Shelf system unavailable: database failed to initialize".to_string())?;
    let storage = state.storage.lock()
        .map_err(|e| format!("Storage lock poisoned: {}", e))?;

    // Close panel first (macOS)
    #[cfg(target_os = "macos")]
    {
        let _ = shelf::panel::close_panel(&app, &shelf_id);
    }

    #[cfg(not(target_os = "macos"))]
    let _ = &app; // Suppress unused warning

    // Delete storage
    storage.delete_shelf_storage(&shelf_id)?;

    // Delete from database
    db.delete_shelf(&shelf_id).map_err(|e| e.to_string())?;

    log::info!("Deleted shelf: {}", shelf_id);
    Ok(())
}

/// Delete a single item from a shelf
#[tauri::command]
fn delete_shelf_item(state: State<ShelfState>, item_id: String) -> Result<(), String> {
    let db = state.db.as_ref()
        .ok_or_else(|| "Shelf system unavailable: database failed to initialize".to_string())?;
    let storage = state.storage.lock()
        .map_err(|e| format!("Storage lock poisoned: {}", e))?;

    // Get item to find stored path
    if let Some(item) = db.get_item(&item_id).map_err(|e| e.to_string())? {
        // Delete file
        storage.delete_item(&item.stored_path)?;

        // Delete from database
        db.delete_item(&item_id).map_err(|e| e.to_string())?;

        log::info!("Deleted shelf item: {}", item_id);
    }
    Ok(())
}

/// Move an item out of a shelf to a destination path
#[tauri::command]
fn move_shelf_item(
    state: State<ShelfState>,
    item_id: String,
    dest_path: String,
) -> Result<(), String> {
    let db = state.db.as_ref()
        .ok_or_else(|| "Shelf system unavailable: database failed to initialize".to_string())?;
    let storage = state.storage.lock()
        .map_err(|e| format!("Storage lock poisoned: {}", e))?;

    if let Some(item) = db.get_item(&item_id).map_err(|e| e.to_string())? {
        let dest = PathBuf::from(&dest_path);

        // Move file
        storage.move_item_out(&item.stored_path, &dest)?;

        // Delete from database
        db.delete_item(&item_id).map_err(|e| e.to_string())?;

        log::info!("Moved shelf item {} to {}", item_id, dest_path);
    }
    Ok(())
}

/// Show a shelf panel (macOS)
#[tauri::command]
fn show_shelf_panel(
    app: tauri::AppHandle,
    state: State<ShelfState>,
    shelf_id: String,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let db = state.db.as_ref()
            .ok_or_else(|| "Shelf system unavailable: database failed to initialize".to_string())?;

        // If panel doesn't exist, create it
        if !shelf::panel::panel_exists(&app, &shelf_id) {
            let shelf = db.get_shelf(&shelf_id).map_err(|e| e.to_string())?
                .ok_or_else(|| format!("Shelf {} not found", shelf_id))?;
            shelf::panel::create_panel(&app, &shelf)?;
        } else {
            shelf::panel::show_panel(&app, &shelf_id)?;
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (&app, &state, &shelf_id);
        log::warn!("Shelf panels are only supported on macOS");
    }

    Ok(())
}

/// Hide a shelf panel (macOS)
#[tauri::command]
fn hide_shelf_panel(
    app: tauri::AppHandle,
    shelf_id: String,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    shelf::panel::hide_panel(&app, &shelf_id)?;

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (&app, &shelf_id);
    }

    Ok(())
}

/// Show all existing shelf panels (macOS)
#[tauri::command]
fn show_all_shelf_panels(app: tauri::AppHandle, state: State<ShelfState>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let db = state.db.as_ref()
            .ok_or_else(|| "Shelf system unavailable: database failed to initialize".to_string())?;

        // Get all shelves and create/show panels for them
        let shelves = db.get_all_shelves().map_err(|e| e.to_string())?;
        for shelf in shelves {
            if !shelf::panel::panel_exists(&app, &shelf.id) {
                shelf::panel::create_panel(&app, &shelf)?;
            } else {
                shelf::panel::show_panel(&app, &shelf.id)?;
            }
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (&app, &state);
    }

    Ok(())
}

/// Update shelf position (called when panel is moved)
#[tauri::command]
fn update_shelf_position(
    state: State<ShelfState>,
    shelf_id: String,
    x: f64,
    y: f64,
) -> Result<(), String> {
    let db = state.db.as_ref()
        .ok_or_else(|| "Shelf system unavailable: database failed to initialize".to_string())?;
    db.update_shelf_position(&shelf_id, x, y).map_err(|e| e.to_string())
}

/// Update shelf size (called when panel is resized)
#[tauri::command]
fn update_shelf_size(
    state: State<ShelfState>,
    shelf_id: String,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let db = state.db.as_ref()
        .ok_or_else(|| "Shelf system unavailable: database failed to initialize".to_string())?;
    db.update_shelf_size(&shelf_id, width, height).map_err(|e| e.to_string())
}

// ============================================================================
// Context Aggregator Commands
// ============================================================================

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

/// Clear all ctx:: markers and reset database
#[tauri::command]
fn clear_ctx_markers(state: State<AppState>) -> Result<(), String> {
    let inner = state.inner.as_ref()
        .ok_or_else(|| "ctx:: system unavailable: database failed to initialize".to_string())?;

    inner.db.clear_all().map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = tauri::generate_context!();

    // Load config from ~/.floatty/config.toml (or defaults)
    let config = AggregatorConfig::load();

    // Try to initialize database and ctx aggregation
    let inner = match CtxDatabase::open() {
        Ok(db) => {
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
            match CtxParser::new(Arc::clone(&db), parser_config) {
                Ok(parser) => {
                    // Start background workers
                    watcher.start();
                    parser.start();

                    log::info!("ctx:: aggregation system initialized successfully");
                    Some(AppStateInner { db, watcher, parser })
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
    let app_state = AppState { inner };

    // Initialize shelf system (with graceful degradation like ctx system)
    let shelf_db = match ShelfDatabase::open() {
        Ok(db) => {
            log::info!("Shelf database initialized successfully");
            Some(Arc::new(db))
        }
        Err(e) => {
            log::error!("Failed to open shelf database: {}", e);
            log::error!("Shelf functionality will be unavailable. Check ~/.floatty permissions.");
            None
        }
    };

    let shelf_state = ShelfState {
        db: shelf_db,
        storage: Mutex::new(ShelfStorage::new()),
    };

    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_pty::init())
        .plugin(tauri_plugin_fs::init());

    // Add NSPanel plugin on macOS
    #[cfg(target_os = "macos")]
    {
        builder = builder.plugin(tauri_nspanel::init());
    }

    builder
        .manage(app_state)
        .manage(shelf_state)
        .invoke_handler(tauri::generate_handler![
            // Context aggregator commands
            get_ctx_markers,
            get_ctx_counts,
            get_ctx_config,
            set_ctx_config,
            clear_ctx_markers,
            // Shelf commands
            create_shelf,
            get_shelves,
            get_shelf,
            add_to_shelf,
            get_shelf_items,
            delete_shelf,
            delete_shelf_item,
            move_shelf_item,
            show_shelf_panel,
            hide_shelf_panel,
            show_all_shelf_panels,
            update_shelf_position,
            update_shelf_size,
        ])
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
