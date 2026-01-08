# Rust Modularization Guide - Preventing God Files

> How to keep `lib.rs` lean and maintainable

## The Problem

**Current state**: `src-tauri/src/lib.rs` is 658 lines and growing.

**Contents**:
- State management (AppState, AppStateInner)
- 18+ Tauri commands across multiple domains
- Application bootstrap logic
- Shell hook installation scripts
- Y.Doc migration logic
- Workspace clearing operations
- Window event handlers

**Pattern**: Everything gets added to `lib.rs` because it's the "obvious place" for Tauri commands.

---

## The Rule

> **`lib.rs` should be under 150 lines and contain ONLY:**
> 1. Module declarations
> 2. Application state structs
> 3. The `run()` function that wires everything together
> 
> **Everything else goes in domain modules.**

---

## Target Architecture

### File Structure

```
src-tauri/src/
├── lib.rs                    # 100-150 lines: state + run() ONLY
├── commands/                 # Tauri command implementations
│   ├── mod.rs                # Re-exports all commands for lib.rs
│   ├── ctx.rs                # get_ctx_markers, get_ctx_counts, clear_ctx_markers
│   ├── config.rs             # get_ctx_config, set_ctx_config, get_theme, set_theme
│   ├── executors.rs          # execute_shell_command, execute_ai_command
│   ├── clipboard.rs          # save_clipboard_image
│   ├── workspace.rs          # get/save_workspace_state, clear_workspace
│   └── shell_hooks.rs        # check/install/uninstall_shell_hooks
├── services/                 # Business logic (no Tauri deps)
│   ├── shell_executor.rs     # Shell command execution logic
│   ├── ai_executor.rs        # Ollama integration
│   └── workspace_manager.rs  # Workspace operations
├── state.rs                  # AppState, AppStateInner
├── bootstrap.rs              # App initialization (YDoc migration, etc.)
├── config.rs                 # Existing
├── ctx_parser.rs             # Existing
├── ctx_watcher.rs            # Existing
├── daily_view.rs             # Existing
├── db.rs                     # Existing
├── panel.rs                  # Existing (macOS)
├── server.rs                 # Existing
└── main.rs                   # Existing
```

---

## Refactored `lib.rs` (Target: ~120 lines)

```rust
// src-tauri/src/lib.rs

mod bootstrap;
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
mod state;
mod sync_test;

use state::AppState;
use tauri::Manager;

/// Entry point for Tauri application
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = tauri::generate_context!();
    
    // Initialize application state (db, server, ctx system)
    let state = bootstrap::initialize_app();
    
    // Build app with platform-specific plugins
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_pty::init())
        .plugin(tauri_plugin_clipboard::init())
        .plugin(tauri_plugin_dialog::init());
    
    #[cfg(target_os = "macos")]
    {
        builder = builder.plugin(tauri_nspanel::init());
    }
    
    builder
        .manage(state)
        .invoke_handler(commands::handler())
        .on_window_event(window_event_handler)
        .setup(setup_handler)
        .run(context)
        .expect("error while running tauri application");
}

/// Window event handler (panel close interception on macOS)
fn window_event_handler(window: &tauri::Window, event: &tauri::WindowEvent) {
    #[cfg(target_os = "macos")]
    {
        use tauri_nspanel::ManagerExt;
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            if window.app_handle().get_webview_panel(window.label()).is_ok() {
                let _ = window.hide();
                api.prevent_close();
                log::info!("[panel] Hiding {} instead of closing", window.label());
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, event);
    }
}

/// App setup handler (window title, logging)
fn setup_handler(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    // Set window title with build mode
    if let Some(window) = app.get_webview_window("main") {
        let build_mode = if cfg!(debug_assertions) { "dev" } else { "release" };
        let _ = window.set_title(&format!("floatty ({})", build_mode));
    }
    
    // Dev logging
    if cfg!(debug_assertions) {
        app.handle().plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Webview),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir { file_name: None }),
                ])
                .build(),
        )?;
    }
    Ok(())
}
```

