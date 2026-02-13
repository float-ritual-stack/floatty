//! Orphan block detection for data integrity (FLO-350).
//!
//! An orphaned block is one that:
//! 1. Has a `parentId` pointing to a non-existent block, OR
//! 2. Has no `parentId` (null) but is not listed in `rootIds`
//!
//! This module provides pure detection logic. The background worker
//! in `lib.rs` fetches blocks from floatty-server and runs detection.
//! The frontend handles quarantine (reparenting orphans to a container).

use serde::{Deserialize, Serialize};
use std::collections::HashSet;

/// Minimal block info needed for orphan detection.
/// Deserialized from floatty-server GET /api/v1/blocks response.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockInfo {
    pub id: String,
    pub parent_id: Option<String>,
    pub content: String,
}

/// API response shape from GET /api/v1/blocks.
/// Note: API uses snake_case, so no rename_all needed
#[derive(Debug, Deserialize)]
pub struct BlocksApiResponse {
    pub blocks: Vec<BlockInfo>,
    pub root_ids: Vec<String>,
}

/// Info about a detected orphan block.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrphanInfo {
    pub block_id: String,
    /// The parentId that doesn't exist (empty string if block has no parent at all).
    pub missing_parent_id: String,
    /// First 80 chars of content for identification.
    pub content_preview: String,
}

/// Find orphaned blocks in the block tree.
///
/// Returns blocks that are disconnected from the tree:
/// - parentId points to a block that doesn't exist
/// - No parentId and not in rootIds (floating)
pub fn find_orphans(blocks: &[BlockInfo], root_ids: &[String]) -> Vec<OrphanInfo> {
    let block_ids: HashSet<&str> = blocks.iter().map(|b| b.id.as_str()).collect();
    let root_set: HashSet<&str> = root_ids.iter().map(|s| s.as_str()).collect();

    let mut orphans = Vec::new();

    for block in blocks {
        match &block.parent_id {
            Some(pid) if !pid.is_empty() => {
                // Has parent, but parent doesn't exist in blocks map
                if !block_ids.contains(pid.as_str()) {
                    orphans.push(OrphanInfo {
                        block_id: block.id.clone(),
                        missing_parent_id: pid.clone(),
                        content_preview: block.content.chars().take(80).collect(),
                    });
                }
            }
            _ => {
                // No parent (null or empty) — should be in rootIds
                if !root_set.contains(block.id.as_str()) {
                    orphans.push(OrphanInfo {
                        block_id: block.id.clone(),
                        missing_parent_id: String::new(),
                        content_preview: block.content.chars().take(80).collect(),
                    });
                }
            }
        }
    }

    orphans
}

#[cfg(test)]
mod tests {
    use super::*;

    fn block(id: &str, parent: Option<&str>, content: &str) -> BlockInfo {
        BlockInfo {
            id: id.to_string(),
            parent_id: parent.map(|s| s.to_string()),
            content: content.to_string(),
        }
    }

    #[test]
    fn test_no_orphans_simple_tree() {
        let blocks = vec![
            block("root1", None, "Root block"),
            block("child1", Some("root1"), "Child of root"),
            block("child2", Some("root1"), "Another child"),
        ];
        let root_ids = vec!["root1".to_string()];

        let orphans = find_orphans(&blocks, &root_ids);
        assert!(orphans.is_empty());
    }

    #[test]
    fn test_orphan_missing_parent() {
        let blocks = vec![
            block("root1", None, "Root block"),
            block("orphan1", Some("deleted-parent"), "I lost my parent"),
        ];
        let root_ids = vec!["root1".to_string()];

        let orphans = find_orphans(&blocks, &root_ids);
        assert_eq!(orphans.len(), 1);
        assert_eq!(orphans[0].block_id, "orphan1");
        assert_eq!(orphans[0].missing_parent_id, "deleted-parent");
    }

    #[test]
    fn test_orphan_floating_no_parent_not_in_roots() {
        let blocks = vec![
            block("root1", None, "Root block"),
            block("floater", None, "I'm floating in space"),
        ];
        let root_ids = vec!["root1".to_string()];

        let orphans = find_orphans(&blocks, &root_ids);
        assert_eq!(orphans.len(), 1);
        assert_eq!(orphans[0].block_id, "floater");
        assert!(orphans[0].missing_parent_id.is_empty());
    }

