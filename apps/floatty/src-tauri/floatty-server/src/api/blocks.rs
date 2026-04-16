//! Block CRUD handlers — get, create, import, update, delete, resolve prefix.

use axum::{
    extract::{Path, State},
    http::StatusCode,
    routing::{delete, get, patch, post, put},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use yrs::{Map, ReadTxn, Transact};

use super::{ApiError, AppState, ErrorResponse};
use crate::block_service::{lookup_inherited, read_block_dto, resolve_block_id};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/blocks", get(get_blocks))
        .route("/api/v1/blocks", post(create_block))
        .route("/api/v1/blocks/import", post(import_block))
        .route("/api/v1/blocks/resolve/:prefix", get(resolve_block_prefix))
        .route("/api/v1/blocks/:id", get(get_block))
        .route("/api/v1/blocks/:id", patch(update_block))
        .route("/api/v1/blocks/:id", put(put_not_supported))
        .route("/api/v1/blocks/:id", delete(delete_block))
}

// ============================================================================
// Block DTOs
// ============================================================================

/// Block list response
#[derive(Serialize, Deserialize)]
pub struct BlocksResponse {
    pub blocks: Vec<BlockDto>,
    pub root_ids: Vec<String>,
}

/// Block DTO for API responses
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockDto {
    pub id: String,
    pub content: String,
    pub parent_id: Option<String>,
    pub child_ids: Vec<String>,
    pub collapsed: bool,
    pub block_type: String,
    /// Block metadata (markers, wikilinks, etc). Null if not set.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
    /// Markers inherited from ancestor blocks. Only present when the block
    /// has no own tag markers but an ancestor does. Contains only tag-style
    /// markers (those with values like project::floatty), not prefix markers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inherited_markers: Option<Vec<InheritedMarkerDto>>,
    /// Timestamp when block was created (ms since epoch)
    pub created_at: i64,
    /// Timestamp when block was last updated (ms since epoch)
    pub updated_at: i64,
    /// Block output type (e.g., "door", "eval-result", "search-results")
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_type: Option<String>,
    /// Block output data (door envelope, eval result, etc.)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<serde_json::Value>,
}

/// A marker inherited from an ancestor block.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct InheritedMarkerDto {
    pub marker_type: String,
    pub value: String,
    /// Block ID of the ancestor this marker was inherited from.
    pub source_block_id: String,
}

// ============================================================================
// Block Context Retrieval (FLO-338)
// ============================================================================

/// Query parameters for GET /api/v1/blocks/:id
#[derive(Deserialize, Debug, Default)]
pub struct BlockContextQuery {
    /// Comma-separated include directives: ancestors, siblings, children, tree, token_estimate
    #[serde(default)]
    pub include: Option<String>,
    /// Number of siblings before/after to include (default: 2)
    #[serde(default = "default_sibling_radius")]
    pub sibling_radius: usize,
    /// Max depth for tree traversal (default: 50, prevents runaway on huge subtrees)
    #[serde(default = "default_max_depth")]
    pub max_depth: usize,
}

fn default_sibling_radius() -> usize { 2 }
fn default_max_depth() -> usize { 50 }

/// Lightweight block reference for context (ancestors, siblings, children)
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BlockRef {
    pub id: String,
    pub content: String,
}

/// A block in a subtree traversal, with depth info
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TreeNode {
    pub id: String,
    pub content: String,
    pub depth: usize,
    pub child_ids: Vec<String>,
}

/// Sibling context: blocks before and after within parent's childIds
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SiblingContext {
    pub before: Vec<BlockRef>,
    pub after: Vec<BlockRef>,
}

/// Token/size estimate for a subtree
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TokenEstimate {
    pub total_chars: usize,
    pub block_count: usize,
    pub max_depth: usize,
}

