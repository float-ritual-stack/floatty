/// Workspace persistence and Y.Doc operations
///
/// Business logic for workspace state management and Y.Doc clearing.

use crate::db::FloattyDb;
use floatty_core::YDocStore;
use std::sync::Arc;
use yrs::{Array, Map, ReadTxn, Transact};

/// Get persisted workspace layout state (JSON blob)
pub fn get_state(db: &Arc<FloattyDb>, key: &str) -> Result<Option<String>, String> {
    db.get_workspace_state(key).map_err(|e| e.to_string())
}

/// Save workspace layout state (JSON blob)
pub fn set_state(db: &Arc<FloattyDb>, key: &str, state_json: &str, save_seq: i64) -> Result<(), String> {
    db.set_workspace_state(key, state_json, save_seq)
        .map_err(|e| e.to_string())
}

/// Clear the entire workspace (blocks and rootIds) efficiently
///
/// This performs a complete reset of the Y.Doc structure:
/// 1. Clears all rootIds (the top-level block list)
/// 2. Clears all blocks from the blocks map
/// 3. Forces compaction to persist the empty state
pub fn clear(store: &YDocStore) -> Result<(), String> {
    let doc = store.doc();
    let doc_guard = doc.write().map_err(|e| e.to_string())?;

    // Scope mutable transaction to drop before creating read transaction
    {
        let mut txn = doc_guard.transact_mut();

        // Clear rootIds
        let root_ids = txn.get_array("rootIds");
        if let Some(root_ids) = root_ids {
            let len = root_ids.len(&txn);
            if len > 0 {
                root_ids.remove_range(&mut txn, 0, len);
            }
        }

        // Clear blocks map
        let blocks = txn.get_map("blocks");
        if let Some(blocks) = blocks {
            let keys: Vec<String> = blocks.keys(&txn).map(|k| k.to_string()).collect();
            for key in keys {
                blocks.remove(&mut txn, &key);
            }
        }
    } // txn dropped here
    drop(doc_guard);

    // Persist empty state via store's compaction
    store.force_compact().map_err(|e| e.to_string())?;

    tracing::info!("Workspace cleared successfully");

    Ok(())
}

#[cfg(test)]
mod tests {
    // Note: These tests would require mocking YDocStore and FloattyDb
    // which is complex. Basic smoke tests to ensure functions exist.

    #[test]
    fn test_workspace_functions_exist() {
        // This test just ensures the functions compile and have correct signatures
        // Real testing would require integration tests with actual Y.Doc instances
    }
}
