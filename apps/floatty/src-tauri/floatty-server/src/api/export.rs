//! Export + Topology handlers — binary/JSON export and lightweight graph projection.

use axum::{
    extract::{Path, State},
    http::{header, StatusCode},
    response::IntoResponse,
    routing::get,
    Json, Router,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use yrs::{Array, Map, ReadTxn, Transact};

use super::{extract_metadata_from_yrs, ApiError, AppState};
use crate::block_service::extract_timestamp;
use floatty_core::projections::{walk_ancestors, HashMapParentLookup};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/export/binary", get(export_binary))
        .route("/api/v1/export/json", get(export_json))
        .route("/api/v1/topology", get(get_topology))
        .route("/api/v1/topology/content/:pageName", get(get_page_content))
}

// ============================================================================
// Export DTOs (FLO-249)
// ============================================================================

/// Exported block structure for JSON export
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportedBlock {
    pub content: String,
    pub parent_id: Option<String>,
    pub child_ids: Vec<String>,
    #[serde(rename = "type")]
    pub block_type: String,
    pub collapsed: bool,
    pub created_at: i64,
    pub updated_at: i64,
    /// Always include metadata to match frontend ⌘⇧J export shape (FLO-393).
    /// Frontend uses `metadata: {}` for blocks without extracted metadata.
    #[serde(default)]
    pub metadata: serde_json::Value,
}

/// JSON export response structure
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportedOutline {
    pub version: u32,
    pub exported: String,
    pub block_count: usize,
    pub root_ids: Vec<String>,
    pub blocks: std::collections::HashMap<String, ExportedBlock>,
}

// ============================================================================
// Topology DTOs (FLO-394)
// ============================================================================

/// Node in the topology graph (page or ref-only entity).
#[derive(Serialize, Deserialize)]
pub struct TopologyNode {
    /// Page name (truncated to 55 chars)
    pub id: String,
    /// Block count in subtree (capped 3000)
    pub b: usize,
    /// Total inlink count
    pub i: usize,
    /// Root-territory count (distinct root territories linking here)
    pub rc: usize,
    /// 1 if orphan (in pages:: but no inlinks)
    pub orp: u8,
    /// 1 if ref-only (referenced but not in pages::)
    #[serde(rename = "ref")]
    pub is_ref: u8,
    /// Block UUID of the page (if exists, not ref-only)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bid: Option<String>,
}

/// Topology response matching extract-topology.py contract.
#[derive(Serialize, Deserialize)]
pub struct TopologyResponse {
    #[serde(rename = "n")]
    pub nodes: Vec<TopologyNode>,
    #[serde(rename = "e")]
    pub edges: Vec<[String; 2]>,
    /// Per-page outline content: { "page name": [[depth, "line"], ...] }
    #[serde(rename = "c")]
    pub content: std::collections::HashMap<String, Vec<(u8, String)>>,
    /// Daily block creation rhythm
    pub daily: Vec<DailyEntry>,
    pub meta: TopologyMeta,
}