/// Extended block response with optional context fields
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockWithContextResponse {
    #[serde(flatten)]
    pub block: BlockDto,

    /// Parent chain up to root (nearest first), max 10
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ancestors: Option<Vec<BlockRef>>,

    /// Sibling blocks before/after within parent
    #[serde(skip_serializing_if = "Option::is_none")]
    pub siblings: Option<SiblingContext>,

    /// Direct children (id + content)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<BlockRef>>,

    /// Full subtree DFS traversal
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tree: Option<Vec<TreeNode>>,

    /// Rough size estimate for the subtree
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_estimate: Option<TokenEstimate>,
}

/// Create block request
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateBlockRequest {
    pub content: String,
    pub parent_id: Option<String>,

    /// Insert after this sibling block (mutually exclusive with at_index)
    pub after_id: Option<String>,

    /// Insert at this index in parent's childIds (0 = prepend)
    /// Mutually exclusive with after_id
    pub at_index: Option<usize>,
    // NOTE: Origin field removed - origin is now handled via Y.Doc observation
    // with Origin::User for all frontend mutations. See hooks/system.rs.
}

/// Import block request — identity-preserving create for migration/curation workflows.
///
/// Use POST /api/v1/blocks/import (or /api/v1/outlines/:name/blocks/import).
/// The normal create endpoint (POST /api/v1/blocks) never accepts caller-supplied IDs —
/// server always owns identity for ordinary creates.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportBlockRequest {
    /// The block ID to preserve. Must be a valid UUID and must not already exist
    /// in the destination outline.
    pub id: String,
    pub content: String,
    pub parent_id: Option<String>,
    pub after_id: Option<String>,
    pub at_index: Option<usize>,
    /// Original creation timestamp (epoch millis). If absent, server uses current time.
    pub created_at: Option<i64>,
    /// Original update timestamp (epoch millis). If absent, server uses current time.
    pub updated_at: Option<i64>,
}

/// Update block request
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateBlockRequest {
    /// New content for the block (optional if only updating metadata)
    pub content: Option<String>,
    /// New parent ID for reparenting:
    /// - Field absent: None = don't change parent
    /// - Field present with null: Some(None) = move to root
    /// - Field present with value: Some(Some(id)) = move under parent
    #[serde(default, deserialize_with = "deserialize_optional_parent_id")]
    pub parent_id: Option<Option<String>>,
    /// Metadata to set on the block
    pub metadata: Option<serde_json::Value>,

    /// Insert after this sibling block (mutually exclusive with at_index)
    /// Used for repositioning within parent or during reparenting
    pub after_id: Option<String>,

    /// Insert at this index in parent's childIds (0 = prepend)
    /// Mutually exclusive with after_id
    pub at_index: Option<usize>,
    // NOTE: Origin field removed - origin is now handled via Y.Doc observation
    // with Origin::User for all frontend mutations. See hooks/system.rs.
}

/// Custom deserializer for Option<Option<String>> that distinguishes:
/// - field absent: returns None (don't change)
/// - field present with null: returns Some(None) (move to root)
/// - field present with value: returns Some(Some(value)) (move under parent)
fn deserialize_optional_parent_id<'de, D>(deserializer: D) -> Result<Option<Option<String>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    // Deserialize the field value (null or string)
    // The #[serde(default)] handles the absent case by not calling this at all
    let value: Option<String> = Option::deserialize(deserializer)?;
    // Wrap in Some to indicate field was present
    Ok(Some(value))
}

/// Query parameters for GET /api/v1/blocks
#[derive(Deserialize, Default)]
pub struct BlocksQuery {
    /// Filter: createdAt >= since (unix ms)
    pub since: Option<i64>,
    /// Filter: createdAt < until (unix ms)
    pub until: Option<i64>,
    /// Filter: block has a marker with this markerType
    pub marker_type: Option<String>,
    /// Filter: marker value (requires marker_type)
    pub marker_value: Option<String>,
}

/// Response for GET /api/v1/blocks/resolve/:prefix
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveResponse {
    pub id: String,
    pub block: BlockDto,
}

// ============================================================================
// Handlers
// ============================================================================

