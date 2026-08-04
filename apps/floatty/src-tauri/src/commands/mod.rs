/// Tauri command wrappers - thin adapters (3-10 lines each)
///
/// Extract state from Tauri, delegate to services/, handle errors.
/// To add a new command:
/// 1. Add service logic to services/{feature}.rs
/// 2. Add thin wrapper here in commands/{feature}.rs  
/// 3. Add to generate_handler![] in lib.rs
pub mod clipboard;
pub mod ctx;
pub mod doors;
pub mod execution;
pub mod files;
pub mod help;
pub mod hooks;
pub mod styles;
pub mod workspace;

// Re-export command functions for registration
pub use clipboard::{get_clipboard_info, save_clipboard_image};
pub use ctx::{
    clear_ctx_markers, get_ctx_config, get_ctx_counts, get_ctx_markers, get_theme, set_ctx_config,
    set_theme, toggle_diagnostics,
};
pub use doors::{list_door_files, read_door_file};
pub use execution::{execute_shell_command, open_url};
pub use files::get_recent_files;
pub use help::read_help_file;
pub use hooks::{check_hooks_installed, install_shell_hooks, uninstall_shell_hooks};
pub use styles::read_custom_css;
pub use workspace::{
    clear_workspace, delete_workspace_state, get_workspace_state, list_workspace_states,
    save_workspace_state,
};
