//! Block CRUD service — shared block semantics for all route families.
//!
//! BlockService owns the canonical CRUD operations. Handlers (legacy and outline)
//! are thin wrappers that resolve an OutlineContext, call BlockService, and
//! format the HTTP response.
//!
//! **No route-awareness.** BlockService doesn't know whether the caller is
//! a legacy route or an outline route. Route-specific behavior belongs in handlers.

use crate::api::{self, ApiError, BlockDto, BlockRef, BlocksResponse, InheritedMarkerDto, SiblingContext, TokenEstimate, TreeNode};
use crate::WsBroadcaster;
use floatty_core::events::BlockChange;
use floatty_core::hooks::InheritanceIndex;
use floatty_core::{HookSystem, Origin, YDocStore};
use std::collections::HashSet;
use std::sync::{Arc, RwLock};
use yrs::{Array, ArrayPrelim, Map, MapPrelim, ReadTxn, Transact, WriteTxn};

// =========================================================================
// Helpers (pub(crate) — used by api.rs handlers during incremental migration)
// =========================================================================

/// Extract timestamp from Y.Doc value (handles f64 and i64).
pub(crate) fn extract_timestamp(value: Option<yrs::Out>) -> i64 {
    value
        .and_then(|v| match v {
            yrs::Out::Any(yrs::Any::Number(n)) => Some(n as i64),
            yrs::Out::Any(yrs::Any::BigInt(n)) => Some(n),
            _ => None,
        })
        .unwrap_or(0)
}

/// Resolve a block ID or short-hash prefix to a full canonical block ID.
///
/// - Full UUID (36 chars with dashes): O(1) exact lookup, case-insensitive
/// - 6+ hex chars: O(n) prefix scan, dash-stripped matching
/// - Non-hex or <6 chars: treated as literal ID, exact lookup (backward compat)
pub(crate) fn resolve_block_id<T: ReadTxn>(
    id_or_prefix: &str,
    blocks_map: &yrs::MapRef,
    txn: &T,
) -> Result<String, ApiError> {
    let trimmed = id_or_prefix.trim();
    let lower = trimmed.to_lowercase();

    let is_full_uuid = trimmed.len() == 36 && {
        let b = trimmed.as_bytes();
        b[8] == b'-' && b[13] == b'-' && b[18] == b'-' && b[23] == b'-'
            && trimmed.chars().enumerate().all(|(i, c)| {
                if i == 8 || i == 13 || i == 18 || i == 23 { c == '-' }
                else { c.is_ascii_hexdigit() }
            })
    };

    if is_full_uuid {
        if blocks_map.get(txn, &lower).is_some() {
            return Ok(lower);
        }
        if blocks_map.get(txn, trimmed).is_some() {
            return Ok(trimmed.to_string());
        }
        return Err(ApiError::NotFound(trimmed.to_string()));
    }

    let is_hex_prefix = trimmed.len() >= 6 && trimmed.chars().all(|c| c.is_ascii_hexdigit());

    if !is_hex_prefix {
        if blocks_map.get(txn, trimmed).is_some() {
            return Ok(trimmed.to_string());
        }
        return Err(ApiError::NotFound(trimmed.to_string()));
    }

    let mut matches: Vec<String> = Vec::new();

    for (key, _value) in blocks_map.iter(txn) {
        let key_lower = key.to_lowercase();
        if key_lower.starts_with(&lower) {
            matches.push(key.to_string());
            continue;
        }
        let key_nodash: String = key_lower.chars().filter(|c| *c != '-').collect();
        if key_nodash.starts_with(&lower) {
            matches.push(key.to_string());
        }
    }

    match matches.len() {
        0 => Err(ApiError::NotFound(format!("No block matches prefix '{}'", trimmed))),
        1 => Ok(matches.into_iter().next().unwrap()),
        n => Err(ApiError::Ambiguous(n)),
    }
}