**Result**: `lib.rs` is ~90 lines, no business logic, easy to understand.

---

## Module Organization Rules

### 1. Commands Module (`commands/mod.rs`)

**Purpose**: Thin adapter layer between Tauri and business logic.

**Pattern**:
```rust
// commands/executors.rs

use crate::services::shell_executor;
use tauri::State;
use crate::state::AppState;

#[tauri::command]
pub async fn execute_shell_command(command: String) -> Result<String, String> {
    shell_executor::execute(command).await
}

#[tauri::command]
pub async fn execute_ai_command(prompt: String) -> Result<String, String> {
    let config = crate::config::AggregatorConfig::load();
    crate::services::ai_executor::execute(prompt, config).await
}
```

**Rules**:
- ✅ Commands should be 1-10 lines (thin wrappers)
- ✅ Extract state, delegate to services
- ✅ Convert Result types (business → Tauri)
- ❌ NO business logic in commands
- ❌ NO direct DB access (use services)

**Registration** (`commands/mod.rs`):
```rust
// commands/mod.rs

mod clipboard;
mod config;
mod ctx;
mod executors;
mod shell_hooks;
mod workspace;

use tauri::generate_handler;

/// Generate Tauri command handler for all commands
pub fn handler() -> impl Fn(tauri::Invoke) + Send + Sync + 'static {
    #[cfg(not(target_os = "macos"))]
    {
        generate_handler![
            ctx::get_ctx_markers,
            ctx::get_ctx_counts,
            ctx::clear_ctx_markers,
            config::get_ctx_config,
            config::set_ctx_config,
            config::get_theme,
            config::set_theme,
            config::get_server_info,
            executors::execute_shell_command,
            executors::execute_ai_command,
            crate::daily_view::execute_daily_command,
            clipboard::save_clipboard_image,
            workspace::clear_workspace,
            workspace::get_workspace_state,
            workspace::save_workspace_state,
            shell_hooks::check_hooks_installed,
            shell_hooks::install_shell_hooks,
            shell_hooks::uninstall_shell_hooks,
        ]
    }
    
    #[cfg(target_os = "macos")]
    {
        generate_handler![
            // ... same as above ...
            crate::panel::show_test_panel,
            crate::panel::hide_test_panel,
            crate::panel::toggle_test_panel,
        ]
    }
}
```

---

### 2. Services Module (`services/`)

**Purpose**: Business logic, no Tauri dependencies.

**Pattern**:
```rust
// services/shell_executor.rs

use crate::config::AggregatorConfig;
use std::process::Command;

/// Execute shell command through user's shell
pub async fn execute(command: String) -> Result<String, String> {
    if command.trim().is_empty() {
        return Ok(String::new());
    }
    
    let config = AggregatorConfig::load();
    let max_bytes = config.max_shell_output_bytes;
    
    tokio::task::spawn_blocking(move || {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
        
        let output = Command::new(&shell)
            .arg("-l")
            .arg("-c")
            .arg(&command)
            .output()
            .map_err(|e| format!("Failed to execute: {}", e))?;
        
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        
        let result = if output.status.success() {
            stdout.to_string()
        } else {
            format!("{}\nError: {}", stdout, stderr)
        };
        
        Ok(truncate_output(result, max_bytes))
    })
    .await
    .map_err(|e| e.to_string())?
}

fn truncate_output(result: String, max_bytes: usize) -> String {
    if result.len() <= max_bytes {
        return result;
    }
    
    let mut safe_max = max_bytes;
    while safe_max > 0 && !result.is_char_boundary(safe_max) {
        safe_max -= 1;
    }
    
    let cut_point = result[..safe_max].rfind('\n').unwrap_or(safe_max);
    format!(
        "{}\n\n... [truncated: {} → {} bytes]",
        &result[..cut_point],
        result.len(),
        cut_point
    )
}
```

**Rules**:
- ✅ Pure Rust, no Tauri types
- ✅ Testable without Tauri runtime
- ✅ Single responsibility
- ✅ Error handling with Result
- ❌ NO `#[tauri::command]` annotations
- ❌ NO `State<AppState>` parameters