#[derive(Serialize, Deserialize)]
pub struct DailyEntry {
    pub d: String,
    pub n: usize,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopologyMeta {
    pub blocks: usize,
    pub pages: usize,
    pub days: usize,
    pub roots: usize,
    pub ref_only: usize,
    pub orphans: usize,
}

/// Query parameters for GET /api/v1/topology
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopologyQuery {
    /// Max content lines per page (default: 30, 0 = omit content entirely)
    #[serde(default = "default_max_lines")]
    pub max_lines: usize,
    /// Max chars per content line (default: 90)
    #[serde(default = "default_max_line_len")]
    pub max_line_len: usize,
}

fn default_max_lines() -> usize {
    30
}
fn default_max_line_len() -> usize {
    90
}

/// Response for GET /api/v1/topology/content/:pageName
#[derive(Serialize, Deserialize)]
pub struct PageContentResponse {
    pub name: String,
    pub lines: Vec<(u8, String)>,
    pub block_count: usize,
}

// ============================================================================
// Handlers
// ============================================================================

/// Generate timestamp string for filenames: YYYY-MM-DD-HHmmss (UTC)
fn export_timestamp() -> String {
    Utc::now().format("%Y-%m-%d-%H%M%S").to_string()
}

/// GET /api/v1/export/binary - Raw Y.Doc state as downloadable .ydoc file
///
/// Returns the full Y.Doc state as binary data with Content-Disposition header
/// for direct download. Use this for perfect backup/restore.
async fn export_binary(State(state): State<AppState>) -> Result<impl IntoResponse, ApiError> {
    let full_state = state.store.get_full_state()?;
    let timestamp = export_timestamp();
    let filename = format!("floatty-{}.ydoc", timestamp);
    let content_disposition = format!("attachment; filename=\"{}\"", filename);

    Ok((
        StatusCode::OK,
        [
            (
                header::CONTENT_TYPE,
                header::HeaderValue::from_static("application/octet-stream"),
            ),
            (
                header::CONTENT_DISPOSITION,
                header::HeaderValue::from_str(&content_disposition).unwrap(),
            ),
        ],
        full_state,
    ))
}

/// GET /api/v1/export/json - Human-readable JSON export
///
/// Returns structured JSON with all blocks. Note: This is a LOSSY export -
/// CRDT metadata (vector clocks, tombstones) is NOT preserved.
/// Use /api/v1/export/binary for perfect restore.
#[tracing::instrument(
    skip(state),
    fields(route_family = "export", handler = "export_json"),
    err
)]
async fn export_json(State(state): State<AppState>) -> Result<impl IntoResponse, ApiError> {
    let doc = state.store.doc();
    let doc_guard = doc.read().map_err(|_| ApiError::LockPoisoned)?;
    let txn = doc_guard.transact();

    let mut blocks = std::collections::HashMap::new();
    let mut root_ids = Vec::new();

    // Get root IDs
    if let Some(root_ids_arr) = txn.get_array("rootIds") {
        for value in root_ids_arr.iter(&txn) {
            if let yrs::Out::Any(yrs::Any::String(id)) = value {
                root_ids.push(id.to_string());
            }
        }
    }

    // Get all blocks
    if let Some(blocks_map) = txn.get_map("blocks") {
        for (key, value) in blocks_map.iter(&txn) {
            if let yrs::Out::YMap(block_map) = value {
                let content = block_map
                    .get(&txn, "content")
                    .and_then(|v| match v {
                        yrs::Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
                        _ => None,
                    })
                    .unwrap_or_default();

                let parent_id = block_map.get(&txn, "parentId").and_then(|v| match v {
                    yrs::Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
                    yrs::Out::Any(yrs::Any::Null) => None,
                    _ => None,
                });

                let child_ids = block_map
                    .get(&txn, "childIds")
                    .and_then(|v| match v {
                        yrs::Out::YArray(arr) => Some(
                            arr.iter(&txn)
                                .filter_map(|v| match v {
                                    yrs::Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
                                    _ => None,
                                })
                                .collect(),
                        ),
                        _ => None,
                    })
                    .unwrap_or_default();

                let collapsed = block_map
                    .get(&txn, "collapsed")
                    .and_then(|v| match v {
                        yrs::Out::Any(yrs::Any::Bool(b)) => Some(b),
                        _ => None,
                    })
                    .unwrap_or(false);

                let created_at = extract_timestamp(block_map.get(&txn, "createdAt"));
                let updated_at = extract_timestamp(block_map.get(&txn, "updatedAt"));

                let metadata = block_map
                    .get(&txn, "metadata")
                    .and_then(|v| extract_metadata_from_yrs(v, &txn))
                    .unwrap_or_else(|| serde_json::Value::Object(serde_json::Map::new()));

                let block_type = floatty_core::parse_block_type(&content);

                blocks.insert(
                    key.to_string(),
                    ExportedBlock {
                        content,
                        parent_id,
                        child_ids,
                        block_type: format!("{:?}", block_type).to_lowercase(),
                        collapsed,
                        created_at,
                        updated_at,
                        metadata,
                    },
                );
            }
        }
    }

    let timestamp = export_timestamp();
    let filename = format!("floatty-{}.json", timestamp);

    // ISO 8601 timestamp for the exported field
    let exported = format!(
        "{}-{}-{}T{}:{}:{}Z",
        &timestamp[0..4],   // year
        &timestamp[5..7],   // month
        &timestamp[8..10],  // day
        &timestamp[11..13], // hour
        &timestamp[13..15], // minute
        &timestamp[15..17], // second
    );

    let export = ExportedOutline {
        version: 1,
        exported,
        block_count: blocks.len(),
        root_ids,
        blocks,
    };

    let json = serde_json::to_string_pretty(&export)
        .map_err(|e| ApiError::Search(format!("JSON serialization failed: {}", e)))?;

    let content_disposition = format!("attachment; filename=\"{}\"", filename);

    Ok((
        StatusCode::OK,
        [
            (
                header::CONTENT_TYPE,
                header::HeaderValue::from_static("application/json"),
            ),
            (
                header::CONTENT_DISPOSITION,
                header::HeaderValue::from_str(&content_disposition).unwrap(),
            ),
        ],
        json,
    ))
}