/// GET /api/v1/blocks/resolve/:prefix - Resolve short-hash prefix to full block ID
///
/// Accepts 6+ hex character prefixes (git-sha style). Returns the full block if
/// exactly one match. 400 for invalid prefix, 404 for no match, 409 for ambiguous.
async fn resolve_block_prefix(
    State(state): State<AppState>,
    Path(prefix): Path<String>,
) -> Result<Json<ResolveResponse>, ApiError> {
    let trimmed = prefix.trim();
    if trimmed.len() < 6 || !trimmed.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(ApiError::InvalidRequest(
            "Prefix must be at least 6 hex characters".to_string(),
        ));
    }
    let doc = state.store.doc();
    let doc_guard = doc.read().map_err(|_| ApiError::LockPoisoned)?;
    let txn = doc_guard.transact();

    let blocks_map = txn
        .get_map("blocks")
        .ok_or_else(|| ApiError::NotFound("blocks map not found".to_string()))?;

    let full_id = resolve_block_id(trimmed, &blocks_map, &txn)?;

    let value = blocks_map
        .get(&txn, full_id.as_str())
        .ok_or_else(|| ApiError::NotFound(full_id.clone()))?;

    if let yrs::Out::YMap(block_map) = value {
        let inherited_markers = {
            let index = state.inheritance_index.read().map_err(|_| ApiError::LockPoisoned)?;
            lookup_inherited(&index, &full_id)
        };
        let mut block_dto = read_block_dto(&block_map, &txn, &full_id, inherited_markers, true);
        // Parity with /api/v1/blocks/:id (FLO-633): inject server-computed
        // renderedMarkdown for door blocks whose frontend hook left it null.
        inject_rendered_markdown(&mut block_dto, &state.projection_cache);
        Ok(Json(ResolveResponse {
            id: full_id,
            block: block_dto,
        }))
    } else {
        Err(ApiError::NotFound(full_id))
    }
}

/// GET /api/v1/blocks - All blocks as JSON (with optional filters)
async fn get_blocks(
    State(state): State<AppState>,
    axum::extract::Query(query): axum::extract::Query<BlocksQuery>,
) -> Result<Json<BlocksResponse>, ApiError> {
    let result = crate::block_service::get_blocks(
        &state.store,
        Some(&state.inheritance_index),
        &query,
    )?;
    Ok(Json(result))
}

/// GET /api/v1/blocks/:id - Single block with optional context
async fn get_block(
    State(state): State<AppState>,
    Path(id): Path<String>,
    axum::extract::Query(ctx_query): axum::extract::Query<BlockContextQuery>,
) -> Result<Json<BlockWithContextResponse>, ApiError> {
    let mut result = crate::block_service::get_block(
        &state.store,
        &state.inheritance_index,
        &id,
        &ctx_query,
    )?;
    inject_rendered_markdown(&mut result.block, &state.projection_cache);
    Ok(Json(result))
}

