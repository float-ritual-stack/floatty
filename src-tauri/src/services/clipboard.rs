/// Clipboard image handling service
///
/// Pure business logic for saving clipboard images to temp files.
/// Testable without Tauri runtime.

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

/// Save clipboard image (base64) to temp file and return path
///
/// Used for pasting screenshots - saves to /tmp/floatty-clipboard-{timestamp}.png
///
/// # Arguments
/// * `base64_data` - Base64-encoded image data
/// * `temp_dir` - Temporary directory path
///
/// # Returns
/// Full path to saved image file
pub fn save_image(base64_data: String, temp_dir: PathBuf) -> Result<String, String> {
    // Decode base64 to bytes
    let bytes = BASE64
        .decode(&base64_data)
        .map_err(|e| format!("Base64 decode failed: {}", e))?;

    // Generate unique filename with timestamp
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();

    let filename = format!("floatty-clipboard-{}.png", timestamp);
    let path = temp_dir.join(&filename);

    // Write image to temp file
    std::fs::write(&path, bytes).map_err(|e| format!("Failed to write image: {}", e))?;

    tracing::info!(path = ?path, "Saved clipboard image");

    Ok(path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn test_save_image_creates_file() {
        let temp_dir = TempDir::new().unwrap();
        
        // Valid 1x1 PNG image in base64
        let base64_png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
        
        let result = save_image(base64_png.to_string(), temp_dir.path().to_path_buf());
        
        assert!(result.is_ok());
        let path = PathBuf::from(result.unwrap());
        assert!(path.exists());
        assert!(path.to_string_lossy().contains("floatty-clipboard-"));
        assert!(path.to_string_lossy().ends_with(".png"));
    }

    #[test]
    fn test_save_image_invalid_base64() {
        let temp_dir = TempDir::new().unwrap();
        
        let result = save_image("not-valid-base64!!!".to_string(), temp_dir.path().to_path_buf());
        
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Base64 decode failed"));
    }

    #[test]
    fn test_save_image_unique_filenames() {
        let temp_dir = TempDir::new().unwrap();
        let base64_png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
        
        let path1 = save_image(base64_png.to_string(), temp_dir.path().to_path_buf()).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(2)); // Ensure different timestamp
        let path2 = save_image(base64_png.to_string(), temp_dir.path().to_path_buf()).unwrap();
        
        assert_ne!(path1, path2, "Filenames should be unique");
    }
}
