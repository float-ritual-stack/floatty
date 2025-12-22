//! NSPanel management for floating shelf windows (macOS only)
//!
//! Uses standalone functions instead of a struct to avoid Send+Sync issues
//! with Tauri's managed state.

use crate::shelf::Shelf;
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, WebviewUrl};
use tauri_nspanel::{tauri_panel, ManagerExt, PanelBuilder, PanelLevel};

// Define the shelf panel type using the tauri_panel! macro
tauri_panel! {
    panel!(ShelfPanel {
        config: {
            can_become_key_window: true,
            is_floating_panel: true
        }
    })
}

/// Create and show a panel for a shelf
pub fn create_panel(app: &AppHandle, shelf: &Shelf) -> Result<(), String> {
    let label = format!("shelf-{}", shelf.id);

    // Check if panel already exists
    if let Ok(panel) = app.get_webview_panel(&label) {
        panel.show();
        return Ok(());
    }

    // Build the URL with shelf ID as query param
    let url = format!("/shelf.html?id={}", shelf.id);

    // Create the floating panel
    PanelBuilder::<_, ShelfPanel>::new(app, &label)
        .url(WebviewUrl::App(url.into()))
        .title(
            shelf
                .name
                .clone()
                .unwrap_or_else(|| format!("Shelf {}", &shelf.id[..8])),
        )
        .position(LogicalPosition::new(shelf.position_x, shelf.position_y).into())
        .size(LogicalSize::new(shelf.width, shelf.height).into())
        .floating(true)
        .level(PanelLevel::Floating)
        .transparent(true)
        .corner_radius(12.0)
        .has_shadow(true)
        .movable_by_window_background(true)
        .hides_on_deactivate(false) // Stay visible when other apps focused
        .build()
        .map_err(|e| format!("Failed to create panel: {}", e))?;

    // Show the panel
    if let Ok(panel) = app.get_webview_panel(&label) {
        panel.show();
    }

    log::info!("Created shelf panel: {}", label);
    Ok(())
}

/// Show an existing panel
pub fn show_panel(app: &AppHandle, shelf_id: &str) -> Result<(), String> {
    let label = format!("shelf-{}", shelf_id);
    if let Ok(panel) = app.get_webview_panel(&label) {
        panel.show();
        Ok(())
    } else {
        Err(format!("Panel not found: {}", shelf_id))
    }
}

/// Hide a panel (but keep it alive)
pub fn hide_panel(app: &AppHandle, shelf_id: &str) -> Result<(), String> {
    let label = format!("shelf-{}", shelf_id);
    if let Ok(panel) = app.get_webview_panel(&label) {
        panel.hide();
        Ok(())
    } else {
        Err(format!("Panel not found: {}", shelf_id))
    }
}

/// Close and destroy a panel
pub fn close_panel(app: &AppHandle, shelf_id: &str) -> Result<(), String> {
    let label = format!("shelf-{}", shelf_id);

    // Try to convert to window and close
    if let Ok(panel) = app.get_webview_panel(&label) {
        if let Some(window) = panel.to_window() {
            window.close().map_err(|e| format!("Failed to close window: {}", e))?;
        }
    }

    log::info!("Closed shelf panel: {}", label);
    Ok(())
}

/// Check if a panel exists for this shelf
pub fn panel_exists(app: &AppHandle, shelf_id: &str) -> bool {
    let label = format!("shelf-{}", shelf_id);
    app.get_webview_panel(&label).is_ok()
}
