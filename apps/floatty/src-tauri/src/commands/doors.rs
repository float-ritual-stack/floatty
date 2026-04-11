/// Door discovery commands — thin Tauri wrappers over services::doors

use crate::services::doors;
use crate::paths::DataPaths;

/// List all discovered doors in the doors directory.
///
/// Returns metadata from each door's `door.json` manifest.
#[tauri::command]
pub fn list_door_files() -> Vec<doors::DoorInfo> {
    let paths = DataPaths::resolve();
    doors::list_doors(&paths.doors)
}

/// Read a door's compiled JS entry point.
///
/// Returns the contents of `{doors_dir}/{door_id}/index.js`.
#[tauri::command]
pub fn read_door_file(door_id: String) -> Result<String, String> {
    let paths = DataPaths::resolve();
    doors::read_door_file(&paths.doors, &door_id)
}
