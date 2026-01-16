/// Help command - reads documentation files for help:: handler
///
/// Reads markdown files from the docs/ directory relative to the app bundle.

use std::path::PathBuf;

/// Read a help file from the docs directory
///
/// Takes a relative path like "docs/guides/FILTER.md" and returns the contents.
/// In dev mode, reads from the workspace root.
/// In release mode, reads from the app bundle resources.
#[tauri::command]
pub fn read_help_file(relative_path: String) -> Result<String, String> {
    // Get the docs directory based on build mode
    let docs_path = if cfg!(debug_assertions) {
        // Dev mode: read from workspace root (one level up from src-tauri)
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| PathBuf::from("."))
            .join(&relative_path)
    } else {
        // Release mode: read from bundled resources
        // Tauri bundles resources to Contents/Resources on macOS
        // For now, use same path - docs should be bundled via tauri.conf.json
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| PathBuf::from("."))
            .join(&relative_path)
    };

    // Security: ensure path doesn't escape docs directory
    let canonical = docs_path.canonicalize().map_err(|e| {
        format!("File not found: {} ({})", relative_path, e)
    })?;

    // Must be under docs/ - use starts_with to prevent path traversal
    // (e.g., "../../etc/passwd/docs/evil" would bypass contains() check)
    let base_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."))
        .join("docs");
    let canonical_base = base_dir.canonicalize().map_err(|e| {
        format!("Docs directory not found: {}", e)
    })?;

    if !canonical.starts_with(&canonical_base) {
        return Err(format!("Access denied: {} is outside docs/", relative_path));
    }

    // Read the file
    std::fs::read_to_string(&canonical).map_err(|e| {
        format!("Failed to read {}: {}", relative_path, e)
    })
}
