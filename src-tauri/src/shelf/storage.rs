//! File storage operations for shelves

use crate::shelf::{chrono_timestamp, ShelfItem};
use std::fs;
use std::path::{Path, PathBuf};

pub struct ShelfStorage {
    base_path: PathBuf,
}

impl ShelfStorage {
    pub fn new() -> Self {
        let base_path = dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".floatty")
            .join("shelves");

        Self { base_path }
    }

    /// Get the storage directory for a specific shelf
    pub fn shelf_dir(&self, shelf_id: &str) -> PathBuf {
        self.base_path.join(shelf_id)
    }

    /// Ensure the shelf directory exists
    pub fn ensure_shelf_dir(&self, shelf_id: &str) -> Result<PathBuf, String> {
        let dir = self.shelf_dir(shelf_id);
        fs::create_dir_all(&dir).map_err(|e| format!("Failed to create shelf directory: {}", e))?;
        Ok(dir)
    }

    /// Copy a file or directory to a shelf, returning the ShelfItem
    pub fn add_file(&self, shelf_id: &str, source_path: &Path) -> Result<ShelfItem, String> {
        let shelf_dir = self.ensure_shelf_dir(shelf_id)?;

        // Get file metadata
        let metadata = fs::metadata(source_path)
            .map_err(|e| format!("Failed to read source file: {}", e))?;

        let filename = source_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unnamed")
            .to_string();

        // Handle duplicate filenames by appending a number
        let dest_path = self.unique_path(&shelf_dir, &filename);

        let is_directory = metadata.is_dir();
        let size_bytes = if is_directory {
            self.dir_size(source_path).unwrap_or(0)
        } else {
            metadata.len()
        };

        // Copy the file or directory
        if is_directory {
            self.copy_dir_recursive(source_path, &dest_path)?;
        } else {
            fs::copy(source_path, &dest_path)
                .map_err(|e| format!("Failed to copy file: {}", e))?;
        }

        let item = ShelfItem {
            id: uuid::Uuid::new_v4().to_string(),
            shelf_id: shelf_id.to_string(),
            original_path: source_path.to_path_buf(),
            stored_path: dest_path,
            filename: filename.clone(),
            size_bytes,
            is_directory,
            added_at: chrono_timestamp(),
        };

        Ok(item)
    }

    /// Generate a unique path, appending numbers if needed
    fn unique_path(&self, dir: &Path, filename: &str) -> PathBuf {
        let base_path = dir.join(filename);
        if !base_path.exists() {
            return base_path;
        }

        // Split filename into name and extension
        let (name, ext) = if let Some(dot_pos) = filename.rfind('.') {
            (&filename[..dot_pos], Some(&filename[dot_pos..]))
        } else {
            (filename, None)
        };

        for i in 1..1000 {
            let new_name = match ext {
                Some(e) => format!("{} ({}){}", name, i, e),
                None => format!("{} ({})", name, i),
            };
            let new_path = dir.join(&new_name);
            if !new_path.exists() {
                return new_path;
            }
        }

        // Fallback: use UUID
        let new_name = format!("{}_{}", uuid::Uuid::new_v4(), filename);
        dir.join(new_name)
    }

    /// Recursively copy a directory
    fn copy_dir_recursive(&self, src: &Path, dst: &Path) -> Result<(), String> {
        fs::create_dir_all(dst).map_err(|e| format!("Failed to create directory: {}", e))?;

        for entry in fs::read_dir(src).map_err(|e| format!("Failed to read directory: {}", e))? {
            let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
            let src_path = entry.path();
            let dst_path = dst.join(entry.file_name());

            if src_path.is_dir() {
                self.copy_dir_recursive(&src_path, &dst_path)?;
            } else {
                fs::copy(&src_path, &dst_path)
                    .map_err(|e| format!("Failed to copy file: {}", e))?;
            }
        }

        Ok(())
    }

    /// Calculate directory size recursively
    fn dir_size(&self, path: &Path) -> Result<u64, String> {
        let mut size = 0u64;
        for entry in
            fs::read_dir(path).map_err(|e| format!("Failed to read directory: {}", e))?
        {
            let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
            let path = entry.path();
            if path.is_dir() {
                size += self.dir_size(&path)?;
            } else {
                size += entry
                    .metadata()
                    .map_err(|e| format!("Failed to read metadata: {}", e))?
                    .len();
            }
        }
        Ok(size)
    }

    /// Delete an item's stored file
    pub fn delete_item(&self, stored_path: &Path) -> Result<(), String> {
        if stored_path.is_dir() {
            fs::remove_dir_all(stored_path)
                .map_err(|e| format!("Failed to delete directory: {}", e))?;
        } else if stored_path.exists() {
            fs::remove_file(stored_path)
                .map_err(|e| format!("Failed to delete file: {}", e))?;
        }
        Ok(())
    }

    /// Delete an entire shelf's storage directory
    pub fn delete_shelf_storage(&self, shelf_id: &str) -> Result<(), String> {
        let dir = self.shelf_dir(shelf_id);
        if dir.exists() {
            fs::remove_dir_all(&dir)
                .map_err(|e| format!("Failed to delete shelf storage: {}", e))?;
        }
        Ok(())
    }

    /// Move an item out of the shelf to a destination
    pub fn move_item_out(&self, stored_path: &Path, dest_path: &Path) -> Result<(), String> {
        if stored_path.is_dir() {
            self.copy_dir_recursive(stored_path, dest_path)?;
            fs::remove_dir_all(stored_path)
                .map_err(|e| format!("Failed to remove source directory: {}", e))?;
        } else {
            fs::copy(stored_path, dest_path)
                .map_err(|e| format!("Failed to copy file: {}", e))?;
            fs::remove_file(stored_path)
                .map_err(|e| format!("Failed to remove source file: {}", e))?;
        }
        Ok(())
    }
}

impl Default for ShelfStorage {
    fn default() -> Self {
        Self::new()
    }
}
