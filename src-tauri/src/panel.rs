//! Minimal NSPanel spike - testing show/hide/toggle without complex features.
//!
//! macOS only - this entire module is gated by cfg(target_os = "macos").
#![cfg(target_os = "macos")]
//!
//! Learnings from Dec 22 attempt:
//! - Remove .closable() to avoid foreign exception crash
//! - Use hide() not close() for panel lifecycle
//! - Lazy init to avoid race with main window

use tauri::{AppHandle, Manager, WebviewUrl};
use tauri_nspanel::{tauri_panel, ManagerExt, WebviewWindowExt, PanelLevel};
use std::sync::{Once, OnceLock};

// Define our panel type using the tauri_panel! macro
tauri_panel! {
    panel!(TestPanel {
        config: {
            can_become_key_window: true,
            is_floating_panel: true
        }
    })
}

const PANEL_LABEL: &str = "test-panel";

// Once guard for thread-safe initialization (fixes TOCTOU race with AtomicBool)
static PANEL_INIT: Once = Once::new();
// Store initialization error if it occurred
static PANEL_INIT_ERROR: OnceLock<String> = OnceLock::new();

/// Create the test panel (called lazily on first toggle)
/// Uses Once to prevent TOCTOU race condition where two threads could both
/// pass the "not created" check and try to create duplicate panels.
fn ensure_panel_exists(app: &AppHandle) -> Result<(), String> {
    // Check if previous init failed
    if let Some(err) = PANEL_INIT_ERROR.get() {
        return Err(err.clone());
    }

    // Thread-safe once-only initialization
    PANEL_INIT.call_once(|| {
        log::info!("[panel] Creating test panel...");

        // Create a simple webview window first
        let window = match tauri::WebviewWindowBuilder::new(
            app,
            PANEL_LABEL,
            WebviewUrl::App("panel.html".into()),
        )
        .title("Test Panel")
        .inner_size(300.0, 200.0)
        .visible(false)  // Start hidden
        .build() {
            Ok(w) => w,
            Err(e) => {
                let err = format!("Failed to create window: {}", e);
                let _ = PANEL_INIT_ERROR.set(err);
                return;
            }
        };

        // Convert to our TestPanel type
        let panel = match window.to_panel::<TestPanel>() {
            Ok(p) => p,
            Err(e) => {
                let err = format!("Failed to convert to panel: {:?}", e);
                let _ = PANEL_INIT_ERROR.set(err);
                return;
            }
        };

        // Configure panel behavior
        panel.set_level(PanelLevel::Floating.into());

        // Close button is now safe - on_window_event intercepts CloseRequested
        // and hides instead of destroying (see lib.rs)

        log::info!("[panel] Test panel created (hidden)");
    });

    // Check again in case init just failed
    if let Some(err) = PANEL_INIT_ERROR.get() {
        return Err(err.clone());
    }

    Ok(())
}

#[tauri::command]
pub fn show_test_panel(app: AppHandle) -> Result<(), String> {
    ensure_panel_exists(&app)?;

    match app.get_webview_panel(PANEL_LABEL) {
        Ok(panel) => {
            panel.show();
            log::info!("[panel] Showing test panel");
            Ok(())
        }
        Err(e) => Err(format!("Panel not found after creation: {:?}", e)),
    }
}

#[tauri::command]
pub fn hide_test_panel(app: AppHandle) -> Result<(), String> {
    match app.get_webview_panel(PANEL_LABEL) {
        Ok(panel) => {
            panel.hide();
            log::info!("[panel] Hiding test panel");
            Ok(())
        }
        Err(_) => {
            // Panel doesn't exist yet, nothing to hide
            Ok(())
        }
    }
}

#[tauri::command]
pub fn toggle_test_panel(app: AppHandle) -> Result<(), String> {
    ensure_panel_exists(&app)?;

    match app.get_webview_panel(PANEL_LABEL) {
        Ok(panel) => {
            if panel.is_visible() {
                panel.hide();
                log::info!("[panel] Toggled test panel: hidden");
            } else {
                panel.show();
                log::info!("[panel] Toggled test panel: visible");
            }
            Ok(())
        }
        Err(e) => Err(format!("Panel not found after creation: {:?}", e)),
    }
}