/// Inject a server-computed `metadata.renderedMarkdown` into a door-block DTO
/// when the frontend hook hasn't populated it (FLO-633).
///
/// This is a read-time projection — nothing is written back to Y.Doc. The cache
/// is in-memory, keyed by `(block_id, hash(output.data))`, and bounded by an
/// LRU. Walker calls are wrapped in `catch_unwind` so malformed specs produce
/// a fall-through to the generic walker rather than a 500.
///
/// Quality tiers: frontend-hook markdown > spec walker > generic walker > null.
/// This function only fills in the gap when the frontend hook produced nothing.
pub(crate) fn inject_rendered_markdown(dto: &mut BlockDto, cache: &super::ProjectionCache) {
    // Only applies to door blocks.
    if dto.output_type.as_deref() != Some("door") {
        return;
    }
    // If the frontend hook already populated a non-empty string, leave it alone.
    let already_has = dto
        .metadata
        .as_ref()
        .and_then(|m| m.get("renderedMarkdown"))
        .and_then(|v| v.as_str())
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);
    if already_has {
        return;
    }
    // Unwrap the door output envelope: walker operates on `output.data`.
    let Some(output_data) = dto.output.as_ref().and_then(|o| o.get("data")) else {
        return;
    };

    // Hash the output bytes for cache key (content-addressed invalidation).
    let hash = hash_json_value(output_data);
    let key: super::ProjectionCacheKey = (dto.id.clone(), hash);

    // Fast path: cache hit.
    if let Ok(mut guard) = cache.lock() {
        if let Some(cached) = guard.get(&key).cloned() {
            write_rendered_markdown(dto, cached);
            return;
        }
    }

    // Cache miss — compute with panic protection. Spec walker first, generic
    // walker as last resort. Both walkers are documented as panic-free but we
    // wrap defensively in case of future changes or untrusted data shapes.
    // `catch_unwind` on a closure that borrows `&Value` is fine: serde_json::Value
    // is RefUnwindSafe, so no clone is required — AssertUnwindSafe is kept because
    // `dto.id` (the warn! field) does not carry an UnwindSafe bound through axum.
    let mut computed = run_walker_protected(
        "spec",
        &dto.id,
        || floatty_core::projections::walk_spec_to_markdown(output_data),
    );
    if computed.trim().is_empty() {
        computed = run_walker_protected(
            "generic",
            &dto.id,
            || floatty_core::projections::walk_generic_json_to_markdown(output_data),
        );
    }

    // Still empty? Leave metadata untouched (null stays null — no worse than before).
    if computed.trim().is_empty() {
        return;
    }

    // Cache the hit for subsequent requests. Lock poisoning is treated as a
    // correctness-preserving degrade (recompute next request) rather than a
    // panic, consistent with this subsystem's "optional feature" failure mode.
    if let Ok(mut guard) = cache.lock() {
        guard.put(key, computed.clone());
    }
    write_rendered_markdown(dto, computed);
}

/// Run a walker closure under `catch_unwind`. On panic, log a warning and
/// return empty string so the caller can fall through to the next tier.
fn run_walker_protected<F: FnOnce() -> String>(tier: &'static str, block_id: &str, walker: F) -> String {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(walker)) {
        Ok(s) => s,
        Err(_) => {
            tracing::warn!(
                block_id = %block_id,
                tier,
                "renderedMarkdown walker panicked — falling through"
            );
            String::new()
        }
    }
}

/// Hash a JSON value stably for cache keying. Uses the rendered JSON string
/// so that logically-equal values produce equal hashes across serde_json's
/// non-deterministic HashMap ordering. For a 10k-entry cache the collision
/// surface on u64 is negligible.
fn hash_json_value(value: &serde_json::Value) -> u64 {
    use std::hash::{Hash, Hasher};
    // to_string() uses BTreeMap-like deterministic ordering via serde_json's
    // object iteration order, which matches insertion order for Map<String,_>.
    // This is stable enough for cache keying (if a consumer mutates output
    // and we produce the same hash, they'd see stale cached markdown — but
    // Y.Doc Map iteration order is deterministic so this is fine in practice).
    let serialized = value.to_string();
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    serialized.hash(&mut hasher);
    hasher.finish()
}

/// Set `dto.metadata.renderedMarkdown` to `markdown`, creating the metadata
/// object if absent. Response-only mutation — no Y.Doc writes.
///
/// `BlockDto.metadata` is `Option<serde_json::Value>`, so it can theoretically
/// be a scalar or array. We normalize to an empty object in that case rather
/// than silently dropping the computed markdown.
fn write_rendered_markdown(dto: &mut BlockDto, markdown: String) {
    let metadata = dto
        .metadata
        .get_or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
    if !metadata.is_object() {
        *metadata = serde_json::Value::Object(serde_json::Map::new());
    }
    metadata
        .as_object_mut()
        .expect("metadata normalized to object above")
        .insert("renderedMarkdown".to_string(), serde_json::Value::String(markdown));
}

/// POST /api/v1/blocks - Create block
#[tracing::instrument(skip(state, req), fields(route_family = "blocks", handler = "create_block"), err)]
async fn create_block(
    State(state): State<AppState>,
    Json(req): Json<CreateBlockRequest>,
) -> Result<(StatusCode, Json<BlockDto>), ApiError> {
    let dto = crate::block_service::create_block(
        &state.store,
        &state.broadcaster,
        &state.hook_system,
        req,
    )?;
    Ok((StatusCode::CREATED, Json(dto)))
}

