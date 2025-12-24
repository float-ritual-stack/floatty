//! Minimal NSPanel spike - testing show/hide/toggle without complex features.
//!
//! Learnings from Dec 22 attempt:
//! - Remove .closable() to avoid foreign exception crash
//! - Use hide() not close() for panel lifecycle
//! - Lazy init to avoid race with main window

use tauri::{AppHandle, Manager, WebviewUrl};
use tauri_nspanel::{tauri_panel, ManagerExt, WebviewWindowExt, PanelLevel};
use std::sync::atomic::{AtomicBool, Ordering};

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

// Track if panel has been created (lazy init)
static PANEL_CREATED: AtomicBool = AtomicBool::new(false);

/// Create the test panel (called lazily on first toggle)
fn ensure_panel_exists(app: &AppHandle) -> Result<(), String> {
    if PANEL_CREATED.load(Ordering::SeqCst) {
        return Ok(());
    }

    log::info!("[panel] Creating test panel...");

    // Create a simple webview window first
    let window = tauri::WebviewWindowBuilder::new(
        app,
        PANEL_LABEL,
        WebviewUrl::App("panel.html".into()),
    )
    .title("Test Panel")
    .inner_size(300.0, 200.0)
    .visible(false)  // Start hidden
    .build()
    .map_err(|e| format!("Failed to create window: {}", e))?;

    // Convert to our TestPanel type
    let panel = window
        .to_panel::<TestPanel>()
        .map_err(|e| format!("Failed to convert to panel: {:?}", e))?;

    // Configure panel behavior
    panel.set_level(PanelLevel::Floating.into());

    // Close button is now safe - on_window_event intercepts CloseRequested
    // and hides instead of destroying (see lib.rs)

    PANEL_CREATED.store(true, Ordering::SeqCst);
    log::info!("[panel] Test panel created (hidden)");

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
