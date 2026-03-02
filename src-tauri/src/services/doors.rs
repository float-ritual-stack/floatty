/// Door file discovery — scans {data_dir}/doors/ for pre-compiled door plugins.
///
/// Each door lives in its own subdirectory with a `door.json` manifest
/// and an `index.js` entry point:
///
/// ```text
/// doors/
/// └── daily/
///     ├── door.json   # { "id": "daily", "prefixes": ["daily::"], "name": "Daily Notes" }
///     └── index.js    # Pre-compiled SolidJS component
/// ```

use serde::{Deserialize, Serialize};
use std::path::Path;

/// Manifest read from `door.json` in each door directory.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DoorManifest {
    /// Unique door identifier (matches directory name by convention)
    pub id: String,
    /// Block prefixes this door handles (e.g., ["daily::", "journal::"])
    pub prefixes: Vec<String>,
    /// Human-readable name
    pub name: String,
    /// Optional semver version
    #[serde(default)]
    pub version: Option<String>,
}

/// Summary returned by `list_doors` — manifest + whether index.js exists.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DoorInfo {
    #[serde(flatten)]
    pub manifest: DoorManifest,
    /// Whether the door has an index.js entry point
    pub has_entry: bool,
}

/// Scan the doors directory and return metadata for each valid door.
///
/// A valid door is a subdirectory containing a parseable `door.json`.
/// Directories without `door.json` or with unparseable manifests are skipped
/// with a warning log.
pub fn list_doors(doors_dir: &Path) -> Vec<DoorInfo> {
    let entries = match std::fs::read_dir(doors_dir) {
        Ok(e) => e,
        Err(e) => {
            tracing::debug!(error = %e, path = ?doors_dir, "Could not read doors directory");
            return Vec::new();
        }
    };

    let mut doors = Vec::new();

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }

        let manifest_path = path.join("door.json");
        let manifest = match std::fs::read_to_string(&manifest_path) {
            Ok(contents) => match serde_json::from_str::<DoorManifest>(&contents) {
                Ok(m) => m,
                Err(e) => {
                    tracing::warn!(
                        error = %e,
                        path = ?manifest_path,
                        "Skipping door: invalid door.json"
                    );
                    continue;
                }
            },
            Err(_) => continue, // No door.json = not a door directory
        };

        let has_entry = path.join("index.js").is_file();

        doors.push(DoorInfo {
            manifest,
            has_entry,
        });
    }

    // Sort by id for deterministic output
    doors.sort_by(|a, b| a.manifest.id.cmp(&b.manifest.id));
    doors
}

/// Read the JS entry point for a specific door.
///
/// Returns the contents of `{doors_dir}/{door_id}/index.js`.
pub fn read_door_file(doors_dir: &Path, door_id: &str) -> Result<String, String> {
    // Prevent path traversal
    if door_id.contains('/') || door_id.contains('\\') || door_id.contains("..") {
        return Err("Invalid door ID".to_string());
    }

    let entry_path = doors_dir.join(door_id).join("index.js");

    std::fs::read_to_string(&entry_path).map_err(|e| {
        format!("Failed to read door '{}': {}", door_id, e)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn setup_test_dir() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();

        // Create a valid door
        let daily = dir.path().join("daily");
        fs::create_dir(&daily).unwrap();
        fs::write(
            daily.join("door.json"),
            r#"{"id":"daily","prefixes":["daily::"],"name":"Daily Notes","version":"0.1.0"}"#,
        ).unwrap();
        fs::write(daily.join("index.js"), "export default function Daily() {}").unwrap();

        // Create a door without index.js
        let stub = dir.path().join("stub");
        fs::create_dir(&stub).unwrap();
        fs::write(
            stub.join("door.json"),
            r#"{"id":"stub","prefixes":["stub::"],"name":"Stub Door"}"#,
        ).unwrap();

        // Create a directory without door.json (should be skipped)
        let junk = dir.path().join("not-a-door");
        fs::create_dir(&junk).unwrap();
        fs::write(junk.join("readme.txt"), "ignore me").unwrap();

        // Create a file (not directory) in doors/ (should be skipped)
        fs::write(dir.path().join(".DS_Store"), "").unwrap();

        dir
    }

    #[test]
    fn test_list_doors_discovers_valid() {
        let dir = setup_test_dir();
        let doors = list_doors(dir.path());

        assert_eq!(doors.len(), 2);
        assert_eq!(doors[0].manifest.id, "daily");
        assert_eq!(doors[0].manifest.prefixes, vec!["daily::"]);
        assert_eq!(doors[0].manifest.name, "Daily Notes");
        assert_eq!(doors[0].manifest.version, Some("0.1.0".to_string()));
        assert!(doors[0].has_entry);

        assert_eq!(doors[1].manifest.id, "stub");
        assert!(!doors[1].has_entry);
    }

    #[test]
    fn test_list_doors_empty_dir() {
        let dir = tempfile::tempdir().unwrap();
        let doors = list_doors(dir.path());
        assert!(doors.is_empty());
    }

    #[test]
    fn test_list_doors_missing_dir() {
        let doors = list_doors(Path::new("/nonexistent/path"));
        assert!(doors.is_empty());
    }

    #[test]
    fn test_read_door_file_success() {
        let dir = setup_test_dir();
        let content = read_door_file(dir.path(), "daily").unwrap();
        assert_eq!(content, "export default function Daily() {}");
    }

    #[test]
    fn test_read_door_file_missing() {
        let dir = setup_test_dir();
        let result = read_door_file(dir.path(), "nonexistent");
        assert!(result.is_err());
    }

    #[test]
    fn test_read_door_file_path_traversal() {
        let dir = setup_test_dir();
        assert!(read_door_file(dir.path(), "../etc/passwd").is_err());
        assert!(read_door_file(dir.path(), "foo/bar").is_err());
    }

    #[test]
    fn test_invalid_manifest_skipped() {
        let dir = tempfile::tempdir().unwrap();
        let bad = dir.path().join("bad");
        fs::create_dir(&bad).unwrap();
        fs::write(bad.join("door.json"), "not json at all").unwrap();

        let doors = list_doors(dir.path());
        assert!(doors.is_empty());
    }
}
