/// Tauri command wrappers - thin adapters (3-10 lines each)
///
/// Extract state from Tauri, delegate to services/, handle errors.
/// To add a new command:
/// 1. Add service logic to services/{feature}.rs
/// 2. Add thin wrapper here in commands/{feature}.rs
/// 3. Add to generate_handler![] in lib.rs

pub mod agent_log;
pub mod clipboard;
pub mod ctx;
pub mod execution;
pub mod help;
pub mod hooks;
pub mod workspace;

// Re-export command functions for registration
pub use agent_log::{clear_agent_log, get_agent_log, log_agent_activity};
pub use clipboard::{get_clipboard_info, save_clipboard_image};
pub use ctx::{
    clear_ctx_markers, get_ctx_config, get_ctx_counts, get_ctx_markers,
    get_send_model, get_theme, set_ctx_config, set_theme, toggle_diagnostics,
};
pub use execution::{execute_ai_command, execute_ai_conversation, execute_shell_command, open_url};
pub use help::read_help_file;
pub use hooks::{check_hooks_installed, install_shell_hooks, uninstall_shell_hooks};
pub use workspace::{clear_workspace, get_workspace_state, save_workspace_state};
