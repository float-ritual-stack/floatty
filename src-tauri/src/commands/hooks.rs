/// Tauri command wrappers for hooks services
/// 
/// Thin adapters that get HOME dir and delegate to services.

use crate::services::hooks;
use std::path::PathBuf;

/// Check if shell hooks are installed in .zshrc
#[tauri::command]
pub fn check_hooks_installed() -> Result<bool, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    hooks::check_installed(PathBuf::from(home))
}

/// Install shell hooks: write script and patch .zshrc
#[tauri::command]
pub fn install_shell_hooks() -> Result<(), String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    hooks::install(PathBuf::from(home))
}

/// Uninstall shell hooks: remove source line from .zshrc
#[tauri::command]
pub fn uninstall_shell_hooks() -> Result<(), String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    hooks::uninstall(PathBuf::from(home))
}
