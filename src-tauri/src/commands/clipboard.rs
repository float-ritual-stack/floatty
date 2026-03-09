/// Tauri command wrapper for clipboard service
///
/// Thin adapter that gets temp dir and delegates to service.

use crate::services::clipboard;
use serde::Serialize;

/// Clipboard content type info - batched check for IPC efficiency
///
/// Note: file detection is handled by tauri-plugin-clipboard-api's readFiles()
/// which uses NSPasteboard directly. arboard's text-pattern heuristic misses
/// macOS Finder copies (returns filename, not file:// URL).
#[derive(Serialize)]
pub struct ClipboardInfo {
    pub has_image: bool,
    pub has_text: bool,
}

/// Check image/text presence in clipboard (single IPC call).
///
/// File detection is done separately via tauri-plugin-clipboard-api's readFiles()
/// which correctly reads NSPasteboard on macOS. Uses arboard for image/text.
#[tauri::command]
pub fn get_clipboard_info() -> ClipboardInfo {
    use arboard::Clipboard;

    let mut info = ClipboardInfo {
        has_image: false,
        has_text: false,
    };

    if let Ok(mut clipboard) = Clipboard::new() {
        info.has_text = clipboard.get_text().is_ok();
        info.has_image = clipboard.get_image().is_ok();
    }

    info
}

/// Save clipboard image (base64) to temp file and return path
#[tauri::command]
pub fn save_clipboard_image(base64: String) -> Result<String, String> {
    let temp_dir = std::env::temp_dir();
    clipboard::save_image(base64, temp_dir)
}