/// Resolve a block ID field from a request body, wrapping errors with field name context.
pub(crate) fn resolve_body_field<T: ReadTxn>(
    id_or_prefix: &str,
    field_name: &str,
    blocks_map: &yrs::MapRef,
    txn: &T,
) -> Result<String, ApiError> {
    resolve_block_id(id_or_prefix, blocks_map, txn).map_err(|e| match e {
        ApiError::Ambiguous(n) => ApiError::InvalidRequest(
            format!("Ambiguous prefix in {}: {} matches", field_name, n),
        ),
        ApiError::NotFound(msg) => ApiError::NotFound(
            format!("{} not found: {}", field_name, msg),
        ),
        other => other,
    })
}

/// Map InheritanceIndex results to InheritedMarkerDto for API responses.
pub(crate) fn lookup_inherited(index: &InheritanceIndex, block_id: &str) -> Option<Vec<InheritedMarkerDto>> {
    let inherited = index.get(block_id);
    if inherited.is_empty() {
        None
    } else {
        Some(
            inherited
                .iter()
                .map(|m| InheritedMarkerDto {
                    marker_type: m.marker_type.clone(),
                    value: m.value.clone(),
                    source_block_id: m.source_block_id.clone(),
                })
                .collect(),
        )
    }
}

/// Read a BlockDto from a Y.Map block entry.
///
/// Callers provide pre-computed `inherited_markers` so bulk endpoints can
/// acquire the inheritance index lock once instead of per-block.
pub(crate) fn read_block_dto<T: ReadTxn>(
    block_map: &yrs::MapRef,
    txn: &T,
    id: &str,
    inherited_markers: Option<Vec<InheritedMarkerDto>>,
    include_output: bool,
) -> BlockDto {
    let content = block_map
        .get(txn, "content")
        .and_then(|v| match v {
            yrs::Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
            _ => None,
        })
        .unwrap_or_default();

    let parent_id = block_map.get(txn, "parentId").and_then(|v| match v {
        yrs::Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
        yrs::Out::Any(yrs::Any::Null) => None,
        _ => None,
    });

    let child_ids = block_map
        .get(txn, "childIds")
        .and_then(|v| match v {
            yrs::Out::YArray(arr) => Some(
                arr.iter(txn)
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
        .get(txn, "collapsed")
        .and_then(|v| match v {
            yrs::Out::Any(yrs::Any::Bool(b)) => Some(b),
            _ => None,
        })
        .unwrap_or(false);

    let metadata = block_map
        .get(txn, "metadata")
        .and_then(|v| api::extract_metadata_from_yrs(v, txn));

    let created_at = extract_timestamp(block_map.get(txn, "createdAt"));
    let updated_at = extract_timestamp(block_map.get(txn, "updatedAt"));

    let output_type = block_map
        .get(txn, "outputType")
        .and_then(|v| match v {
            yrs::Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
            _ => None,
        });

    let output = if include_output {
        block_map
            .get(txn, "output")
            .map(|v| api::yrs_out_to_json(v, txn))
    } else {
        None
    };

    let block_type = floatty_core::parse_block_type(&content);

    BlockDto {
        id: id.to_string(),
        content,
        parent_id,
        child_ids,
        collapsed,
        block_type: format!("{:?}", block_type).to_lowercase(),
        metadata,
        inherited_markers,
        created_at,
        updated_at,
        output_type,
        output,
    }
}

// =========================================================================
// Block field readers (used by context helpers below)
// =========================================================================

/// Read a block's content from a Y.Map within a transaction.
pub(crate) fn read_block_content<T: ReadTxn>(blocks_map: &yrs::MapRef, txn: &T, block_id: &str) -> Option<String> {
    let block_map = match blocks_map.get(txn, block_id)? {
        yrs::Out::YMap(map) => map,
        _ => return None,
    };
    block_map
        .get(txn, "content")
        .and_then(|v| match v {
            yrs::Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
            _ => None,
        })
}

/// Read a block's parentId from Y.Doc.
pub(crate) fn read_block_parent_id<T: ReadTxn>(blocks_map: &yrs::MapRef, txn: &T, block_id: &str) -> Option<String> {
    let block_map = match blocks_map.get(txn, block_id)? {
        yrs::Out::YMap(map) => map,
        _ => return None,
    };
    block_map.get(txn, "parentId").and_then(|v| match v {
        yrs::Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
        _ => None,
    })
}

/// Read a block's childIds from Y.Doc.
pub(crate) fn read_block_child_ids<T: ReadTxn>(blocks_map: &yrs::MapRef, txn: &T, block_id: &str) -> Vec<String> {
    let block_map = match blocks_map.get(txn, block_id) {
        Some(yrs::Out::YMap(map)) => map,
        _ => return Vec::new(),
    };
    block_map
        .get(txn, "childIds")
        .and_then(|v| match v {
            yrs::Out::YArray(arr) => Some(
                arr.iter(txn)
                    .filter_map(|v| match v {
                        yrs::Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
                        _ => None,
                    })
                    .collect(),
            ),
            _ => None,
        })
        .unwrap_or_default()
}

/// Parse include directives from comma-separated string.
pub(crate) fn parse_includes(include: &Option<String>) -> HashSet<String> {
    include
        .as_ref()
        .map(|s| s.split(',').map(|p| p.trim().to_lowercase()).collect())
        .unwrap_or_default()
}

// =========================================================================
// Block context helpers (FLO-338)
// =========================================================================

/// Walk the parent chain up to root, returning ancestor BlockRefs (nearest first).
/// Max 10 ancestors to prevent runaway.
pub(crate) fn get_ancestors<T: ReadTxn>(blocks_map: &yrs::MapRef, txn: &T, block_id: &str) -> Vec<BlockRef> {
    let mut ancestors = Vec::new();
    let mut current_id = block_id.to_string();
    for _ in 0..10 {
        match read_block_parent_id(blocks_map, txn, &current_id) {
            Some(pid) => {
                let content = read_block_content(blocks_map, txn, &pid).unwrap_or_default();
                ancestors.push(BlockRef { id: pid.clone(), content });
                current_id = pid;
            }
            None => break,
        }
    }
    ancestors
}

/// Get siblings before/after a block within its parent's childIds.
pub(crate) fn get_siblings<T: ReadTxn>(
    blocks_map: &yrs::MapRef,
    txn: &T,
    block_id: &str,
    radius: usize,
) -> SiblingContext {
    let empty = SiblingContext { before: vec![], after: vec![] };

    let parent_id = match read_block_parent_id(blocks_map, txn, block_id) {
        Some(id) => id,
        None => return empty,
    };
    let sibling_ids = read_block_child_ids(blocks_map, txn, &parent_id);

    let pos = match sibling_ids.iter().position(|id| id == block_id) {
        Some(p) => p,
        None => return empty,
    };

    let before_start = pos.saturating_sub(radius);
    let before: Vec<BlockRef> = sibling_ids[before_start..pos]
        .iter()
        .map(|id| BlockRef {
            id: id.clone(),
            content: read_block_content(blocks_map, txn, id).unwrap_or_default(),
        })
        .collect();

    let after_end = pos.saturating_add(1).saturating_add(radius).min(sibling_ids.len());
    let after: Vec<BlockRef> = sibling_ids[(pos + 1)..after_end]
        .iter()
        .map(|id| BlockRef {
            id: id.clone(),
            content: read_block_content(blocks_map, txn, id).unwrap_or_default(),
        })
        .collect();

    SiblingContext { before, after }
}

/// Get direct children as BlockRefs.
pub(crate) fn get_children_refs<T: ReadTxn>(blocks_map: &yrs::MapRef, txn: &T, block_id: &str) -> Vec<BlockRef> {
    read_block_child_ids(blocks_map, txn, block_id)
        .iter()
        .map(|id| BlockRef {
            id: id.clone(),
            content: read_block_content(blocks_map, txn, id).unwrap_or_default(),
        })
        .collect()
}

/// DFS traversal of subtree, returning TreeNodes with depth.
/// Respects max_depth and caps total nodes at 1000.
pub(crate) fn get_subtree<T: ReadTxn>(
    blocks_map: &yrs::MapRef,
    txn: &T,
    root_id: &str,
    max_depth: usize,
) -> Vec<TreeNode> {
    let mut result = Vec::new();
    let mut stack: Vec<(String, usize)> = Vec::new();

    // Start with root's children at depth 1
    let root_children = read_block_child_ids(blocks_map, txn, root_id);
    for child_id in root_children.into_iter().rev() {
        stack.push((child_id, 1));
    }

    while let Some((id, depth)) = stack.pop() {
        if result.len() >= 1000 { break; }

        let content = read_block_content(blocks_map, txn, &id).unwrap_or_default();
        let child_ids = read_block_child_ids(blocks_map, txn, &id);

        // Push children for further traversal if within depth limit
        if depth < max_depth {
            for child_id in child_ids.iter().rev() {
                stack.push((child_id.clone(), depth + 1));
            }
        }

        result.push(TreeNode {
            id: id.clone(),
            content,
            depth,
            child_ids,
        });
    }

    result
}

/// Compute a rough token estimate for a subtree.
pub(crate) fn compute_token_estimate<T: ReadTxn>(
    blocks_map: &yrs::MapRef,
    txn: &T,
    root_id: &str,
    max_depth: usize,
) -> TokenEstimate {
    let mut total_chars = 0usize;
    let mut block_count = 0usize;
    let mut deepest = 0usize;
    let mut stack: Vec<(String, usize)> = Vec::new();

    // Include root content
    if let Some(content) = read_block_content(blocks_map, txn, root_id) {
        total_chars += content.chars().count();
    }
    block_count += 1;

    let root_children = read_block_child_ids(blocks_map, txn, root_id);
    for child_id in root_children.into_iter().rev() {
        stack.push((child_id, 1));
    }

    while let Some((id, depth)) = stack.pop() {
        if block_count >= 5000 { break; } // Safety cap

        if let Some(content) = read_block_content(blocks_map, txn, &id) {
            total_chars += content.chars().count();
        }
        block_count += 1;
        if depth > deepest { deepest = depth; }

        if depth < max_depth {
            let child_ids = read_block_child_ids(blocks_map, txn, &id);
            for child_id in child_ids.into_iter().rev() {
                stack.push((child_id, depth + 1));
            }
        }
    }

    TokenEstimate {
        total_chars,
        block_count,
        max_depth: deepest,
    }
}

// =========================================================================
// Block context orchestrator
// =========================================================================

/// Build a BlockWithContextResponse from a block DTO and query params.
/// Shared between get_block and get_daily_note.
pub(crate) fn build_block_context_response<T: ReadTxn>(
    blocks_map: &yrs::MapRef,
    txn: &T,
    block_id: &str,
    block_dto: BlockDto,
    ctx_query: &api::BlockContextQuery,
) -> api::BlockWithContextResponse {
    let includes = parse_includes(&ctx_query.include);
    let sibling_radius = ctx_query.sibling_radius.min(50);
    let max_depth = ctx_query.max_depth.min(100);

    api::BlockWithContextResponse {
        block: block_dto,
        ancestors: includes.contains("ancestors").then(|| get_ancestors(blocks_map, txn, block_id)),
        siblings: includes.contains("siblings").then(|| get_siblings(blocks_map, txn, block_id, sibling_radius)),
        children: includes.contains("children").then(|| get_children_refs(blocks_map, txn, block_id)),
        tree: includes.contains("tree").then(|| get_subtree(blocks_map, txn, block_id, max_depth)),
        token_estimate: includes.contains("token_estimate").then(|| compute_token_estimate(blocks_map, txn, block_id, max_depth)),
    }
}

// =========================================================================
// Descendant collection (used by delete_block in Step 5)
// =========================================================================

/// Collect a block and all its descendants via stack-based traversal.
/// Returns Vec of (id, content) pairs for hook event emission.
pub(crate) fn collect_descendants(
    blocks: &yrs::MapRef,
    txn: &yrs::TransactionMut<'_>,
    root_id: &str,
) -> Vec<(String, String)> {
    let mut result = Vec::new();
    let mut stack = vec![root_id.to_string()];

    while let Some(current_id) = stack.pop() {
        if let Some(yrs::Out::YMap(block_map)) = blocks.get(txn, &current_id) {
            let content = block_map
                .get(txn, "content")
                .and_then(|v| match v {
                    yrs::Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
                    _ => None,
                })
                .unwrap_or_default();

            // Push children onto stack for traversal
            if let Some(yrs::Out::YArray(child_ids)) = block_map.get(txn, "childIds") {
                for value in child_ids.iter(txn) {
                    if let yrs::Out::Any(yrs::Any::String(s)) = value {
                        stack.push(s.to_string());
                    }
                }
            }

            result.push((current_id, content));
        }
    }

    result
}

// =========================================================================
// Read operations
// =========================================================================

/// Get all blocks with optional filters. Returns BlocksResponse with typed DTOs.
pub(crate) fn get_blocks(
    store: &Arc<YDocStore>,
    inheritance_index: Option<&RwLock<InheritanceIndex>>,
    query: &api::BlocksQuery,
) -> Result<BlocksResponse, ApiError> {
    let doc = store.doc();
    let doc_guard = doc.read().map_err(|_| ApiError::LockPoisoned)?;
    let txn = doc_guard.transact();

    let mut blocks = Vec::new();
    let mut root_ids = Vec::new();

    if let Some(root_ids_arr) = txn.get_array("rootIds") {
        for value in root_ids_arr.iter(&txn) {
            if let yrs::Out::Any(yrs::Any::String(id)) = value {
                root_ids.push(id.to_string());
            }
        }
    }

    // Acquire inheritance index once for all blocks (if available)
    let inheritance_guard = inheritance_index
        .and_then(|idx| idx.read().ok());

    if let Some(blocks_map) = txn.get_map("blocks") {
        for (key, value) in blocks_map.iter(&txn) {
            if let yrs::Out::YMap(block_map) = value {
                let block_id = key.to_string();
                let inherited_markers = inheritance_guard
                    .as_ref()
                    .and_then(|guard| lookup_inherited(guard, &block_id));
                let dto = read_block_dto(&block_map, &txn, &block_id, inherited_markers, false);

                // Apply query filters
                if let Some(since) = query.since {
                    if dto.created_at < since { continue; }
                }
                if let Some(until) = query.until {
                    if dto.created_at >= until { continue; }
                }
                if let Some(ref mt) = query.marker_type {
                    let has_marker = dto.metadata.as_ref()
                        .and_then(|m| m.get("markers"))
                        .and_then(|arr| arr.as_array())
                        .map(|markers| {
                            markers.iter().any(|marker| {
                                let type_match = marker.get("markerType").and_then(|v| v.as_str()) == Some(mt.as_str());
                                if let Some(ref mv) = query.marker_value {
                                    type_match && marker.get("value").and_then(|v| v.as_str()) == Some(mv.as_str())
                                } else {
                                    type_match
                                }
                            })
                        }).unwrap_or(false);
                    if !has_marker { continue; }
                }

                blocks.push(dto);
            }
        }
    }

    Ok(BlocksResponse { blocks, root_ids })
}

/// Get a single block by ID with optional context (?include= params).
pub(crate) fn get_block(
    store: &Arc<YDocStore>,
    inheritance_index: &RwLock<InheritanceIndex>,
    id: &str,
    ctx_query: &api::BlockContextQuery,
) -> Result<api::BlockWithContextResponse, ApiError> {
    let doc = store.doc();
    let doc_guard = doc.read().map_err(|_| ApiError::LockPoisoned)?;
    let txn = doc_guard.transact();

    let blocks_map = txn
        .get_map("blocks")
        .ok_or_else(|| ApiError::NotFound("blocks map not found".to_string()))?;

    // Resolve short-hash prefix to full block ID
    let id = resolve_block_id(id, &blocks_map, &txn)?;

    let value = blocks_map
        .get(&txn, &id)
        .ok_or_else(|| ApiError::NotFound(id.clone()))?;

    if let yrs::Out::YMap(block_map) = value {
        let inherited_markers = {
            let index = inheritance_index.read().map_err(|_| ApiError::LockPoisoned)?;
            lookup_inherited(&index, &id)
        };
        let block_dto = read_block_dto(&block_map, &txn, &id, inherited_markers, true);

        Ok(build_block_context_response(
            &blocks_map, &txn, &id, block_dto, ctx_query,
        ))
    } else {
        Err(ApiError::NotFound(id))
    }
}

// =========================================================================
// Write operations
// =========================================================================

/// Create a new block. Handles validation, Y.Doc mutation, persistence,
/// broadcast, and hook emission.
pub(crate) fn create_block(
    store: &Arc<YDocStore>,
    broadcaster: &Arc<WsBroadcaster>,
    hook_system: &Arc<HookSystem>,
    mut req: api::CreateBlockRequest,
) -> Result<BlockDto, ApiError> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;

    let doc = store.doc();
    let doc_guard = doc.write().map_err(|_| ApiError::LockPoisoned)?;

    // Resolve short-hash prefixes in body fields (if blocks map exists)
    {
        let txn = doc_guard.transact();
        if let Some(blocks_map) = txn.get_map("blocks") {
            if let Some(ref parent_id) = req.parent_id {
                let resolved = resolve_body_field(parent_id, "parentId", &blocks_map, &txn)?;
                req.parent_id = Some(resolved);
            }
            if let Some(ref after_id) = req.after_id {
                let resolved = resolve_body_field(after_id, "afterId", &blocks_map, &txn)?;
                req.after_id = Some(resolved);
            }
        }
    }

    let update = {
        let mut txn = doc_guard.transact_mut();
        let blocks = txn.get_or_insert_map("blocks");

        // Validate parent exists before creating block
        if let Some(ref parent_id) = req.parent_id {
            match blocks.get(&txn, parent_id) {
                Some(yrs::Out::YMap(_)) => {} // Parent exists, continue
                _ => {
                    return Err(ApiError::NotFound(format!(
                        "Parent block not found: {}",
                        parent_id
                    )));
                }
            }
        }

        // Validate positional insertion parameters
        // 1. Check mutual exclusivity
        if req.after_id.is_some() && req.at_index.is_some() {
            return Err(ApiError::InvalidRequest(
                "Cannot specify both afterId and atIndex".to_string()
            ));
        }

        // 2. Validate afterId if present
        if let Some(ref after_id) = req.after_id {
            match blocks.get(&txn, after_id) {
                Some(yrs::Out::YMap(after_map)) => {
                    // Check afterId block shares same parent
                    let after_parent = after_map.get(&txn, "parentId")
                        .and_then(|v| match v {
                            yrs::Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
                            _ => None,
                        });

                    let expected_parent = req.parent_id.as_ref().map(|s| s.as_str());
                    let actual_parent = after_parent.as_ref().map(|s| s.as_str());

                    if actual_parent != expected_parent {
                        return Err(ApiError::InvalidRequest(format!(
                            "Block {} is not a sibling (different parent)",
                            after_id
                        )));
                    }
                }
                _ => {
                    return Err(ApiError::NotFound(format!(
                        "afterId block not found: {}",
                        after_id
                    )));
                }
            }
        }

        // Create nested Y.Map for block with Y.Array for childIds
        let parent_id_value: yrs::Any = match &req.parent_id {
            Some(p) => yrs::Any::String(p.clone().into()),
            None => yrs::Any::Null,
        };
        let block_map = blocks.insert(
            &mut txn,
            id.as_str(),
            MapPrelim::from([
                ("id".to_owned(), yrs::any!(id.clone())),
                ("content".to_owned(), yrs::any!(req.content.clone())),
                ("parentId".to_owned(), parent_id_value),
                ("collapsed".to_owned(), yrs::any!(false)),
                ("createdAt".to_owned(), yrs::any!(now as f64)),
                ("updatedAt".to_owned(), yrs::any!(now as f64)),
            ]),
        );
        // Insert childIds as nested Y.Array (empty)
        let empty: Vec<yrs::Any> = vec![];
        block_map.insert(&mut txn, "childIds", ArrayPrelim::from(empty));

        // Update parent's childIds or add to rootIds
        if let Some(ref parent_id) = req.parent_id {
            // Add to parent's childIds array (already validated parent exists above)
            if let Some(yrs::Out::YMap(parent_map)) = blocks.get(&txn, parent_id) {
                if let Some(yrs::Out::YArray(child_ids)) = parent_map.get(&txn, "childIds") {

                    // Determine insertion index
                    let insert_idx = if let Some(ref after_id) = req.after_id {
                        // Find position of afterId sibling, insert after it
                        let child_ids_vec: Vec<String> = child_ids
                            .iter(&txn)
                            .filter_map(|v| match v {
                                yrs::Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
                                _ => None,
                            })
                            .collect();

                        child_ids_vec.iter()
                            .position(|x| x == after_id)
                            .map(|idx| idx + 1)
                            .unwrap_or(child_ids.len(&txn) as usize)  // Fallback: append
                    } else if let Some(at_index) = req.at_index {
                        // Clamp to valid range (0..=length)
                        at_index.min(child_ids.len(&txn) as usize)
                    } else {
                        // Default: append to end (backward compatible)
                        child_ids.len(&txn) as usize
                    };

                    // Use Y.Array insert() - surgical, 1 CRDT op (FLO-280 pattern)
                    child_ids.insert(&mut txn, insert_idx as u32, id.as_str());
                }
            }
        } else {
            // No parent - add to rootIds
            let root_ids = txn.get_or_insert_array("rootIds");

            let insert_idx = if let Some(ref after_id) = req.after_id {
                let root_vec: Vec<String> = root_ids
                    .iter(&txn)
                    .filter_map(|v| match v {
                        yrs::Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
                        _ => None,
                    })
                    .collect();

                root_vec.iter()
                    .position(|x| x == after_id)
                    .map(|idx| idx + 1)
                    .unwrap_or(root_ids.len(&txn) as usize)
            } else if let Some(at_index) = req.at_index {
                at_index.min(root_ids.len(&txn) as usize)
            } else {
                root_ids.len(&txn) as usize
            };

            root_ids.insert(&mut txn, insert_idx as u32, id.as_str());
        }

        txn.encode_update_v1()
    };
    drop(doc_guard);

    // Persist and broadcast to WebSocket clients
    let seq = store.persist_update(&update)?;
    broadcaster.broadcast(update, None, Some(seq));

    // Emit to hook system for metadata extraction
    let _ = hook_system.emit_change(BlockChange::Created {
        id: id.clone(),
        content: req.content.clone(),
        parent_id: req.parent_id.clone(),
        origin: Origin::User,
    });

    let block_type = floatty_core::parse_block_type(&req.content);

    Ok(BlockDto {
        id,
        content: req.content,
        parent_id: req.parent_id,
        child_ids: vec![],
        collapsed: false,
        block_type: format!("{:?}", block_type).to_lowercase(),
        metadata: None, // Hooks will populate async
        inherited_markers: None, // Computed on read
        created_at: now as i64,
        updated_at: now as i64,
        output_type: None,
        output: None,
    })
}