/// GET /api/v1/topology - Lightweight graph projection for the Passenger Manifest.
///
/// Returns page nodes, edges (outlinks between pages), truncated content, daily rhythm,
/// and summary metadata. Much smaller than /api/v1/export/json (~50KB vs ~774KB).
///
/// Query params: ?maxLines=30&maxLineLen=90 (defaults shown)
///
/// Data sources: PageNameIndex (existing pages, stubs, reference counts) + Y.Doc (blocks).
#[tracing::instrument(
    skip(state, query),
    fields(route_family = "export", handler = "get_topology"),
    err
)]
async fn get_topology(
    State(state): State<AppState>,
    axum::extract::Query(query): axum::extract::Query<TopologyQuery>,
) -> Result<Json<TopologyResponse>, ApiError> {
    let max_lines = query.max_lines;
    let max_line_len = query.max_line_len;
    let page_index = state
        .page_name_index
        .read()
        .map_err(|_| ApiError::LockPoisoned)?;
    let doc = state.store.doc();
    let doc_guard = doc.read().map_err(|_| ApiError::LockPoisoned)?;
    let txn = doc_guard.transact();

    let existing_pages = page_index.existing_pages();
    // Find pages:: container and its children (page block IDs)
    let pages_container_id = page_index.pages_container_id().map(String::from);

    // Build page_name → page_block_id map from pages:: container children
    let mut page_name_to_id: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    if let (Some(ref container_id), Some(blocks_map)) = (&pages_container_id, txn.get_map("blocks"))
    {
        if let Some(yrs::Out::YMap(container)) = blocks_map.get(&txn, container_id.as_str()) {
            if let Some(yrs::Out::YArray(child_ids_arr)) = container.get(&txn, "childIds") {
                for val in child_ids_arr.iter(&txn) {
                    if let yrs::Out::Any(yrs::Any::String(child_id)) = val {
                        if let Some(yrs::Out::YMap(child_block)) =
                            blocks_map.get(&txn, child_id.as_ref())
                        {
                            let content = child_block
                                .get(&txn, "content")
                                .and_then(|v| match v {
                                    yrs::Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
                                    _ => None,
                                })
                                .unwrap_or_default();
                            let page_name = strip_heading_prefix(&content).to_lowercase();
                            if !page_name.is_empty() {
                                page_name_to_id.insert(page_name, child_id.to_string());
                            }
                        }
                    }
                }
            }
        }
    }

    // Get root IDs and build root territory map
    let mut root_ids: Vec<String> = Vec::new();
    let mut root_names: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    if let Some(root_ids_arr) = txn.get_array("rootIds") {
        for value in root_ids_arr.iter(&txn) {
            if let yrs::Out::Any(yrs::Any::String(id)) = value {
                root_ids.push(id.to_string());
            }
        }
    }

    // Classify root territories by content
    if let Some(blocks_map) = txn.get_map("blocks") {
        for rid in &root_ids {
            if let Some(yrs::Out::YMap(block)) = blocks_map.get(&txn, rid.as_str()) {
                let content = block
                    .get(&txn, "content")
                    .and_then(|v| match v {
                        yrs::Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
                        _ => None,
                    })
                    .unwrap_or_default();
                let fl = content.chars().take(40).collect::<String>().to_lowercase();
                let territory = if fl.contains("horror") {
                    "horror show"
                } else if fl.contains("pages") {
                    "pages"
                } else if fl.contains("work log") {
                    "work logs"
                } else {
                    "other"
                };
                root_names.insert(rid.clone(), territory.to_string());
            }
        }
    }

    // Single pass over all blocks to build:
    // - block_to_root: block_id → root_id
    // - parent_map: block_id → parent_id (for depth calc)
    // - daily_counts: "MM-DD" → count
    // - per-page subtree counts + outlinks + content lines
    let mut block_to_root: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    let mut parent_map: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    let mut daily_counts: std::collections::HashMap<String, usize> =
        std::collections::HashMap::new();
    let mut total_blocks: usize = 0;

    // For per-page data, we need to walk subtrees. Collect all blocks first.
    struct BlockInfo {
        content: String,
        child_ids: Vec<String>,
        outlinks: Vec<String>,
    }
    let mut all_blocks: std::collections::HashMap<String, BlockInfo> =
        std::collections::HashMap::new();

    if let Some(blocks_map) = txn.get_map("blocks") {
        for (key, value) in blocks_map.iter(&txn) {
            if let yrs::Out::YMap(block_map) = value {
                total_blocks += 1;
                let block_id = key.to_string();

                let content = block_map
                    .get(&txn, "content")
                    .and_then(|v| match v {
                        yrs::Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
                        _ => None,
                    })
                    .unwrap_or_default();

                let parent_id = block_map.get(&txn, "parentId").and_then(|v| match v {
                    yrs::Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
                    _ => None,
                });

                let child_ids: Vec<String> = block_map
                    .get(&txn, "childIds")
                    .and_then(|v| match v {
                        yrs::Out::YArray(arr) => Some(
                            arr.iter(&txn)
                                .filter_map(|v| match v {
                                    yrs::Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
                                    _ => None,
                                })
                                .collect(),
                        ),
                        _ => None,
                    })
                    .unwrap_or_default();

                let created_at = extract_timestamp(block_map.get(&txn, "createdAt"));

                // Extract outlinks from metadata
                let outlinks = block_map
                    .get(&txn, "metadata")
                    .and_then(|v| extract_metadata_from_yrs(v, &txn))
                    .and_then(|meta| {
                        meta.get("outlinks").and_then(|ol| {
                            ol.as_array().map(|arr| {
                                arr.iter()
                                    .filter_map(|v| v.as_str().map(String::from))
                                    .collect::<Vec<_>>()
                            })
                        })
                    })
                    .unwrap_or_default();

                // Daily rhythm from createdAt
                if created_at > 0 {
                    let dt = DateTime::from_timestamp_millis(created_at);
                    if let Some(dt) = dt {
                        let day_key = dt.format("%m-%d").to_string();
                        *daily_counts.entry(day_key).or_insert(0) += 1;
                    }
                }

                if let Some(ref pid) = parent_id {
                    parent_map.insert(block_id.clone(), pid.clone());
                }

                all_blocks.insert(
                    block_id,
                    BlockInfo {
                        content,
                        child_ids,
                        outlinks,
                    },
                );
            }
        }
    }

    // Build block_to_root by walking up parent chains via the consolidated
    // `walk_ancestors` (FLO-679 PR 1, commit 5).
    //
    // Pre-migration this was a recursive `find_root` with a 500-depth cap that
    // returned the *original* block on cap-saturation (cycle as own root). The
    // migrated impl returns the deepest reachable ancestor instead. The only
    // caller (`root_names.get(&root_id)`) only contains entries for blocks
    // present in `rootIds`; cycle participants are by definition not in
    // `rootIds`, so the lookup returns `None` either way and the caller
    // falls back to `"other"`. The pre-merge audit (single caller, recorded in
    // PR description) confirmed the semantic shift is unobservable.
    //
    // Cap remains at 500 to match pre-migration behaviour (deeper trees still
    // produce the same `block_to_root` mapping for usable depths; cap matters
    // only for pathological/cycle cases which the audit covered).
    let block_ids: Vec<String> = all_blocks.keys().cloned().collect();
    let lookup = HashMapParentLookup::new(&parent_map);
    for bid in &block_ids {
        let walk = walk_ancestors(&lookup, bid, 500, None);
        let root = walk
            .ids
            .last()
            .cloned()
            .unwrap_or_else(|| bid.to_string());
        block_to_root.insert(bid.clone(), root);
    }

    // Build inlinks: page_name → { territory → count }
    let mut inlinks: std::collections::HashMap<String, std::collections::HashMap<String, usize>> =
        std::collections::HashMap::new();
    // Also build backlink snippets for ref-only nodes
    let mut backlink_snippets: std::collections::HashMap<String, Vec<(u8, String)>> =
        std::collections::HashMap::new();

    for (bid, info) in &all_blocks {
        if !info.outlinks.is_empty() {
            let root_id = block_to_root.get(bid.as_str()).cloned().unwrap_or_default();
            let territory = root_names
                .get(&root_id)
                .cloned()
                .unwrap_or_else(|| "other".to_string());
            for link in &info.outlinks {
                let link_lower = link.to_lowercase();
                *inlinks
                    .entry(link_lower.clone())
                    .or_default()
                    .entry(territory.clone())
                    .or_insert(0) += 1;
                // Collect backlink snippets for ref-only nodes
                if !page_name_to_id.contains_key(&link_lower) {
                    let snippets = backlink_snippets.entry(link_lower).or_default();
                    if snippets.len() < 20 {
                        let line = info.content.lines().next().unwrap_or("").trim();
                        let truncated: String = line.chars().take(max_line_len).collect();
                        if !truncated.is_empty() {
                            snippets.push((0, truncated));
                        }
                    }
                }
            }
        }
    }

    // Entity set: existing pages + ref-only entities
    let mut entity_set: std::collections::HashSet<String> = std::collections::HashSet::new();
    for name in &existing_pages {
        entity_set.insert(name.clone());
    }
    // ref-only = referenced but not in pages::
    let existing_set: std::collections::HashSet<String> = existing_pages.iter().cloned().collect();
    let ref_only_set: std::collections::HashSet<String> = inlinks
        .keys()
        .filter(|name| !existing_set.contains(*name))
        .cloned()
        .collect();
    for name in &ref_only_set {
        entity_set.insert(name.clone());
    }

    // Orphans: exist in pages:: but no inlinks
    let orphan_set: std::collections::HashSet<String> = existing_pages
        .iter()
        .filter(|name| !inlinks.contains_key(*name))
        .cloned()
        .collect();

    // Subtree walk for each page: block count + content lines + outlinks
    // Iterative with visited set for cycle safety (matches collect_descendants pattern)
    // Recursive helper with 9 args — 2 over clippy's default-7 threshold.
    // Refactoring to a struct would force all the `&mut` accumulators
    // (`count`, `outlinks`, `content_lines`) into a single context type,
    // which adds boilerplate without changing semantics. Accept the
    // threshold violation for this private helper.
    #[allow(clippy::too_many_arguments)]
    fn walk_subtree(
        start_id: &str,
        all_blocks: &std::collections::HashMap<String, BlockInfo>,
        count: &mut usize,
        outlinks: &mut std::collections::HashSet<String>,
        content_lines: &mut Vec<(u8, String)>,
        root_page_id: &str,
        parent_map: &std::collections::HashMap<String, String>,
        max_lines: usize,
        max_line_len: usize,
    ) {
        let mut stack = vec![start_id.to_string()];
        let mut visited = std::collections::HashSet::new();
        while let Some(block_id) = stack.pop() {
            if !visited.insert(block_id.clone()) {
                continue; // cycle guard
            }
            if let Some(info) = all_blocks.get(&block_id) {
                *count += 1;
                for ol in &info.outlinks {
                    outlinks.insert(ol.to_lowercase());
                }
                if max_lines > 0 && block_id != root_page_id && content_lines.len() < max_lines {
                    let line = info.content.lines().next().unwrap_or("").trim().to_string();
                    if !line.is_empty() {
                        let depth = depth_from_page(&block_id, root_page_id, parent_map);
                        let truncated: String = line.chars().take(max_line_len).collect();
                        content_lines.push((depth.min(5) as u8, truncated));
                    }
                }
                // Push children in reverse to preserve order (first child processed first)
                for child_id in info.child_ids.iter().rev() {
                    stack.push(child_id.clone());
                }
            }
        }
    }

    fn depth_from_page(
        block_id: &str,
        page_id: &str,
        parent_map: &std::collections::HashMap<String, String>,
    ) -> usize {
        let mut d: usize = 0;
        let mut cur = block_id.to_string();
        while cur != page_id && d < 8 {
            match parent_map.get(&cur) {
                Some(pid) => {
                    cur = pid.clone();
                    d += 1;
                }
                None => break,
            }
        }
        d.saturating_sub(1)
    }

    let mut page_subtree_counts: std::collections::HashMap<String, usize> =
        std::collections::HashMap::new();
    let mut page_outlinks: std::collections::HashMap<String, std::collections::HashSet<String>> =
        std::collections::HashMap::new();
    let mut content_map: std::collections::HashMap<String, Vec<(u8, String)>> =
        std::collections::HashMap::new();

    for (page_name, page_id) in &page_name_to_id {
        let mut count = 0usize;
        let mut outlinks = std::collections::HashSet::new();
        let mut lines = Vec::new();
        walk_subtree(
            page_id,
            &all_blocks,
            &mut count,
            &mut outlinks,
            &mut lines,
            page_id,
            &parent_map,
            max_lines,
            max_line_len,
        );
        page_subtree_counts.insert(page_name.clone(), count);
        page_outlinks.insert(page_name.clone(), outlinks);
        let truncated_id: String = page_name.chars().take(55).collect();
        if !lines.is_empty() {
            content_map.insert(truncated_id, lines);
        }
    }

    // Backlink content for ref-only nodes
    for name in &ref_only_set {
        let truncated_id: String = name.chars().take(55).collect();
        if let Some(snippets) = backlink_snippets.get(name) {
            if !snippets.is_empty() {
                content_map.insert(truncated_id, snippets.iter().take(20).cloned().collect());
            }
        }
    }

    // Build edges: page → target (both in entity set)
    let mut edges_set: std::collections::HashSet<(String, String)> =
        std::collections::HashSet::new();
    for (page_name, ols) in &page_outlinks {
        for link in ols {
            if entity_set.contains(link) && link != page_name {
                let src: String = page_name.chars().take(55).collect();
                let tgt: String = link.chars().take(55).collect();
                edges_set.insert((src, tgt));
            }
        }
    }

    // Build nodes
    let mut nodes: Vec<TopologyNode> = Vec::new();
    let mut node_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
    for name in &entity_set {
        let truncated_id: String = name.chars().take(55).collect();
        let src = inlinks.get(name).cloned().unwrap_or_default();
        let total_inlinks: usize = src.values().sum();
        nodes.push(TopologyNode {
            id: truncated_id.clone(),
            b: page_subtree_counts
                .get(name)
                .copied()
                .unwrap_or(0)
                .min(3000),
            i: total_inlinks,
            rc: src.len(),
            orp: if orphan_set.contains(name) { 1 } else { 0 },
            is_ref: if ref_only_set.contains(name) { 1 } else { 0 },
            bid: page_name_to_id.get(&name.to_lowercase()).cloned(),
        });
        node_ids.insert(truncated_id);
    }

    // Filter edges to only include nodes present
    let edges: Vec<[String; 2]> = edges_set
        .into_iter()
        .filter(|(s, t)| node_ids.contains(s) && node_ids.contains(t))
        .map(|(s, t)| [s, t])
        .collect();

    // Daily entries (sorted)
    let mut daily: Vec<DailyEntry> = daily_counts
        .into_iter()
        .map(|(d, n)| DailyEntry { d, n })
        .collect();
    daily.sort_by(|a, b| a.d.cmp(&b.d));

    let meta = TopologyMeta {
        blocks: total_blocks,
        pages: existing_pages.len(),
        days: daily.len(),
        roots: root_ids.len(),
        ref_only: ref_only_set.len(),
        orphans: orphan_set.len(),
    };

    Ok(Json(TopologyResponse {
        nodes,
        edges,
        content: content_map,
        daily,
        meta,
    }))
}