/// POST /api/v1/blocks/import - Identity-preserving block create for migration/curation.
///
/// Accepts a caller-supplied UUID. Distinct from the normal create endpoint so that
/// identity preservation is an explicit, auditable operation — not ambient behavior.
#[tracing::instrument(skip(state, req), fields(route_family = "blocks", handler = "import_block"), err)]
async fn import_block(
    State(state): State<AppState>,
    Json(req): Json<ImportBlockRequest>,
) -> Result<(StatusCode, Json<BlockDto>), ApiError> {
    let dto = crate::block_service::import_block(
        &state.store,
        &state.broadcaster,
        &state.hook_system,
        req,
    )?;
    Ok((StatusCode::CREATED, Json(dto)))
}

/// PUT /api/v1/blocks/:id - Not supported, suggest PATCH
///
/// Friendly error for kitty and other agents who try PUT instead of PATCH.
async fn put_not_supported(Path(id): Path<String>) -> (StatusCode, Json<ErrorResponse>) {
    (
        StatusCode::METHOD_NOT_ALLOWED,
        Json(ErrorResponse {
            error: format!(
                "PUT not supported. Did you mean PATCH? Use: PATCH /api/v1/blocks/{} with {{\042content\042: ..., \042parentId\042: ...}}",
                id
            ),
        }),
    )
}

/// PATCH /api/v1/blocks/:id - Update content, metadata, and/or parent
#[tracing::instrument(skip(state, req), fields(route_family = "blocks", handler = "update_block"), err)]
async fn update_block(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<UpdateBlockRequest>,
) -> Result<Json<BlockDto>, ApiError> {
    let dto = crate::block_service::update_block(
        &state.store,
        &state.broadcaster,
        &state.hook_system,
        &id,
        req,
    )?;
    Ok(Json(dto))
}