    #[test]
    fn test_multiple_orphans() {
        let blocks = vec![
            block("root1", None, "Root block"),
            block("child1", Some("root1"), "Valid child"),
            block("orphan1", Some("gone1"), "Orphan 1"),
            block("orphan2", Some("gone2"), "Orphan 2"),
            block("floater", None, "Floating block"),
        ];
        let root_ids = vec!["root1".to_string()];

        let orphans = find_orphans(&blocks, &root_ids);
        assert_eq!(orphans.len(), 3);

        let orphan_ids: HashSet<&str> = orphans.iter().map(|o| o.block_id.as_str()).collect();
        assert!(orphan_ids.contains("orphan1"));
        assert!(orphan_ids.contains("orphan2"));
        assert!(orphan_ids.contains("floater"));
    }

    #[test]
    fn test_json_parsing_matches_api_format() {
        // This test ensures our BlocksApiResponse matches the ACTUAL API response format.
        // API returns: { "blocks": [...], "root_ids": [...] }
        // BlockDto fields use camelCase, but root_ids field is snake_case!
        let json = r#"{
            "blocks": [
                {"id": "b1", "parentId": "missing", "content": "Orphan block", "childIds": [], "collapsed": false, "blockType": "inert", "createdAt": 0, "updatedAt": 0},
                {"id": "b2", "parentId": null, "content": "Root block", "childIds": [], "collapsed": false, "blockType": "inert", "createdAt": 0, "updatedAt": 0}
            ],
            "root_ids": ["b2"]
        }"#;

        // This will panic if serde configuration is wrong
        let response: BlocksApiResponse = serde_json::from_str(json)
            .expect("Should parse API response - check serde(rename_all) configuration!");

        assert_eq!(response.blocks.len(), 2);
        assert_eq!(response.root_ids.len(), 1);

        // Verify orphan detection works on parsed data
        let orphans = find_orphans(&response.blocks, &response.root_ids);
        assert_eq!(orphans.len(), 1);
        assert_eq!(orphans[0].block_id, "b1");
    }

    #[test]
    fn test_empty_blocks() {
        let orphans = find_orphans(&[], &[]);
        assert!(orphans.is_empty());
    }

    #[test]
    fn test_content_preview_truncation() {
        let long_content = "a".repeat(200);
        let blocks = vec![block("orphan1", Some("gone"), &long_content)];
        let root_ids = vec![];

        let orphans = find_orphans(&blocks, &root_ids);
        assert_eq!(orphans.len(), 1);
        assert_eq!(orphans[0].content_preview.len(), 80);
    }

    #[test]
    fn test_deep_tree_no_orphans() {
        let blocks = vec![
            block("root", None, "Root"),
            block("l1", Some("root"), "Level 1"),
            block("l2", Some("l1"), "Level 2"),
            block("l3", Some("l2"), "Level 3"),
        ];
        let root_ids = vec!["root".to_string()];

        let orphans = find_orphans(&blocks, &root_ids);
        assert!(orphans.is_empty());
    }

    #[test]
    fn test_chain_orphan_only_top_detected() {
        // If parent is deleted, its children still reference it.
        // Only the direct child of the deleted parent is "orphaned" in our definition.
        // Grandchildren still have their parent (which exists as an orphan itself).
        let blocks = vec![
            block("root", None, "Root"),
            block("orphan-parent", Some("deleted"), "My parent was deleted"),
            block("orphan-child", Some("orphan-parent"), "My parent is orphaned but exists"),
        ];
        let root_ids = vec!["root".to_string()];

        let orphans = find_orphans(&blocks, &root_ids);
        // Only orphan-parent is detected — orphan-child's parent still exists
        assert_eq!(orphans.len(), 1);
        assert_eq!(orphans[0].block_id, "orphan-parent");
    }

    #[test]
    fn test_multiple_roots_valid() {
        let blocks = vec![
            block("root1", None, "Root 1"),
            block("root2", None, "Root 2"),
            block("child1", Some("root1"), "Child of root1"),
        ];
        let root_ids = vec!["root1".to_string(), "root2".to_string()];

        let orphans = find_orphans(&blocks, &root_ids);
        assert!(orphans.is_empty());
    }
}