/// GET /api/v1/topology/content/:pageName - Full content for a single page.
///
/// Returns the complete outline content for a page (no line/char limits).
/// Use this for on-demand content loading when a user clicks a node in the manifest.
async fn get_page_content(
    State(state): State<AppState>,
    Path(page_name): Path<String>,
) -> Result<Json<PageContentResponse>, ApiError> {
    let page_index = state
        .page_name_index
        .read()
        .map_err(|_| ApiError::LockPoisoned)?;
    let doc = state.store.doc();
    let doc_guard = doc.read().map_err(|_| ApiError::LockPoisoned)?;
    let txn = doc_guard.transact();

    let normalized = page_name.to_lowercase();

    // Find the page block ID from pages:: container
    let pages_container_id = page_index.pages_container_id().map(String::from);
    let mut page_block_id: Option<String> = None;

    if let (Some(ref container_id), Some(blocks_map)) = (&pages_container_id, txn.get_map("blocks"))
    {
        if let Some(yrs::Out::YMap(container)) = blocks_map.get(&txn, container_id.as_str()) {
            if let Some(yrs::Out::YArray(child_ids_arr)) = container.get(&txn, "childIds") {
                for val in child_ids_arr.iter(&txn) {
                    if let yrs::Out::Any(yrs::Any::String(child_id)) = val {
                        if let Some(yrs::Out::YMap(child_block)) =
                            blocks_map.get(&txn, child_id.as_ref())
                        {
                            let content = child_block
                                .get(&txn, "content")
                                .and_then(|v| match v {
                                    yrs::Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
                                    _ => None,
                                })
                                .unwrap_or_default();
                            let name = strip_heading_prefix(&content).to_lowercase();
                            if name == normalized {
                                page_block_id = Some(child_id.to_string());
                                break;
                            }
                        }
                    }
                }
            }
        }
    }

    let page_id = page_block_id
        .ok_or_else(|| ApiError::NotFound(format!("Page not found: {}", page_name)))?;

    // Collect all blocks for subtree walk
    let mut all_blocks: std::collections::HashMap<String, (String, Vec<String>)> =
        std::collections::HashMap::new();
    let mut parent_map: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();

    if let Some(blocks_map) = txn.get_map("blocks") {
        for (key, value) in blocks_map.iter(&txn) {
            if let yrs::Out::YMap(block_map) = value {
                let content = block_map
                    .get(&txn, "content")
                    .and_then(|v| match v {
                        yrs::Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
                        _ => None,
                    })
                    .unwrap_or_default();
                let child_ids: Vec<String> = block_map
                    .get(&txn, "childIds")
                    .and_then(|v| match v {
                        yrs::Out::YArray(arr) => Some(
                            arr.iter(&txn)
                                .filter_map(|v| match v {
                                    yrs::Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
                                    _ => None,
                                })
                                .collect(),
                        ),
                        _ => None,
                    })
                    .unwrap_or_default();
                if let Some(yrs::Out::Any(yrs::Any::String(pid))) = block_map.get(&txn, "parentId")
                {
                    parent_map.insert(key.to_string(), pid.to_string());
                }
                all_blocks.insert(key.to_string(), (content, child_ids));
            }
        }
    }

    // Walk subtree — no limits
    let mut lines = Vec::new();
    let mut block_count = 0usize;
    let mut stack = vec![page_id.clone()];
    let mut visited = std::collections::HashSet::new();

    while let Some(block_id) = stack.pop() {
        if !visited.insert(block_id.clone()) {
            continue;
        }
        if let Some((content, child_ids)) = all_blocks.get(&block_id) {
            block_count += 1;
            if block_id != page_id {
                let line = content.lines().next().unwrap_or("").trim().to_string();
                if !line.is_empty() {
                    // Depth from page root
                    let mut d: usize = 0;
                    let mut cur = block_id.clone();
                    while cur != page_id && d < 20 {
                        match parent_map.get(&cur) {
                            Some(pid) => {
                                cur = pid.clone();
                                d += 1;
                            }
                            None => break,
                        }
                    }
                    lines.push((d.saturating_sub(1).min(10) as u8, line));
                }
            }
            for child_id in child_ids.iter().rev() {
                stack.push(child_id.clone());
            }
        }
    }

    Ok(Json(PageContentResponse {
        name: normalized,
        lines,
        block_count,
    }))
}

