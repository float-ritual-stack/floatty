//! NSPanel management for floating shelf windows (macOS only)
//!
//! IMPORTANT: All NSPanel operations MUST run on the main thread.
//! Tauri commands run on tokio worker threads, so we use run_on_main_thread()
//! to dispatch panel operations to the main thread.

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
/// Dispatches to main thread since NSPanel ops must happen there
pub fn create_panel(app: &AppHandle, shelf: &Shelf) -> Result<(), String> {
    // Clone data we need for the closure (must be 'static)
    let app_handle = app.clone();
    let shelf_id = shelf.id.clone();
    let shelf_name = shelf.name.clone();
    let position_x = shelf.position_x;
    let position_y = shelf.position_y;
    let width = shelf.width;
    let height = shelf.height;

    // Dispatch to main thread - NSPanel operations crash if not on main thread
    app.run_on_main_thread(move || {
        let label = format!("shelf-{}", shelf_id);

        // Check if panel already exists
        if let Ok(panel) = app_handle.get_webview_panel(&label) {
            panel.show();
            return;
        }

        // Build the URL with shelf ID as query param
        let url = format!("/shelf.html?id={}", shelf_id);

        // Create the floating panel
        let result = PanelBuilder::<_, ShelfPanel>::new(&app_handle, &label)
            .url(WebviewUrl::App(url.into()))
            .title(shelf_name.unwrap_or_else(|| format!("Shelf {}", &shelf_id[..8])))
            .position(LogicalPosition::new(position_x, position_y).into())
            .size(LogicalSize::new(width, height).into())
            .floating(true)
            .level(PanelLevel::Floating)
            .transparent(true)
            .corner_radius(12.0)
            .has_shadow(true)
            .movable_by_window_background(true)
            .hides_on_deactivate(false)
            .build();

        if let Err(e) = result {
            log::error!("Failed to create panel: {}", e);
            return;
        }

        // Show the panel
        if let Ok(panel) = app_handle.get_webview_panel(&label) {
            panel.show();
        }

        log::info!("Created shelf panel: {}", label);
    }).map_err(|e| format!("Failed to dispatch to main thread: {}", e))?;

    Ok(())
}

/// Show an existing panel
/// Dispatches to main thread since NSPanel ops must happen there
pub fn show_panel(app: &AppHandle, shelf_id: &str) -> Result<(), String> {
    let app_handle = app.clone();
    let label = format!("shelf-{}", shelf_id);

    app.run_on_main_thread(move || {
        if let Ok(panel) = app_handle.get_webview_panel(&label) {
            panel.show();
        }
    }).map_err(|e| format!("Failed to dispatch to main thread: {}", e))?;

    Ok(())
}

/// Hide a panel (but keep it alive)
/// Dispatches to main thread since NSPanel ops must happen there
pub fn hide_panel(app: &AppHandle, shelf_id: &str) -> Result<(), String> {
    let app_handle = app.clone();
    let label = format!("shelf-{}", shelf_id);

    app.run_on_main_thread(move || {
        if let Ok(panel) = app_handle.get_webview_panel(&label) {
            panel.hide();
        }
    }).map_err(|e| format!("Failed to dispatch to main thread: {}", e))?;

    Ok(())
}

/// Close and destroy a panel
/// Dispatches to main thread since NSPanel ops must happen there
pub fn close_panel(app: &AppHandle, shelf_id: &str) -> Result<(), String> {
    let app_handle = app.clone();
    let label = format!("shelf-{}", shelf_id);

    app.run_on_main_thread(move || {
        if let Ok(panel) = app_handle.get_webview_panel(&label) {
            if let Some(window) = panel.to_window() {
                if let Err(e) = window.close() {
                    log::error!("Failed to close window: {}", e);
                }
            }
        }
        log::info!("Closed shelf panel: {}", label);
    }).map_err(|e| format!("Failed to dispatch to main thread: {}", e))?;

    Ok(())
}

/// Check if a panel exists for this shelf
/// Note: This doesn't need main thread as get_webview_panel just checks internal state
pub fn panel_exists(app: &AppHandle, shelf_id: &str) -> bool {
    let label = format!("shelf-{}", shelf_id);
    app.get_webview_panel(&label).is_ok()
}
