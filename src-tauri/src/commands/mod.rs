/// Tauri command wrappers - thin adapters (3-10 lines each)
/// 
/// Extract state from Tauri, delegate to services/, handle errors.
/// To add a new command:
/// 1. Add service logic to services/{feature}.rs
/// 2. Add thin wrapper here in commands/{feature}.rs  
/// 3. Add to generate_handler![] in lib.rs

pub mod execution;
pub mod hooks;

// Re-export command functions for registration
pub use execution::{execute_shell_command, execute_ai_command};
pub use hooks::{check_hooks_installed, install_shell_hooks, uninstall_shell_hooks};
