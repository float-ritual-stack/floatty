//! Block CRUD service — shared block semantics for all route families.
//!
//! BlockService owns the canonical CRUD operations. Handlers (legacy and outline)
//! are thin wrappers that resolve an OutlineContext, call BlockService, and
//! format the HTTP response.
//!
//! **No route-awareness.** BlockService doesn't know whether the caller is
//! a legacy route or an outline route. Route-specific behavior belongs in handlers.

use crate::api::{self, ApiError, BlockDto, BlocksResponse, InheritedMarkerDto};
use floatty_core::hooks::InheritanceIndex;
use floatty_core::YDocStore;
use std::sync::{Arc, RwLock};
use yrs::{Array, Map, ReadTxn, Transact};

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