---

### 3. State Module (`state.rs`)

**Purpose**: Application state structs and initialization logic.

```rust
// state.rs

use crate::ctx_parser::CtxParser;
use crate::ctx_watcher::CtxWatcher;
use crate::db::FloattyDb;
use crate::server::ServerState;
use floatty_core::YDocStore;
use std::sync::Arc;

/// Inner state when ctx:: system is available
pub struct AppStateInner {
    pub db: Arc<FloattyDb>,
    #[allow(dead_code)]
    pub watcher: CtxWatcher,
    #[allow(dead_code)]
    pub parser: CtxParser,
    pub store: YDocStore,
}

/// Managed state wrapper
pub struct AppState {
    pub inner: Option<AppStateInner>,
    pub server: Option<ServerState>,
}
```

---

### 4. Bootstrap Module (`bootstrap.rs`)

**Purpose**: App initialization, Y.Doc migration, ctx system setup.

```rust
// bootstrap.rs

use crate::config::AggregatorConfig;
use crate::ctx_parser::{CtxParser, ParserConfig};
use crate::ctx_watcher::{CtxWatcher, WatcherConfig};
use crate::db::FloattyDb;
use crate::server::spawn_server;
use crate::state::{AppState, AppStateInner};
use floatty_core::YDocStore;
use std::sync::Arc;

const DEFAULT_SERVER_PORT: u16 = 8765;

/// Initialize application state (db, server, ctx system)
pub fn initialize_app() -> AppState {
    let config = AggregatorConfig::load();
    let server_state = spawn_server(DEFAULT_SERVER_PORT);
    
    let inner = match FloattyDb::open() {
        Ok(db) => {
            // Y.Doc migration
            migrate_ydoc_if_needed(&db);
            
            let db = Arc::new(db);
            
            // Create YDocStore
            let store = match YDocStore::new() {
                Ok(s) => s,
                Err(e) => {
                    log::error!("Failed to create YDocStore: {}", e);
                    return AppState { inner: None, server: server_state };
                }
            };
            
            // Initialize ctx system
            initialize_ctx_system(db, &config, &store)
        }
        Err(e) => {
            log::error!("Failed to open database: {}", e);
            None
        }
    };
    
    AppState { inner, server: server_state }
}

fn migrate_ydoc_if_needed(db: &FloattyDb) {
    // ... 50 lines of migration logic ...
}

fn initialize_ctx_system(
    db: Arc<FloattyDb>,
    config: &AggregatorConfig,
    store: &YDocStore,
) -> Option<AppStateInner> {
    // ... watcher + parser setup ...
}
```

---

## Decision Matrix: Where Does This Code Go?

| Code Type | Location | Example |
|-----------|----------|---------|
| Tauri command definition | `commands/*.rs` | `#[tauri::command] fn foo()` |
| Business logic | `services/*.rs` | Shell execution, AI calls |
| State structs | `state.rs` | AppState, AppStateInner |
| App initialization | `bootstrap.rs` | DB setup, migrations |
| Tauri wiring | `lib.rs` | `run()`, plugin registration |
| Domain models | `src-tauri/models/*.rs` | Types shared across modules |
| Database operations | `db.rs` | SQL queries, schema |
| External integrations | Dedicated module | `ollama.rs`, `daily_view.rs` |

---

## Migration Plan (For Current `lib.rs`)

### Step 1: Extract Commands (1-2 hours)

```bash
# Create commands directory
mkdir -p src-tauri/src/commands

# Extract each command group
touch src-tauri/src/commands/{mod.rs,ctx.rs,config.rs,executors.rs,clipboard.rs,workspace.rs,shell_hooks.rs}
```

Move commands preserving functionality:
- ctx commands → `commands/ctx.rs`
- config commands → `commands/config.rs`
- execute_* → `commands/executors.rs`
- clipboard → `commands/clipboard.rs`
- workspace → `commands/workspace.rs`
- shell hooks → `commands/shell_hooks.rs`

