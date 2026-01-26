/// Tauri command wrapper for clipboard service
///
/// Thin adapter that gets temp dir and delegates to service.

use crate::services::clipboard;
use serde::Serialize;

/// Clipboard content type info - batched check for IPC efficiency
#[derive(Serialize)]
pub struct ClipboardInfo {
    pub has_files: bool,
    pub has_image: bool,
    pub has_text: bool,
}

/// Check what types of content are in the clipboard (single IPC call)
///
/// Replaces 3 sequential calls to hasFiles/hasImage/hasText from JS.
/// Uses arboard for direct clipboard inspection.
#[tauri::command]
pub fn get_clipboard_info() -> ClipboardInfo {
    use arboard::Clipboard;

    let mut info = ClipboardInfo {
        has_files: false,
        has_image: false,
        has_text: false,
    };

    if let Ok(mut clipboard) = Clipboard::new() {
        // Check for text
        info.has_text = clipboard.get_text().is_ok();

        // Check for image
        info.has_image = clipboard.get_image().is_ok();

        // Files check: macOS stores file paths as text with file:// URLs
        // The JS plugin handles this - we check via text content pattern
        if let Ok(text) = clipboard.get_text() {
            info.has_files = text.lines().all(|line| line.starts_with("file://") || line.is_empty());
        }
    }

    info
}

/// Save clipboard image (base64) to temp file and return path
#[tauri::command]
pub fn save_clipboard_image(base64: String) -> Result<String, String> {
    let temp_dir = std::env::temp_dir();
    clipboard::save_image(base64, temp_dir)
}
