/// Tauri command wrapper for clipboard service
///
/// Thin adapter that gets temp dir and delegates to service.

use crate::services::clipboard;

/// Save clipboard image (base64) to temp file and return path
#[tauri::command]
pub fn save_clipboard_image(base64: String) -> Result<String, String> {
    let temp_dir = std::env::temp_dir();
    clipboard::save_image(base64, temp_dir)
}