/// Strip heading prefix (# ## ### etc) from content.
///
/// Mirrors `PageNameIndexHook::strip_heading_prefix` in floatty-core:
/// - Takes first line only (multi-line pages embed markers on subsequent lines)
/// - Strips leading '#' characters and surrounding whitespace
///
/// Examples:
///   "# My Page"                    → "My Page"
///   "# Summary\n[board:: recon]"   → "Summary"
///   "No prefix"                    → "No prefix"
fn strip_heading_prefix(content: &str) -> &str {
    let first_line = content.lines().next().unwrap_or(content);
    first_line.trim_start_matches('#').trim()
}

// ============================================================================
// FLO-679 PR 1 (commit 5) — find_root migration tests.
//
// `find_root` was removed in favour of `walk_ancestors(...).ids.last()`. The
// pre-merge audit (single caller; cycle participants are never in `rootIds`)
// confirmed the cycle-as-root semantic shift is unobservable in production.
// These tests pin the migrated logic against the same `parent_map`-shape
// inputs the real export path produces.
// ============================================================================

#[cfg(test)]
mod find_root_migration_tests {
    use super::*;
    use std::collections::HashMap;

    fn parent_map(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(c, p)| ((*c).to_string(), (*p).to_string()))
            .collect()
    }

    /// Mirrors the migrated `find_root` projection at `export.rs:~528` so the
    /// shape of the assertion is identical to the production code path.
    fn find_root(map: &HashMap<String, String>, block_id: &str) -> String {
        let lookup = HashMapParentLookup::new(map);
        let walk = walk_ancestors(&lookup, block_id, 500, None);
        walk.ids
            .last()
            .cloned()
            .unwrap_or_else(|| block_id.to_string())
    }

    #[test]
    fn find_root_returns_self_for_root_block() {
        let map = parent_map(&[]);
        assert_eq!(find_root(&map, "r"), "r");
    }

    #[test]
    fn find_root_walks_to_top_of_chain() {
        // leaf → mid → root
        let map = parent_map(&[("leaf", "mid"), ("mid", "root")]);
        assert_eq!(find_root(&map, "leaf"), "root");
    }

    /// Documents the semantic shift the audit cleared.
    ///
    /// PRE-MIGRATION (`find_root` recursion + depth-500 cap): on cycle, the
    /// function returned the *original* `block_id` — "treat cycles as their
    /// own root."
    ///
    /// POST-MIGRATION (`walk_ancestors(...).ids.last()`): returns the deepest
    /// reachable ancestor. For A → B → A walking from A, ids = [B], so
    /// `.last() = B`.
    ///
    /// The only caller (`root_names.get(&root_id)`) only contains entries for
    /// blocks present in `rootIds`. Cycle participants are by definition NOT
    /// in `rootIds`, so the lookup returns `None` either way and the caller
    /// falls back to the `"other"` territory in both pre- and post-migration
    /// code. Audit recorded in PR description.
    #[test]
    fn find_root_returns_last_reachable_on_cycle() {
        // A → B → A (synthetic cycle).
        let map = parent_map(&[("a", "b"), ("b", "a")]);
        // Pre-migration would have returned "a" (the original block_id).
        // Post-migration returns "b" (the last reachable ancestor).
        assert_eq!(
            find_root(&map, "a"),
            "b",
            "cycle now returns deepest reachable, not self — see PR audit"
        );
    }

    #[test]
    fn find_root_returns_last_reachable_on_long_cycle() {
        // A → B → C → B (cycle starts mid-chain).
        let map = parent_map(&[("a", "b"), ("b", "c"), ("c", "b")]);
        assert_eq!(find_root(&map, "a"), "c");
    }

    #[test]
    fn find_root_caps_at_500_for_pathological_chains() {
        // 600-deep chain. Walker caps at 500, so .last() is the 500th ancestor.
        let mut map: HashMap<String, String> = HashMap::new();
        for i in 0..600 {
            map.insert(format!("b{}", i), format!("b{}", i + 1));
        }
        // b0's 500th ancestor is b500. Pre-migration also stopped at depth 500
        // (treating it as own root); the new "last reachable" semantic returns
        // a different value but neither value is in rootIds in production, so
        // root_names.get(&_) → None either way.
        let r = find_root(&map, "b0");
        assert_eq!(r, "b500", "saturated walker returns last collected ancestor");
    }
}
