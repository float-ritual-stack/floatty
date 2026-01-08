/// Shell hooks management - OSC 133/1337 semantic prompts
///
/// Pure business logic for installing/uninstalling zsh hooks.
/// Testable without Tauri runtime.

use std::io::Write;
use std::path::PathBuf;

const SHELL_HOOKS_SCRIPT: &str = r#"# Floatty Shell Hooks - OSC 133/1337 Semantic Prompts
[[ -n "$FLOATTY_HOOKS_ACTIVE" ]] && return
export FLOATTY_HOOKS_ACTIVE=1
_floatty_cmd_started=0
_floatty_last_exit=0
_floatty_osc() { printf '\e]%s\a' "$1"; }
_floatty_precmd() {
    _floatty_last_exit=$?
    if [[ $_floatty_cmd_started -eq 1 ]]; then
        _floatty_osc "133;D;$_floatty_last_exit"
        _floatty_cmd_started=0
    fi
    _floatty_osc "1337;CurrentDir=$PWD"
    _floatty_osc "133;A"
}
_floatty_preexec() {
    _floatty_cmd_started=1
    _floatty_osc "133;C"
    _floatty_osc "1337;Command=${1//;/\;}"
}
_floatty_chpwd() { _floatty_osc "1337;CurrentDir=$PWD"; }
autoload -Uz add-zsh-hook
add-zsh-hook precmd _floatty_precmd
add-zsh-hook preexec _floatty_preexec
add-zsh-hook chpwd _floatty_chpwd
_floatty_osc "1337;CurrentDir=$PWD"
"#;

const ZSHRC_SOURCE_LINE: &str = "\n# Floatty shell hooks\n[[ -f ~/.floatty/shell-hooks.zsh ]] && source ~/.floatty/shell-hooks.zsh\n";

/// Check if shell hooks are installed in .zshrc
pub fn check_installed(home_dir: PathBuf) -> Result<bool, String> {
    let zshrc_path = home_dir.join(".zshrc");
    
    if !zshrc_path.exists() {
        return Ok(false);
    }
    
    let content = std::fs::read_to_string(&zshrc_path)
        .map_err(|e| e.to_string())?;
    
    Ok(content.contains("floatty/shell-hooks.zsh"))
}

/// Install shell hooks: write script and patch .zshrc
pub fn install(home_dir: PathBuf) -> Result<(), String> {
    let floatty_dir = home_dir.join(".floatty");
    let hooks_path = floatty_dir.join("shell-hooks.zsh");
    let zshrc_path = home_dir.join(".zshrc");
    
    // Create ~/.floatty directory if it doesn't exist
    std::fs::create_dir_all(&floatty_dir)
        .map_err(|e| e.to_string())?;
    
    // Write shell hooks script
    std::fs::write(&hooks_path, SHELL_HOOKS_SCRIPT)
        .map_err(|e| e.to_string())?;
    
    tracing::info!(path = ?hooks_path, "Wrote shell hooks script");
    
    // Read existing .zshrc or create empty
    let zshrc_content = if zshrc_path.exists() {
        std::fs::read_to_string(&zshrc_path)
            .map_err(|e| e.to_string())?
    } else {
        String::new()
    };
    
    // Append source line if not already present
    if !zshrc_content.contains("floatty/shell-hooks.zsh") {
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&zshrc_path)
            .map_err(|e| e.to_string())?;
        
        file.write_all(ZSHRC_SOURCE_LINE.as_bytes())
            .map_err(|e| e.to_string())?;
        
        tracing::info!(path = ?zshrc_path, "Added source line to .zshrc");
    }
    
    Ok(())
}

/// Uninstall shell hooks: remove source line from .zshrc
pub fn uninstall(home_dir: PathBuf) -> Result<(), String> {
    let zshrc_path = home_dir.join(".zshrc");
    
    if !zshrc_path.exists() {
        return Ok(());
    }
    
    let content = std::fs::read_to_string(&zshrc_path)
        .map_err(|e| e.to_string())?;
    
    // Filter out floatty hook lines
    let filtered: Vec<&str> = content
        .lines()
        .filter(|line| {
            !line.contains("floatty/shell-hooks.zsh") 
                && !line.contains("# Floatty shell hooks")
        })
        .collect();
    
    // Preserve trailing newline if original had one
    let output = if content.ends_with('\n') {
        format!("{}\n", filtered.join("\n"))
    } else {
        filtered.join("\n")
    };
    
    std::fs::write(&zshrc_path, output)
        .map_err(|e| e.to_string())?;
    
    tracing::info!(path = ?zshrc_path, "Removed floatty hooks from .zshrc");
    
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn test_check_installed_no_zshrc() {
        let temp_dir = TempDir::new().unwrap();
        let result = check_installed(temp_dir.path().to_path_buf()).unwrap();
        assert_eq!(result, false);
    }

    #[test]
    fn test_check_installed_with_hooks() {
        let temp_dir = TempDir::new().unwrap();
        let zshrc_path = temp_dir.path().join(".zshrc");
        fs::write(&zshrc_path, "source ~/.floatty/shell-hooks.zsh\n").unwrap();
        
        let result = check_installed(temp_dir.path().to_path_buf()).unwrap();
        assert_eq!(result, true);
    }

    #[test]
    fn test_install_creates_script() {
        let temp_dir = TempDir::new().unwrap();
        install(temp_dir.path().to_path_buf()).unwrap();
        
        let hooks_path = temp_dir.path().join(".floatty/shell-hooks.zsh");
        assert!(hooks_path.exists());
        
        let content = fs::read_to_string(hooks_path).unwrap();
        assert!(content.contains("_floatty_precmd"));
    }

    #[test]
    fn test_install_patches_zshrc() {
        let temp_dir = TempDir::new().unwrap();
        install(temp_dir.path().to_path_buf()).unwrap();
        
        let zshrc_path = temp_dir.path().join(".zshrc");
        let content = fs::read_to_string(zshrc_path).unwrap();
        assert!(content.contains("floatty/shell-hooks.zsh"));
    }

    #[test]
    fn test_uninstall_removes_source_line() {
        let temp_dir = TempDir::new().unwrap();
        let zshrc_path = temp_dir.path().join(".zshrc");
        
        // Create .zshrc with floatty hooks
        fs::write(&zshrc_path, "# Floatty shell hooks\nsource ~/.floatty/shell-hooks.zsh\n").unwrap();
        
        uninstall(temp_dir.path().to_path_buf()).unwrap();
        
        let content = fs::read_to_string(zshrc_path).unwrap();
        assert!(!content.contains("floatty/shell-hooks.zsh"));
    }
}