/// DELETE /api/v1/blocks/:id - Delete block and entire subtree
#[tracing::instrument(skip(state), fields(route_family = "blocks", handler = "delete_block"), err)]
async fn delete_block(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    crate::block_service::delete_block(
        &state.store,
        &state.broadcaster,
        &state.hook_system,
        &id,
    )?;
    Ok(StatusCode::NO_CONTENT)
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod projection_injection_tests {
    use super::*;
    use lru::LruCache;
    use serde_json::json;
    use std::num::NonZeroUsize;
    use std::sync::{Arc, Mutex};

    fn empty_cache() -> super::super::ProjectionCache {
        Arc::new(Mutex::new(LruCache::new(NonZeroUsize::new(10).unwrap())))
    }

    /// Extract `metadata.renderedMarkdown` from a DTO, or panic if absent.
    /// Keeps test assertions terse.
    fn rendered_md(dto: &BlockDto) -> String {
        dto.metadata
            .as_ref()
            .and_then(|m| m.get("renderedMarkdown"))
            .and_then(|v| v.as_str())
            .expect("renderedMarkdown should be set")
            .to_string()
    }

    fn door_dto_with_output(id: &str, output: serde_json::Value, metadata: Option<serde_json::Value>) -> BlockDto {
        BlockDto {
            id: id.to_string(),
            content: String::new(),
            parent_id: None,
            child_ids: vec![],
            collapsed: false,
            block_type: "text".to_string(),
            metadata,
            inherited_markers: None,
            created_at: 0,
            updated_at: 0,
            output_type: Some("door".to_string()),
            output: Some(output),
        }
    }

    fn minimal_spec_output() -> serde_json::Value {
        json!({
            "data": {
                "title": "Test Doc",
                "spec": {
                    "root": "r",
                    "elements": {
                        "r": { "type": "Text", "props": { "content": "hello" } }
                    }
                }
            }
        })
    }

    #[test]
    fn computes_markdown_when_metadata_null() {
        let cache = empty_cache();
        let mut dto = door_dto_with_output("b1", minimal_spec_output(), None);
        inject_rendered_markdown(&mut dto, &cache);
        let md = rendered_md(&dto);
        assert!(md.contains("Test Doc"), "should render title; got {:?}", md);
        assert!(md.contains("hello"), "should render text content");
    }

    #[test]
    fn leaves_existing_non_empty_markdown_alone() {
        let cache = empty_cache();
        let prior = "pre-existing markdown from hook";
        let mut dto = door_dto_with_output(
            "b2",
            minimal_spec_output(),
            Some(json!({ "renderedMarkdown": prior })),
        );
        inject_rendered_markdown(&mut dto, &cache);
        assert_eq!(rendered_md(&dto), prior, "should not overwrite hook markdown");
    }

    #[test]
    fn overwrites_empty_string_markdown() {
        // Empty string counts as "not populated" — fall through to walker.
        let cache = empty_cache();
        let mut dto = door_dto_with_output(
            "b3",
            minimal_spec_output(),
            Some(json!({ "renderedMarkdown": "" })),
        );
        inject_rendered_markdown(&mut dto, &cache);
        let md = rendered_md(&dto);
        assert!(!md.is_empty(), "empty-string markdown should be replaced");
        assert!(md.contains("Test Doc"));
    }

    #[test]
    fn skips_non_door_blocks() {
        let cache = empty_cache();
        let mut dto = door_dto_with_output("b4", minimal_spec_output(), None);
        dto.output_type = Some("eval-result".to_string());
        inject_rendered_markdown(&mut dto, &cache);
        assert!(
            dto.metadata.is_none()
                || dto
                    .metadata
                    .as_ref()
                    .unwrap()
                    .get("renderedMarkdown")
                    .is_none(),
            "non-door block should not get markdown injected"
        );
    }

    #[test]
    fn handles_door_block_with_no_output() {
        let cache = empty_cache();
        let mut dto = door_dto_with_output("b5", json!({}), None);
        dto.output = None;
        inject_rendered_markdown(&mut dto, &cache);
        // No output → nothing to compute → metadata stays untouched.
        assert!(dto.metadata.is_none());
    }

    #[test]
    fn handles_door_block_with_empty_output_data() {
        // Output present but data key missing → walker produces empty string →
        // metadata is left untouched (rather than set to "").
        let cache = empty_cache();
        let mut dto = door_dto_with_output("b6", json!({ "shell": true }), None);
        inject_rendered_markdown(&mut dto, &cache);
        assert!(
            dto.metadata.is_none(),
            "empty walker output should leave metadata untouched"
        );
    }

    #[test]
    fn cache_hit_returns_same_markdown() {
        let cache = empty_cache();
        let mut dto1 = door_dto_with_output("b7", minimal_spec_output(), None);
        inject_rendered_markdown(&mut dto1, &cache);

        let mut dto2 = door_dto_with_output("b7", minimal_spec_output(), None);
        inject_rendered_markdown(&mut dto2, &cache);

        assert_eq!(rendered_md(&dto1), rendered_md(&dto2), "cache hit should produce identical output");
        assert_eq!(cache.lock().unwrap().len(), 1, "single cache entry for matching id+hash");
    }

    #[test]
    fn output_mutation_invalidates_cache_via_hash() {
        let cache = empty_cache();
        let mut dto1 = door_dto_with_output("b8", minimal_spec_output(), None);
        inject_rendered_markdown(&mut dto1, &cache);

        let mutated = json!({
            "data": {
                "title": "Mutated Doc",
                "spec": {
                    "root": "r",
                    "elements": {
                        "r": { "type": "Text", "props": { "content": "different" } }
                    }
                }
            }
        });
        let mut dto2 = door_dto_with_output("b8", mutated, None);
        inject_rendered_markdown(&mut dto2, &cache);
        let md2 = rendered_md(&dto2);
        assert!(md2.contains("Mutated Doc"), "different output → different hash → recompute");
        assert!(md2.contains("different"));
        // Two distinct cache entries (same id, different hash).
        assert_eq!(cache.lock().unwrap().len(), 2);
    }
}
