//! NSPanel management for floating shelf windows (macOS only)

use crate::shelf::Shelf;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, Runtime, WebviewUrl};
use tauri_nspanel::{ManagerExt, PanelBuilder, PanelLevel};

/// Manages shelf panels - creates, shows, hides, and tracks them
pub struct ShelfPanelManager<R: Runtime> {
    /// Track which shelves have panels open
    open_panels: Mutex<HashMap<String, bool>>,
    _phantom: std::marker::PhantomData<R>,
}

impl<R: Runtime> ShelfPanelManager<R> {
    pub fn new() -> Self {
        Self {
            open_panels: Mutex::new(HashMap::new()),
            _phantom: std::marker::PhantomData,
        }
    }

    /// Create and show a panel for a shelf
    pub fn create_panel(&self, app: &AppHandle<R>, shelf: &Shelf) -> Result<(), String> {
        let label = format!("shelf-{}", shelf.id);

        // Check if panel already exists
        {
            let panels = self.open_panels.lock().unwrap();
            if panels.contains_key(&shelf.id) {
                // Panel exists, just show it
                if let Ok(panel) = app.get_webview_panel(&label) {
                    panel.show();
                    return Ok(());
                }
            }
        }

        // Build the URL with shelf ID as query param
        let url = format!("/shelf.html?id={}", shelf.id);

        // Create the floating panel
        PanelBuilder::new(app, &label)
            .url(WebviewUrl::App(url.into()))
            .title(
                shelf
                    .name
                    .clone()
                    .unwrap_or_else(|| format!("Shelf {}", &shelf.id[..8])),
            )
            .position((shelf.position_x, shelf.position_y).into())
            .size((shelf.width, shelf.height).into())
            .floating(true)
            .level(PanelLevel::Floating)
            .transparent(true)
            .corner_radius(12.0)
            .has_shadow(true)
            .movable_by_window_background(true)
            .hides_on_deactivate(false) // Stay visible when other apps focused
            .build()
            .map_err(|e| format!("Failed to create panel: {}", e))?;

        // Track as open
        {
            let mut panels = self.open_panels.lock().unwrap();
            panels.insert(shelf.id.clone(), true);
        }

        // Show the panel
        if let Ok(panel) = app.get_webview_panel(&label) {
            panel.show();
        }

        log::info!("Created shelf panel: {}", label);
        Ok(())
    }

    /// Show an existing panel
    pub fn show_panel(&self, app: &AppHandle<R>, shelf_id: &str) -> Result<(), String> {
        let label = format!("shelf-{}", shelf_id);
        if let Ok(panel) = app.get_webview_panel(&label) {
            panel.show();
            Ok(())
        } else {
            Err(format!("Panel not found: {}", shelf_id))
        }
    }

    /// Hide a panel (but keep it alive)
    pub fn hide_panel(&self, app: &AppHandle<R>, shelf_id: &str) -> Result<(), String> {
        let label = format!("shelf-{}", shelf_id);
        if let Ok(panel) = app.get_webview_panel(&label) {
            panel.hide();
            Ok(())
        } else {
            Err(format!("Panel not found: {}", shelf_id))
        }
    }

    /// Close and destroy a panel
    pub fn close_panel(&self, app: &AppHandle<R>, shelf_id: &str) -> Result<(), String> {
        let label = format!("shelf-{}", shelf_id);

        // Try to convert to window and close
        if let Ok(panel) = app.get_webview_panel(&label) {
            if let Some(window) = panel.to_window() {
                window.close().map_err(|e| format!("Failed to close window: {}", e))?;
            }
        }

        // Remove from tracking
        {
            let mut panels = self.open_panels.lock().unwrap();
            panels.remove(shelf_id);
        }

        log::info!("Closed shelf panel: {}", label);
        Ok(())
    }

    /// Show all tracked panels
    pub fn show_all(&self, app: &AppHandle<R>) {
        let panels = self.open_panels.lock().unwrap();
        for shelf_id in panels.keys() {
            let label = format!("shelf-{}", shelf_id);
            if let Ok(panel) = app.get_webview_panel(&label) {
                panel.show();
            }
        }
    }

    /// Check if a panel is open
    pub fn is_panel_open(&self, shelf_id: &str) -> bool {
        let panels = self.open_panels.lock().unwrap();
        panels.contains_key(shelf_id)
    }

    /// Get list of open panel shelf IDs
    pub fn get_open_panel_ids(&self) -> Vec<String> {
        let panels = self.open_panels.lock().unwrap();
        panels.keys().cloned().collect()
    }
}

impl<R: Runtime> Default for ShelfPanelManager<R> {
    fn default() -> Self {
        Self::new()
    }
}
