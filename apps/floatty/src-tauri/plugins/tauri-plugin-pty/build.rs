const COMMANDS: &[&str] = &["spawn", "write", "read", "resize", "kill", "exitstatus"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