### Step 2: Extract Services (1-2 hours)

```bash
mkdir -p src-tauri/src/services
touch src-tauri/src/services/{mod.rs,shell_executor.rs,ai_executor.rs,workspace_manager.rs}
```

Extract business logic from commands into services (remove Tauri deps).

### Step 3: Extract State & Bootstrap (1 hour)

```bash
touch src-tauri/src/{state.rs,bootstrap.rs}
```

Move AppState structs and initialization logic.

### Step 4: Slim Down `lib.rs` (30 minutes)

Keep only:
- Module declarations
- `run()` function
- Window/setup event handlers

---

## Guidance for Future AI Agents

### When Adding New Features

**❌ DON'T**:
```rust
// Adding directly to lib.rs
#[tauri::command]
fn new_feature() -> Result<String, String> {
    // 50 lines of business logic
}
```

**✅ DO**:
```rust
// 1. Create service: src-tauri/src/services/new_feature.rs
pub fn execute() -> Result<String, String> {
    // Business logic here
}

// 2. Create command: src-tauri/src/commands/new_feature.rs
#[tauri::command]
pub async fn new_feature() -> Result<String, String> {
    crate::services::new_feature::execute().await
}

// 3. Register in commands/mod.rs
pub use new_feature::new_feature;

// In handler():
generate_handler![
    // ... existing ...
    new_feature::new_feature,
]
```

### Command Size Guidelines

- **Simple commands** (config, getters): 3-5 lines
- **Medium commands** (with validation): 10-15 lines
- **Complex commands** (multiple steps): Extract to service, command stays <10 lines

**If your command is >15 lines, extract business logic to a service.**

### Test Strategy

```rust
// services/shell_executor.rs - TESTABLE
#[cfg(test)]
mod tests {
    use super::*;
    
    #[tokio::test]
    async fn test_execute_success() {
        let result = execute("echo hello".to_string()).await.unwrap();
        assert_eq!(result.trim(), "hello");
    }
}
```

Services are pure Rust → easy to test.  
Commands are thin wrappers → integration tests only.

---

## Benefits

1. **Maintainability**: `lib.rs` stays <150 lines forever
2. **Testability**: Services have no Tauri deps
3. **Discoverability**: Commands grouped by domain
4. **Reusability**: Services can be called from multiple commands
5. **Future-proofing**: Easy to migrate to server-side (services stay same)

---

## Enforcement

### Pre-commit Hook

```bash
#!/bin/bash
# .git/hooks/pre-commit

LIB_RS="src-tauri/src/lib.rs"
MAX_LINES=200

if [ -f "$LIB_RS" ]; then
    LINES=$(wc -l < "$LIB_RS")
    if [ "$LINES" -gt "$MAX_LINES" ]; then
        echo "❌ $LIB_RS is $LINES lines (limit: $MAX_LINES)"
        echo "   Extract commands to src-tauri/src/commands/"
        echo "   See docs/architecture/RUST_MODULARIZATION_GUIDE.md"
        exit 1
    fi
fi
```

### CI Check

```yaml
# .github/workflows/lint.yml
- name: Check lib.rs size
  run: |
    LINES=$(wc -l < src-tauri/src/lib.rs)
    if [ $LINES -gt 200 ]; then
      echo "lib.rs too large: $LINES lines"
      exit 1
    fi
```

---

## Related

- `HANDLER_REGISTRY_IMPLEMENTATION.md` - Frontend handler consolidation
- `FLOATTY_HANDLER_REGISTRY.md` - Future Rust handler registry
- `ARCHITECTURE_REVIEW_2026_01_08.md` - Overall architecture

---

## TL;DR for AI Agents

**When adding a new Tauri command:**

1. Business logic → `services/feature_name.rs` (pure Rust, testable)
2. Tauri wrapper → `commands/feature_name.rs` (thin, 3-10 lines)
3. Registration → `commands/mod.rs` (one line in `generate_handler![]`)

**Never add business logic directly to `lib.rs`. It should stay under 150 lines.**
