//! Discovery handlers — markers, stats, daily note, presence, attachments.
//!
//! Also hosts the "semantic endpoints for outline conventions" track
//! ([[FLO-652]]): `POST /api/v1/pages/:name` (upsert) and
//! `POST /api/v1/daily/:date/append` — both hide the `pages::`-container
//! structural detail from API consumers so agents (ink-chat, Desktop
//! Daddy, future surfaces) don't have to rediscover outline layout rules
//! on every new tool.

use axum::{
    extract::{Path, Query, State},
    http::{header, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use yrs::{Map, ReadTxn, Transact};

use super::{ApiError, AppState, BlockContextQuery, BlockWithContextResponse};
use crate::api::{self, AncestorContext, BlockDto};
use crate::block_service::{lookup_inherited, read_block_child_ids, read_block_dto};
use floatty_core::hooks::page_name_index::page_title_from_content;
use floatty_core::hooks::parsing::parse_path_segments;
use floatty_core::projections::{match_exact, MatchCandidate};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/markers", get(list_marker_types))
        .route(
            "/api/v1/markers/:marker_type/values",
            get(list_marker_values),
        )
        .route("/api/v1/stats", get(get_block_stats))
        .route("/api/v1/presence", get(get_presence).post(post_presence))
        .route("/api/v1/daily/:date", get(get_daily_note))
        .route("/api/v1/daily/:date/append", post(append_to_daily_note))
        .route("/api/v1/pages/:name", post(upsert_page))
        .route("/api/v1/path", post(path_write))
        .route("/api/v1/attachments/:filename", get(get_attachment))
}

// ============================================================================
// DTOs
// ============================================================================

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PresenceRequest {
    block_id: String,
    pane_id: Option<String>,
}

/// Presence response, struct-ified ([[FLO-680]]).
///
/// Replaces the inline `serde_json::json!` literal previously emitted by
/// `get_presence`. Adds `ancestorContext` so a single GET orients an agent
/// on the user's currently-focused block (page identity, ancestor chain,
/// effective markers when opted-in, inbound count) without a follow-up
/// `floatty_block_get` call.
///
/// `ancestorContext.effectiveMarkers` and `ancestorContext.inboundSamples`
/// are opt-in via `?include=effective_markers,inbound_samples`. Cheap fields
/// are always-on per the resolved open-question.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PresenceResponse {
    pub block_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pane_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ancestor_context: Option<AncestorContext>,
}

/// Query parameters for `GET /api/v1/presence` — mirrors `BlockContextQuery`'s
/// `?include=` and `&inbound_sample_count=N` knobs so presence behaves the
/// same way as `/blocks/:id` for the AncestorContext opt-in surface.
#[derive(Deserialize, Debug, Default)]
pub struct PresenceQuery {
    #[serde(default)]
    pub include: Option<String>,
    #[serde(default)]
    pub inbound_sample_count: Option<usize>,
}

/// Body for `POST /api/v1/daily/:date/append` — append a child block to the
/// specified daily note (auto-creates the daily note page if missing).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DailyAppendRequest {
    content: String,
}

/// Body for `POST /api/v1/pages/:name` — upsert a page by name. Body is
/// currently empty-shaped; kept as a struct so we can extend with optional
/// initial content without breaking the wire contract later.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpsertPageRequest {}

/// Body for `POST /api/v1/path` — mkdir-p path-addressed write ([[FLO-796]],
/// ADR-008 D6). `path` is a `>`-delimited address (ADR-008 D1 grammar; see
/// [`parse_path_segments`]); `content` is the block content written under the
/// resolved leaf segment.
///
/// The request shape deliberately leaves room for a second payload kind — a
/// reference to an attachment slug (ADR-008 D6, P3 object store) — rather than
/// encoding the payload kind into the path grammar. v1 ships block-content only.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PathWriteRequest {
    path: String,
    content: String,
}

/// Response for `POST /api/v1/path`.
///
/// `block` is the created content block, shaped exactly like `/blocks/:id`
/// (always-on `ancestorContext`) via [`read_page_dto`]. `chain` is the
/// resolved/created path-segment block ids, rootmost-first (page → … → leaf
/// segment) — the mkdir-p'd spine, so a caller can address any intermediate
/// directly without a follow-up walk.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
struct PathWriteResponse {
    block: BlockDto,
    chain: Vec<String>,
}

// ============================================================================
// Handlers
// ============================================================================

async fn list_marker_types(
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let types = state.store.enumerate_marker_types();
    let items: Vec<serde_json::Value> = types
        .into_iter()
        .map(|(marker_type, count)| serde_json::json!({ "type": marker_type, "count": count }))
        .collect();
    Ok(Json(
        serde_json::json!({ "markers": items, "total": items.len() }),
    ))
}

async fn list_marker_values(
    State(state): State<AppState>,
    Path(marker_type): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let values = state.store.enumerate_marker_values(&marker_type);
    let items: Vec<serde_json::Value> = values
        .into_iter()
        .map(|(value, count)| serde_json::json!({ "value": value, "count": count }))
        .collect();
    Ok(Json(serde_json::json!({
        "markerType": marker_type,
        "values": items,
        "total": items.len()
    })))
}

async fn get_block_stats(
    State(state): State<AppState>,
) -> Result<Json<floatty_core::store::BlockStats>, ApiError> {
    Ok(Json(state.store.get_stats()))
}

#[tracing::instrument(
    skip(state),
    fields(route_family = "discovery", handler = "get_daily_note"),
    err
)]
async fn get_daily_note(
    State(state): State<AppState>,
    Path(date): Path<String>,
    axum::extract::Query(mut ctx_query): axum::extract::Query<BlockContextQuery>,
) -> Result<Json<BlockWithContextResponse>, ApiError> {
    let page_block_id = {
        let page_index = state
            .page_name_index
            .read()
            .map_err(|_| ApiError::LockPoisoned)?;
        page_index.page_block_id(&date).map(String::from)
    };

    let page_id =
        page_block_id.ok_or_else(|| ApiError::NotFound(format!("Page not found: {}", date)))?;

    if ctx_query
        .include
        .as_deref()
        .is_none_or(|s| s.trim().is_empty())
    {
        ctx_query.include = Some("children".to_string());
    }

    let doc = state.store.doc();
    let doc_guard = doc.read().map_err(|_| ApiError::LockPoisoned)?;
    let txn = doc_guard.transact();

    let blocks_map = txn
        .get_map("blocks")
        .ok_or_else(|| ApiError::NotFound("blocks map not found".to_string()))?;

    let value = blocks_map
        .get(&txn, &page_id)
        .ok_or_else(|| ApiError::NotFound(page_id.clone()))?;

    if let yrs::Out::YMap(block_map) = value {
        // Single inheritance_index read guard for lookup_inherited +
        // attach_ancestor_context (Fix 6 in the simplify pass).
        let inh = state
            .inheritance_index
            .read()
            .map_err(|_| ApiError::LockPoisoned)?;
        let inherited_markers = lookup_inherited(&inh, &page_id);
        let mut block_dto = read_block_dto(&block_map, &txn, &page_id, inherited_markers, true);

        // AncestorContext on daily-note response (singleton path —
        // effective_markers always-on).
        let pni = state
            .page_name_index
            .read()
            .map_err(|_| ApiError::LockPoisoned)?;
        let opts =
            crate::block_service::AncestorContextOpts::from_query(&ctx_query).always_effective();
        crate::block_service::attach_ancestor_context(
            &mut block_dto,
            &blocks_map,
            &txn,
            Some(&inh),
            Some(&pni),
            opts,
        );

        Ok(Json(crate::block_service::build_block_context_response(
            &blocks_map,
            &txn,
            &page_id,
            block_dto,
            &ctx_query,
        )))
    } else {
        Err(ApiError::NotFound(page_id))
    }
}

async fn get_presence(
    State(state): State<AppState>,
    Query(query): Query<PresenceQuery>,
) -> impl IntoResponse {
    let Some(info) = state.broadcaster.get_last_presence() else {
        return StatusCode::NO_CONTENT.into_response();
    };

    let doc = state.store.doc();
    let Ok(doc_guard) = doc.read() else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    let txn = doc_guard.transact();
    let Some(blocks_map) = txn.get_map("blocks") else {
        return StatusCode::NO_CONTENT.into_response();
    };
    let block_exists = blocks_map.get(&txn, &info.block_id).is_some();
    if !block_exists {
        return StatusCode::NO_CONTENT.into_response();
    }

    // Shape the AncestorContext for the focused block. Cheap fields
    // always-on; effective_markers + inbound_samples gated by `?include=`.
    // Reads the block's metadata directly — compute_ancestor_context now
    // takes `Option<&serde_json::Value>` rather than a full DTO scaffold.
    //
    // Lock-poisoning policy: presence is poll-based (every ~2s) and used
    // as an orientation hint, so we degrade to "no ancestor_context" rather
    // than failing the whole presence call. `tracing::warn!` makes the
    // degradation visible (Pattern 5 — silent degradation prohibited; the
    // sibling `doc.read()` failure above ALREADY returns 500, so a true
    // poisoned-lock state will surface there too — this branch only fires
    // when `doc` is healthy but one of the index locks is poisoned).
    let ancestor_context = (|| -> Option<AncestorContext> {
        let inh = match state.inheritance_index.read() {
            Ok(g) => g,
            Err(e) => {
                tracing::warn!(
                    block_id = %info.block_id,
                    error = %e,
                    "InheritanceIndex lock poisoned during presence — \
                     ancestorContext.effectiveMarkers will be empty"
                );
                return None;
            }
        };
        let pni = match state.page_name_index.read() {
            Ok(g) => g,
            Err(e) => {
                tracing::warn!(
                    block_id = %info.block_id,
                    error = %e,
                    "PageNameIndex lock poisoned during presence — \
                     ancestorContext.nearestPage* + inboundCount will be empty"
                );
                return None;
            }
        };
        let block_map = match blocks_map.get(&txn, &info.block_id)? {
            yrs::Out::YMap(m) => m,
            _ => return None,
        };
        let metadata = block_map
            .get(&txn, "metadata")
            .and_then(|m| crate::api::extract_metadata_from_yrs(m, &txn));
        let includes = crate::block_service::parse_includes(&query.include);
        let opts = crate::block_service::AncestorContextOpts::from_raw(
            &includes,
            query.inbound_sample_count.unwrap_or(5),
        );
        crate::block_service::compute_ancestor_context(
            &blocks_map,
            &txn,
            &info.block_id,
            metadata.as_ref(),
            Some(&inh),
            Some(&pni),
            opts,
        )
    })();

    Json(PresenceResponse {
        block_id: info.block_id,
        pane_id: info.pane_id,
        ancestor_context,
    })
    .into_response()
}

async fn post_presence(
    State(state): State<AppState>,
    Json(req): Json<PresenceRequest>,
) -> StatusCode {
    state
        .broadcaster
        .broadcast_presence(req.block_id, req.pane_id);
    StatusCode::OK
}

async fn get_attachment(Path(filename): Path<String>) -> Result<impl IntoResponse, ApiError> {
    if filename.contains('/') || filename.contains('\\') || filename.contains("..") {
        return Err(ApiError::InvalidRequest("Invalid filename".to_string()));
    }

    let attachments_dir = crate::config::data_dir().join("__attachments");
    let _ = tokio::fs::create_dir_all(&attachments_dir).await;

    let file_path = attachments_dir.join(&filename);
    let bytes = tokio::fs::read(&file_path)
        .await
        .map_err(|_| ApiError::NotFound(format!("Attachment not found: {}", filename)))?;

    let content_type: &'static str = match file_path.extension().and_then(|e| e.to_str()) {
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("png") => "image/png",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        Some("mp4") => "video/mp4",
        Some("webm") => "video/webm",
        Some("pdf") => "application/pdf",
        Some("html") | Some("htm") => "text/html",
        _ => "application/octet-stream",
    };

    // Attachments are immutable — a filename always maps to the same bytes (a new
    // image gets a new filename) — so a 1-year `immutable` Cache-Control lets the
    // WKWebView HTTP cache hold them. The client-side LRU (attachmentCache.ts) is
    // the deterministic layer; this header is the good-HTTP-citizen complement.
    // `private` (not `public`): this route is behind `auth::auth_middleware`, so
    // the bytes are authenticated — only the requesting browser may cache them,
    // never a shared/intermediary cache.
    let mut headers = header::HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        header::HeaderValue::from_static(content_type),
    );
    headers.insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("private, max-age=31536000, immutable"),
    );

    // Weak validator from mtime + length, so an evicted cache can revalidate with
    // a 304 instead of re-downloading. Best-effort: skip if metadata is missing.
    if let Ok(meta) = tokio::fs::metadata(&file_path).await {
        let mtime_secs = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        // Weak validator (W/): mtime+len can collide if bytes are ever replaced
        // in-place, so it must not be advertised as a strong validator.
        if let Ok(etag) =
            header::HeaderValue::from_str(&format!("W/\"{}-{}\"", mtime_secs, bytes.len()))
        {
            headers.insert(header::ETAG, etag);
        }
    }

    Ok((StatusCode::OK, headers, bytes))
}

// ============================================================================
// Semantic endpoints — FLO-652 ("agents shouldn't need to know pages:: layout")
// ============================================================================

/// Serialisation + hook-lag bridge for the semantic endpoints.
///
/// Why: `PageNameIndex` is updated asynchronously by a hook that fires AFTER
/// `create_block` returns. Two back-to-back POSTs for the same missing page
/// name can both observe `None` from the index and both call `create_block`,
/// producing duplicate `# {name}` pages (Greptile P1 on PR #249).
///
/// The `Mutex<SemanticCache>` in `AppState.semantic_cache` solves this:
///
/// 1. **Serialisation** — taking the mutex across the whole `find_or_create_page`
///    body makes the check-then-create pair atomic with respect to other
///    concurrent calls.
/// 2. **Hook-lag bridge** — once we've created a page or the `pages::`
///    container inside the critical section, we remember it here. Later
///    callers inside the critical section find it even before the async hook
///    has updated the `PageNameIndex`.
///
/// Entries are never evicted — single-user system, bounded in practice
/// (~hundreds of pages). Lives for the lifetime of the `AppState`
/// (per-instance, test-isolated).
pub struct SemanticCache {
    pages_container_id: Option<String>,
    /// Lowercased page name → block id, populated on create.
    pages: HashMap<String, String>,
}

impl SemanticCache {
    pub fn new() -> Self {
        Self {
            pages_container_id: None,
            pages: HashMap::new(),
        }
    }
}

impl Default for SemanticCache {
    fn default() -> Self {
        Self::new()
    }
}

/// Resolve a page name to an existing block id, creating the page (and the
/// `pages::` container if needed) when absent.
///
/// Returns `(block_id, existed_before_this_call)`. The `existed` bool drives
/// the `200 OK` vs `201 Created` status code in `upsert_page` — caller must
/// not second-guess it via an extra index read (which would race).
///
/// The page content uses the canonical `# ${name}` heading form so it renders
/// correctly when zoomed. This mirrors `createPage` in the frontend's
/// `useBacklinkNavigation.ts` — same content shape, same parent chain.
fn find_or_create_page(state: &AppState, name: &str) -> Result<(String, bool), ApiError> {
    // Serialise all find_or_create_page calls so check-then-create is atomic.
    // The guard is held across the full body (in find_or_create_page_locked),
    // including the `create_block` calls — those touch the Y.Doc write lock and
    // the hook system, neither of which is held at this point, so no deadlock.
    // The async hook that updates `PageNameIndex` runs AFTER we release it.
    let mut cache = state
        .semantic_cache
        .lock()
        .map_err(|_| ApiError::LockPoisoned)?;
    find_or_create_page_locked(state, &mut cache, name)
}

/// Lock-held inner of [`find_or_create_page`]: identical find-or-create logic,
/// but the caller supplies the already-acquired `SemanticCache` guard rather
/// than locking here.
///
/// Split out so [`path_write`] can hold ONE semantic-cache critical section
/// across its ENTIRE multi-segment walk (FINDING 1 — two concurrent path
/// writes sharing a prefix could otherwise both check-then-create the same
/// intermediate, duplicating it and stranding one writer's children).
/// `std::sync::Mutex` is non-reentrant, so the walk threads the guard through
/// here rather than re-locking (which would deadlock).
fn find_or_create_page_locked(
    state: &AppState,
    cache: &mut SemanticCache,
    name: &str,
) -> Result<(String, bool), ApiError> {
    let name_key = name.to_lowercase();

    // Fast path 1: PageNameIndex (hook-populated). Primary authority once the
    // hook has caught up.
    {
        let index = state
            .page_name_index
            .read()
            .map_err(|_| ApiError::LockPoisoned)?;
        if let Some(id) = index.page_block_id(name) {
            return Ok((id.to_string(), true));
        }
    }

    // Fast path 2: pages we created earlier in this server's lifetime but
    // whose index entry hasn't landed yet.
    if let Some(id) = cache.pages.get(&name_key) {
        return Ok((id.clone(), true));
    }

    // Resolve the pages:: container — PageNameIndex first, cache fallback
    // for the same hook-lag reason.
    let pages_container_id = {
        let index = state
            .page_name_index
            .read()
            .map_err(|_| ApiError::LockPoisoned)?;
        index.pages_container_id().map(String::from)
    };

    // Slow path: scan the container's children directly in the Y.Doc. Closes
    // the hook-lag window for pages created by paths that populate NEITHER
    // the index (async hook hasn't landed) NOR this server's semantic cache
    // (frontend wikilink-click creation, raw POST /blocks) — previously those
    // raced this endpoint into duplicate pages (quirk-audit cluster F).
    if let Some(ref container_id) = pages_container_id {
        if let Some(id) = scan_pages_container_for_name(state, container_id, &name_key)? {
            cache.pages.insert(name_key, id.clone());
            return Ok((id, true));
        }
    }

    let pages_container_id = match pages_container_id {
        Some(id) => id,
        None => match cache.pages_container_id.clone() {
            Some(id) => id,
            None => {
                let container = crate::block_service::create_block(
                    &state.store,
                    &state.broadcaster,
                    &state.hook_system,
                    api::CreateBlockRequest {
                        content: "pages::".to_string(),
                        parent_id: None,
                        after_id: None,
                        at_index: None,
                        ..Default::default()
                    },
                )?;
                cache.pages_container_id = Some(container.id.clone());
                container.id
            }
        },
    };

    // Create the page block under the pages:: container.
    let page = crate::block_service::create_block(
        &state.store,
        &state.broadcaster,
        &state.hook_system,
        api::CreateBlockRequest {
            content: format!("# {}", name),
            parent_id: Some(pages_container_id),
            after_id: None,
            at_index: None,
            ..Default::default()
        },
    )?;

    cache.pages.insert(name_key, page.id.clone());
    Ok((page.id, false))
}

/// Scan the `pages::` container's children directly in the Y.Doc for a page
/// whose extracted title matches `name_key` (lowercased, trimmed).
///
/// Uses `page_title_from_content` so the comparison is EXACTLY how the
/// PageNameIndex extracts names — any divergence here recreates the
/// collision-check bypass this closes.
///
/// `pub(crate)` so `GET /api/v1/resolve` (`api::resolve`) can reuse this same
/// scan as its page-resolution fallback tier (FINDING 3 — resolve otherwise
/// 404s on a just-created page during the async PageNameIndex hook-lag window).
/// `name_key` must be the lowercased (and typically trimmed) page name, matching
/// how `find_or_create_page_locked` builds it.
pub(crate) fn scan_pages_container_for_name(
    state: &AppState,
    container_id: &str,
    name_key: &str,
) -> Result<Option<String>, ApiError> {
    let doc = state.store.doc();
    let doc_guard = doc.read().map_err(|_| ApiError::LockPoisoned)?;
    let txn = doc_guard.transact();

    let Some(blocks_map) = txn.get_map("blocks") else {
        return Ok(None);
    };

    // Oldest-createdAt wins among matches — the SAME tie-break the
    // PageNameIndex applies. Returning the first childIds match could cache
    // a newer twin during the hook-lag window and diverge from the index's
    // eventual resolution.
    let mut oldest: Option<(String, i64)> = None;
    for child_id in read_block_child_ids(&blocks_map, &txn, container_id) {
        let Some(yrs::Out::YMap(child_map)) = blocks_map.get(&txn, &child_id) else {
            continue;
        };
        let content = match child_map.get(&txn, "content") {
            Some(yrs::Out::Any(yrs::Any::String(s))) => s.to_string(),
            _ => continue,
        };
        if page_title_from_content(&content).to_lowercase() != name_key {
            continue;
        }
        // i64::MAX when unknown (extract_timestamp yields 0 for missing —
        // FLO-684 treats 0 as "no timestamp") — an unknown-age match never
        // beats a known one (mirrors ExistingPageEntry semantics).
        let created_at =
            match crate::block_service::extract_timestamp(child_map.get(&txn, "createdAt")) {
                0 => i64::MAX,
                ts => ts,
            };
        match oldest {
            Some((_, best)) if created_at >= best => {}
            _ => oldest = Some((child_id, created_at)),
        }
    }

    Ok(oldest.map(|(id, _)| id))
}

/// Read a page block as a `BlockDto` for returning from the upsert handler.
/// Scoped to this module — the full `get_block` in `block_service` builds a
/// context response (ancestors, siblings, etc.) that we don't need here.
///
/// The returned BlockDto carries `ancestorContext` (always-on for singleton
/// paths, mirrors `/blocks/:id`). For a freshly-upserted page the ancestor
/// chain is just the `pages::` container; for an existing page the chain
/// reflects whatever the outline has materialised.
fn read_page_dto(state: &AppState, id: &str) -> Result<BlockDto, ApiError> {
    let doc = state.store.doc();
    let doc_guard = doc.read().map_err(|_| ApiError::LockPoisoned)?;
    let txn = doc_guard.transact();

    let blocks_map = txn
        .get_map("blocks")
        .ok_or_else(|| ApiError::NotFound("blocks map not found".to_string()))?;

    let value = blocks_map
        .get(&txn, id)
        .ok_or_else(|| ApiError::NotFound(id.to_string()))?;

    if let yrs::Out::YMap(block_map) = value {
        // Single inheritance_index read guard for lookup_inherited +
        // attach_ancestor_context (Fix 6 in the simplify pass).
        let inh = state
            .inheritance_index
            .read()
            .map_err(|_| ApiError::LockPoisoned)?;
        let inherited_markers = lookup_inherited(&inh, id);
        let mut dto = read_block_dto(&block_map, &txn, id, inherited_markers, true);

        // Always-on AncestorContext on the upsert response.
        let pni = state
            .page_name_index
            .read()
            .map_err(|_| ApiError::LockPoisoned)?;
        let opts = crate::block_service::AncestorContextOpts::default().always_effective();
        crate::block_service::attach_ancestor_context(
            &mut dto,
            &blocks_map,
            &txn,
            Some(&inh),
            Some(&pni),
            opts,
        );

        Ok(dto)
    } else {
        Err(ApiError::NotFound(id.to_string()))
    }
}

/// `POST /api/v1/pages/:name` — upsert a page under the `pages::` container.
///
/// Idempotent: returns the existing page when one matches the name
/// (case-insensitive, via PageNameIndex). Creates a new page and the
/// `pages::` container (if absent) otherwise.
///
/// Responses:
/// - `200 OK` when the page already existed
/// - `201 Created` when the page was freshly created
#[tracing::instrument(
    skip(state, _req),
    fields(route_family = "semantic", handler = "upsert_page"),
    err
)]
async fn upsert_page(
    State(state): State<AppState>,
    Path(name): Path<String>,
    Json(_req): Json<UpsertPageRequest>,
) -> Result<(StatusCode, Json<BlockDto>), ApiError> {
    // Normalize ONCE at the boundary: the index registers TRIMMED titles
    // (page_title_from_content trims), so an untrimmed name here would bypass
    // the collision check, create `# {name-with-edges}`, and then hijack the
    // index entry when the hook lands (quirk-audit cluster F).
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err(ApiError::InvalidRequest(
            "Page name cannot be empty".to_string(),
        ));
    }

    // Single atomic resolve — find_or_create_page holds the semantic lock
    // across the existence check AND any creation, so `existed` is never
    // out of sync with the returned id.
    let (page_id, existed) = find_or_create_page(&state, &name)?;
    let dto = read_page_dto(&state, &page_id)?;
    let status = if existed {
        StatusCode::OK
    } else {
        StatusCode::CREATED
    };
    Ok((status, Json(dto)))
}

/// `POST /api/v1/daily/:date/append` — append a child block under the
/// specified daily note. The daily note (and `pages::` container) are
/// autocreated when missing — same ergonomic contract as typing
/// `[[YYYY-MM-DD]]` in the frontend.
///
/// Responses:
/// - `201 Created` with the new child's `BlockDto`
///
/// Validate that `:date` matches the canonical `YYYY-MM-DD` shape. Required
/// to keep daily notes addressable by the `GET /api/v1/daily/:date` sibling —
/// a typo like `/daily/26-4-19/append` would otherwise silently create a
/// malformed orphan page. Only the shape is validated; any `YYYY-MM-DD` that
/// matches is accepted (leap-day calendar checks are out of scope).
fn is_valid_date_shape(date: &str) -> bool {
    let bytes = date.as_bytes();
    if bytes.len() != 10 {
        return false;
    }
    let is_digit = |b: u8| b.is_ascii_digit();
    is_digit(bytes[0])
        && is_digit(bytes[1])
        && is_digit(bytes[2])
        && is_digit(bytes[3])
        && bytes[4] == b'-'
        && is_digit(bytes[5])
        && is_digit(bytes[6])
        && bytes[7] == b'-'
        && is_digit(bytes[8])
        && is_digit(bytes[9])
}

#[tracing::instrument(
    skip(state, req),
    fields(route_family = "semantic", handler = "append_to_daily_note"),
    err
)]
async fn append_to_daily_note(
    State(state): State<AppState>,
    Path(date): Path<String>,
    Json(req): Json<DailyAppendRequest>,
) -> Result<(StatusCode, Json<BlockDto>), ApiError> {
    if !is_valid_date_shape(&date) {
        return Err(ApiError::InvalidRequest(format!(
            "Date must be YYYY-MM-DD (got '{}') — mis-shaped dates would create unreachable pages that GET /api/v1/daily/:date cannot resolve",
            date
        )));
    }
    if req.content.trim().is_empty() {
        return Err(ApiError::InvalidRequest(
            "Content cannot be empty — appending an empty block under a daily note is almost never the intent".to_string(),
        ));
    }

    let (daily_id, _existed) = find_or_create_page(&state, &date)?;

    let mut dto = crate::block_service::create_block(
        &state.store,
        &state.broadcaster,
        &state.hook_system,
        api::CreateBlockRequest {
            content: req.content,
            parent_id: Some(daily_id),
            after_id: None,
            at_index: None,
            ..Default::default()
        },
    )?;

    // Attach AncestorContext to the newly-created child (always-on for
    // singleton paths). The hook system is async so the PageNameIndex /
    // InheritanceIndex lookups reflect at-call-time state — for a fresh
    // append under an existing daily note, the daily note is already in
    // PageNameIndex so nearestPage* populates correctly.
    let block_id_for_attach = dto.id.clone();
    {
        let doc = state.store.doc();
        let doc_guard = doc.read().map_err(|_| ApiError::LockPoisoned)?;
        let txn = doc_guard.transact();
        let blocks_map = txn
            .get_map("blocks")
            .ok_or_else(|| ApiError::NotFound("blocks map not found".to_string()))?;
        if blocks_map.get(&txn, &block_id_for_attach).is_some() {
            let inh = state
                .inheritance_index
                .read()
                .map_err(|_| ApiError::LockPoisoned)?;
            let pni = state
                .page_name_index
                .read()
                .map_err(|_| ApiError::LockPoisoned)?;
            let opts = crate::block_service::AncestorContextOpts::default().always_effective();
            crate::block_service::attach_ancestor_context(
                &mut dto,
                &blocks_map,
                &txn,
                Some(&inh),
                Some(&pni),
                opts,
            );
        }
    }

    Ok((StatusCode::CREATED, Json(dto)))
}

// ============================================================================
// Path-addressed writes — FLO-796 (mkdir-p), ADR-008 D2/D6/D7
// ============================================================================

/// Does `path` carry a top-level (`[[`/`]]` depth 0) whitespace-delimited `>`
/// — a would-be path separator? Mirrors the separator condition in
/// [`parse_path_segments`] (previous char whitespace, next char
/// whitespace-or-end-of-string), used ONLY as the malformed-path reject
/// signal in [`path_write`].
///
/// A single opaque segment that carries such a separator means the tokenizer
/// found a would-be split but bailed (empty segment, e.g. `a >  > b`) — reject
/// rather than create a page literally titled with the broken string. A `>`
/// inside brackets or without surrounding whitespace (`Vec<String>`, `a>b`) is
/// NOT a separator, so those stay legitimate single-page addresses (ADR-008 D1).
fn has_top_level_separator(path: &str) -> bool {
    let bytes = path.as_bytes();
    let len = bytes.len();
    let mut depth: i32 = 0;
    let mut i = 0usize;
    while i < len {
        if i + 1 < len && bytes[i] == b'[' && bytes[i + 1] == b'[' {
            depth += 1;
            i += 2;
            continue;
        }
        if i + 1 < len && bytes[i] == b']' && bytes[i + 1] == b']' {
            depth -= 1;
            i += 2;
            continue;
        }
        if depth == 0 && bytes[i] == b'>' {
            // `>` is ASCII so `i` is a char boundary — decode adjacent chars.
            let prev_is_ws = path[..i]
                .chars()
                .next_back()
                .is_some_and(char::is_whitespace);
            let next_is_ws_or_end = path[i + 1..].chars().next().is_none_or(char::is_whitespace);
            if prev_is_ws && next_is_ws_or_end {
                return true;
            }
        }
        i += 1;
    }
    false
}

/// Read the direct children of `parent_id` as `(id, content, created_at)`
/// tuples for building [`MatchCandidate`]s. Skips children with no string
/// content (mirrors `scan_pages_container_for_name`). `created_at` follows the
/// `extract_timestamp` convention (0 when missing → the matcher treats it as
/// `i64::MAX`, "unknown age never steals").
fn read_child_candidates(
    state: &AppState,
    parent_id: &str,
) -> Result<Vec<(String, String, i64)>, ApiError> {
    let doc = state.store.doc();
    let doc_guard = doc.read().map_err(|_| ApiError::LockPoisoned)?;
    let txn = doc_guard.transact();
    let Some(blocks_map) = txn.get_map("blocks") else {
        return Ok(Vec::new());
    };
    let child_ids = read_block_child_ids(&blocks_map, &txn, parent_id);
    let mut out = Vec::with_capacity(child_ids.len());
    for child_id in child_ids {
        let Some(yrs::Out::YMap(child_map)) = blocks_map.get(&txn, &child_id) else {
            continue;
        };
        let content = match child_map.get(&txn, "content") {
            Some(yrs::Out::Any(yrs::Any::String(s))) => s.to_string(),
            _ => continue,
        };
        let created_at = crate::block_service::extract_timestamp(child_map.get(&txn, "createdAt"));
        out.push((child_id, content, created_at));
    }
    Ok(out)
}

/// EXACT direct-child find-or-create for one path segment (ADR-008 D2 — the
/// write predicate is [`match_exact`]: exact-canonicalized, direct-child only,
/// no level-skipping; oldest-createdAt wins among duplicate siblings).
///
/// On a hit among `parent_id`'s DIRECT children, return the matched child id
/// (descend). On a miss, create a direct child whose content is the segment
/// text AS-WRITTEN (raw case preserved — canonicalization is for matching
/// only) and return the new id.
///
/// Reads children of the KNOWN `parent_id` directly from the Y.Doc — never by
/// name — so a block created earlier in the same walk (invisible to the async
/// PageNameIndex hook) is still found on the next segment's read.
fn find_or_create_direct_child(
    state: &AppState,
    parent_id: &str,
    segment: &str,
) -> Result<String, ApiError> {
    let candidates_data = read_child_candidates(state, parent_id)?;
    let candidates: Vec<MatchCandidate> = candidates_data
        .iter()
        .map(|(_, content, created_at)| MatchCandidate {
            content,
            created_at: *created_at,
        })
        .collect();

    if let Some(idx) = match_exact(segment, &candidates) {
        return Ok(candidates_data[idx].0.clone());
    }

    let child = crate::block_service::create_block(
        &state.store,
        &state.broadcaster,
        &state.hook_system,
        api::CreateBlockRequest {
            content: segment.to_string(),
            parent_id: Some(parent_id.to_string()),
            after_id: None,
            at_index: None,
            ..Default::default()
        },
    )?;
    Ok(child.id)
}

/// `POST /api/v1/path` — mkdir-p path-addressed write ([[FLO-796]], ADR-008
/// D2/D6/D7).
///
/// Writes `content` to a block under the location addressed by `path`,
/// creating every missing intermediate along the way (`mkdir -p`). Path
/// grammar is ADR-008 D1 ([`parse_path_segments`]); the write matcher is
/// EXACT-only, direct-child, no level-skipping (D2 — [`match_exact`]).
///
/// Segment 1 is always a page: reuses `find_or_create_page`'s logic. Each
/// subsequent segment is a direct child of the previous block via
/// [`find_or_create_direct_child`]. Finally a child carrying `content` is
/// created under the leaf segment.
///
/// **Concurrency (FINDING 1):** the ENTIRE segment walk runs inside ONE
/// `SemanticCache` critical section. The guard is acquired once and held
/// across segment 1 ([`find_or_create_page_locked`]), every intermediate
/// ([`find_or_create_direct_child`], which does not itself touch the cache),
/// and the leaf create — so two concurrent path writes sharing a prefix cannot
/// both check-then-create the same intermediate (which would duplicate it and
/// strand one writer's children). The guard is threaded into
/// `find_or_create_page_locked` rather than re-locked (`std::sync::Mutex` is
/// non-reentrant — re-locking would deadlock).
///
/// **ID-threading (the load-bearing mechanism):** the resolved/created ids are
/// threaded DIRECTLY through the walk. A just-created block is NOT index-visible
/// (the PageNameIndex hook is async), so re-looking-up by name mid-walk would
/// miss it. Each step reads children of a KNOWN parent id, never by name — only
/// segment 1's container resolution goes through the index, which is
/// [`find_or_create_page`]'s job.
///
/// Per ADR-008 D7: N separate transactions, N WS broadcasts, no batch
/// machinery — the operation is idempotent (exact find-or-create per segment),
/// so a re-POST of the same path creates zero new intermediates.
///
/// Responses:
/// - `201 Created` with the content block's `BlockDto` + the segment chain.
/// - `400 Bad Request` for: empty/whitespace `path` or `content`; a path that
///   parses OPAQUE while carrying a would-be `>` separator (malformed
///   multi-segment — reject rather than create a page literally named
///   "a >  > b").
#[tracing::instrument(
    skip(state, req),
    fields(route_family = "semantic", handler = "path_write"),
    err
)]
async fn path_write(
    State(state): State<AppState>,
    Json(req): Json<PathWriteRequest>,
) -> Result<(StatusCode, Json<PathWriteResponse>), ApiError> {
    let path = req.path.trim().to_string();
    if path.is_empty() {
        return Err(ApiError::InvalidRequest("Path cannot be empty".to_string()));
    }
    if req.content.trim().is_empty() {
        return Err(ApiError::InvalidRequest(
            "Content cannot be empty — writing an empty block to a path is almost never the intent"
                .to_string(),
        ));
    }

    let segments = parse_path_segments(&path);

    // Malformed multi-segment guard: the tokenizer returns a single opaque
    // segment both for a no-separator name (`Vec<String>`, `a>b` — legitimate)
    // AND for a would-be path whose separators produced an empty segment
    // (`a >  > b`, `a >`). Only the latter carries a top-level whitespace-
    // delimited `>` — reject it rather than create a page literally titled with
    // the whole broken string.
    if segments.len() == 1 && has_top_level_separator(&path) {
        return Err(ApiError::InvalidRequest(format!(
            "Malformed path '{}': looks multi-segment (whitespace-delimited '>') but parsed to a single opaque segment (empty segment or unbalanced '[[')",
            path
        )));
    }

    // FINDING 1 — acquire the SemanticCache mutex ONCE and hold it across the
    // segment walk (segment 1 + every intermediate). This serialises
    // concurrent path writes: two writes sharing a prefix can no longer both
    // check-then-create the same intermediate. The guard is threaded into
    // find_or_create_page_locked (std Mutex is non-reentrant);
    // find_or_create_direct_child does not touch the cache, so holding the
    // guard across its calls is what serialises segments 2..N's
    // check-then-create. The leaf create + read_page_dto run OUTSIDE this
    // section — the leaf is an unconditional append (no check-then-create),
    // so it needs no serialisation and would only extend contention on a
    // mutex shared with upsert_page/append_to_daily_note.
    let (leaf_parent_id, chain) = {
        let mut cache = state
            .semantic_cache
            .lock()
            .map_err(|_| ApiError::LockPoisoned)?;

        // Segment 1 is always a page — reuse the FLO-652 find-or-create under
        // the held guard. Thread its id forward; never re-resolve by name.
        let (mut current_id, _existed) =
            find_or_create_page_locked(&state, &mut cache, &segments[0])?;
        let mut chain: Vec<String> = Vec::with_capacity(segments.len());
        chain.push(current_id.clone());

        // Segments 2..N: EXACT direct-child find-or-create against the KNOWN
        // parent's children (synchronous create writes are visible immediately;
        // no index/name lookup, so a just-created intermediate is found on the
        // next segment's read — the ID-threading mechanism).
        for segment in &segments[1..] {
            current_id = find_or_create_direct_child(&state, &current_id, segment)?;
            chain.push(current_id.clone());
        }

        (current_id, chain)
    };

    // Leaf: the actual content block under the resolved/created path spine —
    // outside the critical section (unconditional append, id-threaded parent).
    let content_block = crate::block_service::create_block(
        &state.store,
        &state.broadcaster,
        &state.hook_system,
        api::CreateBlockRequest {
            content: req.content,
            parent_id: Some(leaf_parent_id),
            after_id: None,
            at_index: None,
            ..Default::default()
        },
    )?;
    let content_block_id = content_block.id;

    // Shape the content block through the same helper the sibling discovery
    // endpoints use (always-on AncestorContext) so agents get a uniform DTO.
    let block = read_page_dto(&state, &content_block_id)?;

    Ok((
        StatusCode::CREATED,
        Json(PathWriteResponse { block, chain }),
    ))
}

// ============================================================================
// Characterization scaffold for the semantic endpoints (addressing stage 0).
//
// discovery.rs shipped with ZERO tests. Stage 2b (mkdir-p path writes,
// [[FLO-796]]) extends exactly `find_or_create_page`, and ADR-008 stage 2
// changes how path-shaped names ("a > b") resolve. These tests PIN the
// current behavior so those changes land LOUD, not silent.
//
// Why in-crate `#[cfg(test)]` and not a `tests/` integration harness:
// `find_or_create_page`, `scan_pages_container_for_name`, `read_page_dto`,
// `is_valid_date_shape`, and the `upsert_page`/`append_to_daily_note`
// handlers are all private, and `block_service::create_block` is
// `pub(crate)`. Reaching them from a separate integration crate would mean
// widening every one of them to `pub` — a broad production API-surface
// change. In-crate tests need zero visibility changes and can drive the
// internal SemanticCache/scan paths directly.
//
// Determinism note: `create_block` writes to the Y.Doc synchronously and
// then fires the PageNameIndex hook ASYNCHRONOUSLY (a `tokio::spawn`
// dispatch task). `#[tokio::test]` defaults to a current-thread runtime, so
// back-to-back SYNC `find_or_create_page` calls (no `.await` between them)
// never let the dispatch task run — the index stays empty and the
// SemanticCache hook-lag bridge is exercised deterministically. Tests that
// need the index populated poll for it with a bounded `sleep` loop (the
// same pattern `api/mod.rs::test_search_returns_results` uses).
//
// Concurrent same-name serialization (the `Mutex<SemanticCache>` held
// across the whole `find_or_create_page` body, and — FINDING 1 — across the
// ENTIRE `path_write` segment walk) is NOT exercised with a raw two-thread
// race here: that is inherently timing-sensitive and would be flaky in CI.
// The serialization GUARANTEE — no duplicate page/intermediate for the same
// name — is instead pinned by the single-child invariants in
// `find_or_create_page_bridges_hook_lag_via_semantic_cache`,
// `find_or_create_page_is_idempotent_same_name`, and (for the path-write
// walk) `path_write_shared_prefix_reuses_intermediate_no_duplicate`.
// ============================================================================
#[cfg(test)]
mod tests {
    use super::*;
    use crate::block_service::read_block_child_ids;
    use crate::WsBroadcaster;
    use floatty_core::{HookSystem, YDocStore};
    use lru::LruCache;
    use std::num::NonZeroUsize;
    use std::sync::{Arc, Mutex};
    use tempfile::TempDir;
    use yrs::{Any, Array, ArrayPrelim, Map, ReadTxn, Transact, WriteTxn};

    // ------------------------------------------------------------------
    // Fixtures
    // ------------------------------------------------------------------

    /// Smallest honest `AppState` wiring for the semantic endpoints: a real
    /// in-memory Y.Doc store, a real hook system (PageNameIndex + inheritance
    /// index), and an empty SemanticCache. Search infrastructure is skipped
    /// (`initialize_at(store, None)`) — these tests only touch the
    /// PageNameIndex + Y.Doc, and skipping Tantivy keeps them hermetic (no
    /// shared on-disk index path, no filesystem contention under parallel
    /// runs). Returns the `TempDir` so the SQLite file outlives the state.
    fn test_state() -> (AppState, TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("test.db");
        let store = Arc::new(YDocStore::open(&db_path, "test").unwrap());
        let broadcaster = Arc::new(WsBroadcaster::new(64));
        let hook_system = Arc::new(HookSystem::initialize_at(Arc::clone(&store), None));
        let page_name_index = hook_system.page_name_index();
        let inheritance_index = hook_system.inheritance_index();
        let projection_cache = Arc::new(Mutex::new(LruCache::new(
            NonZeroUsize::new(10_000).expect("10_000 is nonzero"),
        )));
        let semantic_cache = Arc::new(Mutex::new(SemanticCache::new()));
        let state = AppState {
            store,
            broadcaster,
            page_name_index,
            inheritance_index,
            hook_system,
            backup_daemon: None,
            projection_cache,
            semantic_cache,
        };
        (state, dir)
    }

    /// Write a single block directly into the store's Y.Doc, bypassing
    /// `create_block` (so NO hook event fires — the block is invisible to the
    /// PageNameIndex and SemanticCache). Used to set up the scan slow-path and
    /// tie-break fixtures. `created_at` mirrors production's `f64` Number
    /// shape; `None` leaves the field absent (extract_timestamp → 0 → "loses").
    fn write_block(
        state: &AppState,
        id: &str,
        content: &str,
        created_at: Option<f64>,
        child_ids: &[&str],
    ) {
        let doc = state.store.doc();
        let doc_guard = doc.write().unwrap();
        let mut txn = doc_guard.transact_mut();
        let blocks = txn.get_or_insert_map("blocks");
        let block: yrs::MapRef = blocks.get_or_init(&mut txn, id);
        block.insert(&mut txn, "content", Any::String(content.into()));
        if let Some(ts) = created_at {
            block.insert(&mut txn, "createdAt", Any::Number(ts));
        }
        let kids: Vec<Any> = child_ids.iter().map(|s| Any::String((*s).into())).collect();
        block.insert(&mut txn, "childIds", ArrayPrelim::from(kids));
    }

    /// Read a block's `content` string from the store's Y.Doc, or `None`.
    fn block_content(state: &AppState, id: &str) -> Option<String> {
        let doc = state.store.doc();
        let doc_guard = doc.read().unwrap();
        let txn = doc_guard.transact();
        let blocks = txn.get_map("blocks")?;
        match blocks.get(&txn, id)? {
            yrs::Out::YMap(m) => match m.get(&txn, "content")? {
                yrs::Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
                _ => None,
            },
            _ => None,
        }
    }

    /// Read a block's `parentId` string from the store's Y.Doc, or `None`.
    fn block_parent(state: &AppState, id: &str) -> Option<String> {
        let doc = state.store.doc();
        let doc_guard = doc.read().unwrap();
        let txn = doc_guard.transact();
        let blocks = txn.get_map("blocks")?;
        match blocks.get(&txn, id)? {
            yrs::Out::YMap(m) => match m.get(&txn, "parentId")? {
                yrs::Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
                _ => None,
            },
            _ => None,
        }
    }

    /// Child ids of the `pages::` container — from the SemanticCache when this
    /// server lifetime created it, falling back to the PageNameIndex when the
    /// container was resolved via the hook only (cache cleared/unset). Empty
    /// when no container exists on either surface.
    fn container_children(state: &AppState) -> Vec<String> {
        let container_id = state
            .semantic_cache
            .lock()
            .unwrap()
            .pages_container_id
            .clone()
            .or_else(|| {
                state
                    .page_name_index
                    .read()
                    .unwrap()
                    .pages_container_id()
                    .map(String::from)
            });
        let Some(container_id) = container_id else {
            return vec![];
        };
        let doc = state.store.doc();
        let doc_guard = doc.read().unwrap();
        let txn = doc_guard.transact();
        let Some(blocks) = txn.get_map("blocks") else {
            return vec![];
        };
        read_block_child_ids(&blocks, &txn, &container_id)
    }

    /// Poll (bounded) until the PageNameIndex hook has registered `name` as an
    /// existing page. Returns false on timeout. `.await` points here are what
    /// let the async dispatch task make progress on the current-thread runtime.
    async fn wait_for_page_in_index(state: &AppState, name: &str) -> bool {
        for _ in 0..40 {
            if state
                .page_name_index
                .read()
                .unwrap()
                .page_block_id(name)
                .is_some()
            {
                return true;
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        false
    }

    /// Poll (bounded) until the PageNameIndex hook has registered the
    /// `pages::` container. Returns the container id, or None on timeout.
    async fn wait_for_container_in_index(state: &AppState) -> Option<String> {
        for _ in 0..40 {
            if let Some(id) = state.page_name_index.read().unwrap().pages_container_id() {
                return Some(id.to_string());
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        None
    }

    // ------------------------------------------------------------------
    // find_or_create_page — creation + container
    // ------------------------------------------------------------------

    #[tokio::test]
    async fn find_or_create_page_creates_pages_container_when_absent() {
        let (state, _dir) = test_state();
        let (page_id, existed) = find_or_create_page(&state, "Demo Alpha").unwrap();

        assert!(!existed, "a brand-new page reports existed=false");
        // The pages:: container is created in-band (synchronously) and cached.
        let container_id = state
            .semantic_cache
            .lock()
            .unwrap()
            .pages_container_id
            .clone();
        let container_id = container_id.expect("pages:: container created synchronously");
        assert_eq!(
            block_content(&state, &container_id).as_deref(),
            Some("pages::")
        );
        // The page block lives under the container with the canonical heading.
        assert_eq!(
            block_content(&state, &page_id).as_deref(),
            Some("# Demo Alpha")
        );
        assert_eq!(
            block_parent(&state, &page_id).as_deref(),
            Some(container_id.as_str())
        );
        assert_eq!(container_children(&state), vec![page_id]);
    }

    #[tokio::test]
    async fn find_or_create_page_is_idempotent_same_name() {
        let (state, _dir) = test_state();
        let (id1, existed1) = find_or_create_page(&state, "Demo Alpha").unwrap();
        let (id2, existed2) = find_or_create_page(&state, "Demo Alpha").unwrap();

        assert!(!existed1);
        assert!(
            existed2,
            "second call for the same name reports existed=true"
        );
        assert_eq!(id1, id2, "same page id returned, no duplicate created");
        assert_eq!(
            container_children(&state).len(),
            1,
            "exactly one page under pages::"
        );
    }

    #[tokio::test]
    async fn find_or_create_page_bridges_hook_lag_via_semantic_cache() {
        // The hook-lag bridge: after create_block returns, the async
        // PageNameIndex hook has NOT run yet (no `.await` in this sequence),
        // so the index is still empty. The SemanticCache, populated
        // synchronously inside find_or_create_page, is what serves the second
        // call — preventing a duplicate page during the lag window.
        let (state, _dir) = test_state();
        let (id1, existed1) = find_or_create_page(&state, "Demo Alpha").unwrap();
        assert!(!existed1);

        // Index still empty in the same sync sequence (hook is async).
        assert!(
            state
                .page_name_index
                .read()
                .unwrap()
                .page_block_id("Demo Alpha")
                .is_none(),
            "PageNameIndex must NOT have caught up yet — this is the lag window"
        );
        // Cache WAS populated synchronously, keyed by lowercased name.
        assert_eq!(
            state
                .semantic_cache
                .lock()
                .unwrap()
                .pages
                .get("demo alpha")
                .map(String::as_str),
            Some(id1.as_str())
        );

        // Second call resolves via the cache, same id, no duplicate.
        let (id2, existed2) = find_or_create_page(&state, "Demo Alpha").unwrap();
        assert!(existed2);
        assert_eq!(id1, id2);
        assert_eq!(container_children(&state).len(), 1);
    }

    #[tokio::test]
    async fn find_or_create_page_resolves_existing_via_page_name_index_after_hook() {
        // Fast-path 1: once the async hook has caught up, an existing page
        // resolves straight from the PageNameIndex. We clear the SemanticCache
        // first so the index is the ONLY thing that can return existed=true.
        let (state, _dir) = test_state();
        let (id1, existed1) = find_or_create_page(&state, "Demo Alpha").unwrap();
        assert!(!existed1);
        assert!(
            wait_for_page_in_index(&state, "Demo Alpha").await,
            "hook should register the page in the index within the poll window"
        );

        {
            let mut cache = state.semantic_cache.lock().unwrap();
            cache.pages.clear();
            cache.pages_container_id = None;
        }

        let (id2, existed2) = find_or_create_page(&state, "Demo Alpha").unwrap();
        assert!(
            existed2,
            "existing page resolves via PageNameIndex fast-path"
        );
        assert_eq!(id1, id2);
    }

    /// Outcome (c): the container is resolvable ONLY via the PageNameIndex
    /// (SemanticCache wiped) and the requested name is a scan MISS — a
    /// brand-new page must land under the EXISTING container, not under a
    /// freshly-created duplicate container.
    #[tokio::test]
    async fn find_or_create_page_creates_new_page_under_index_resolved_container() {
        let (state, _dir) = test_state();

        let (id1, existed1) = find_or_create_page(&state, "Demo Alpha").unwrap();
        assert!(!existed1);
        assert!(
            wait_for_page_in_index(&state, "Demo Alpha").await,
            "hook should register the page in the index within the poll window"
        );

        {
            let mut cache = state.semantic_cache.lock().unwrap();
            cache.pages.clear();
            cache.pages_container_id = None;
        }

        let (id2, existed2) = find_or_create_page(&state, "Demo Beta").unwrap();
        assert!(
            !existed2,
            "scan miss under an index-resolved container → brand-new page"
        );
        assert_ne!(id1, id2);

        let children = container_children(&state);
        assert!(
            children.contains(&id1) && children.contains(&id2),
            "both pages live under ONE container (no duplicate container); children={children:?}"
        );
    }

    #[tokio::test]
    async fn find_or_create_page_matches_case_insensitively() {
        let (state, _dir) = test_state();
        let (id1, _) = find_or_create_page(&state, "Demo Alpha").unwrap();
        // Different casing resolves to the same page (cache key is lowercased).
        let (id2, existed2) = find_or_create_page(&state, "demo alpha").unwrap();
        let (id3, existed3) = find_or_create_page(&state, "DEMO ALPHA").unwrap();

        assert!(existed2 && existed3);
        assert_eq!(id1, id2);
        assert_eq!(id1, id3);
        assert_eq!(
            container_children(&state).len(),
            1,
            "no case-variant duplicates"
        );
    }

    #[tokio::test]
    async fn find_or_create_page_reaches_scan_slow_path_for_page_created_outside_endpoint() {
        // The scan slow-path closes the hook-lag window for pages created by
        // paths that populate NEITHER the index NOR the semantic cache (raw
        // POST /blocks, frontend wikilink-click). The scan only runs when the
        // CONTAINER is known via the PageNameIndex, so we wait for the hook to
        // register the container, then add a page under it via a raw Y.Doc
        // write (no hook, no cache), clear the cache's page map, and confirm
        // find_or_create_page discovers it instead of creating a duplicate.
        let (state, _dir) = test_state();
        let (_alpha_id, _) = find_or_create_page(&state, "Demo Alpha").unwrap();
        let container_id = wait_for_container_in_index(&state)
            .await
            .expect("hook should register the pages:: container");

        const BETA_ID: &str = "00000000-0000-4000-8000-0000000000b2";
        // Raw-create the beta page and append it to the container's childIds.
        {
            let doc = state.store.doc();
            let doc_guard = doc.write().unwrap();
            let mut txn = doc_guard.transact_mut();
            let blocks = txn.get_or_insert_map("blocks");
            let beta: yrs::MapRef = blocks.get_or_init(&mut txn, BETA_ID);
            beta.insert(&mut txn, "content", Any::String("# Demo Beta".into()));
            beta.insert(&mut txn, "createdAt", Any::Number(1_000.0));
            let empty: Vec<Any> = vec![];
            beta.insert(&mut txn, "childIds", ArrayPrelim::from(empty));
            if let Some(yrs::Out::YMap(container)) = blocks.get(&txn, &container_id) {
                if let Some(yrs::Out::YArray(child_ids)) = container.get(&txn, "childIds") {
                    let len = child_ids.len(&txn);
                    child_ids.insert(&mut txn, len, BETA_ID);
                }
            }
        }
        // Index/cache are blind to beta (no hook fired, cache map cleared).
        state.semantic_cache.lock().unwrap().pages.clear();

        let (found_id, existed) = find_or_create_page(&state, "Demo Beta").unwrap();
        assert!(
            existed,
            "scan slow-path finds the raw-created page under the indexed container"
        );
        assert_eq!(
            found_id, BETA_ID,
            "scan returns the existing page, not a new duplicate"
        );
    }

    // ------------------------------------------------------------------
    // scan_pages_container_for_name — direct (deterministic, no hook)
    // ------------------------------------------------------------------

    const CONTAINER: &str = "00000000-0000-4000-8000-000000000001";
    const PAGE_A: &str = "00000000-0000-4000-8000-00000000000a";
    const PAGE_B: &str = "00000000-0000-4000-8000-00000000000b";

    #[tokio::test]
    async fn scan_finds_matching_page_by_title() {
        let (state, _dir) = test_state();
        write_block(&state, PAGE_A, "# Demo Alpha", Some(100.0), &[]);
        write_block(&state, CONTAINER, "pages::", None, &[PAGE_A]);
        let found = scan_pages_container_for_name(&state, CONTAINER, "demo alpha").unwrap();
        assert_eq!(found.as_deref(), Some(PAGE_A));
    }

    #[tokio::test]
    async fn scan_returns_none_when_no_match() {
        let (state, _dir) = test_state();
        write_block(&state, PAGE_A, "# Demo Alpha", Some(100.0), &[]);
        write_block(&state, CONTAINER, "pages::", None, &[PAGE_A]);
        let found = scan_pages_container_for_name(&state, CONTAINER, "no such page").unwrap();
        assert!(found.is_none());
    }

    #[tokio::test]
    async fn scan_oldest_created_at_wins_tie_break() {
        // Two pages share a normalized title; the OLDEST createdAt wins,
        // regardless of child order (mirrors the PageNameIndex tie-break).
        let (state, _dir) = test_state();
        write_block(&state, PAGE_A, "# Demo Alpha", Some(200.0), &[]); // newer
        write_block(&state, PAGE_B, "# Demo Alpha", Some(100.0), &[]); // older
        write_block(&state, CONTAINER, "pages::", None, &[PAGE_A, PAGE_B]);
        let found = scan_pages_container_for_name(&state, CONTAINER, "demo alpha").unwrap();
        assert_eq!(
            found.as_deref(),
            Some(PAGE_B),
            "oldest createdAt wins the tie-break"
        );
    }

    #[tokio::test]
    async fn scan_missing_created_at_loses_to_known() {
        // A page with a missing/0 createdAt is treated as i64::MAX ("unknown
        // age never beats a known one") — see discovery.rs :564-571.
        let (state, _dir) = test_state();
        write_block(&state, PAGE_A, "# Demo Alpha", Some(200.0), &[]); // known
        write_block(&state, PAGE_B, "# Demo Alpha", None, &[]); // missing createdAt
        write_block(&state, CONTAINER, "pages::", None, &[PAGE_B, PAGE_A]);
        let found = scan_pages_container_for_name(&state, CONTAINER, "demo alpha").unwrap();
        assert_eq!(
            found.as_deref(),
            Some(PAGE_A),
            "missing createdAt loses to a known one"
        );
    }

    // ------------------------------------------------------------------
    // upsert_page handler — 200/201/400
    // ------------------------------------------------------------------

    #[tokio::test]
    async fn upsert_page_returns_201_on_create_then_200_on_existing() {
        let (state, _dir) = test_state();

        let (status1, Json(dto1)) = upsert_page(
            State(state.clone()),
            Path("Demo Alpha".to_string()),
            Json(UpsertPageRequest::default()),
        )
        .await
        .unwrap();
        assert_eq!(status1, StatusCode::CREATED);
        assert_eq!(dto1.content, "# Demo Alpha");

        let (status2, Json(dto2)) = upsert_page(
            State(state.clone()),
            Path("Demo Alpha".to_string()),
            Json(UpsertPageRequest::default()),
        )
        .await
        .unwrap();
        assert_eq!(
            status2,
            StatusCode::OK,
            "existing page returns 200, not 201"
        );
        assert_eq!(dto1.id, dto2.id, "same page id on re-upsert");
    }

    #[tokio::test]
    async fn upsert_page_rejects_empty_name() {
        let (state, _dir) = test_state();
        let err = upsert_page(
            State(state.clone()),
            Path(String::new()),
            Json(UpsertPageRequest::default()),
        )
        .await
        .unwrap_err();
        assert!(matches!(err, ApiError::InvalidRequest(_)));
    }

    #[tokio::test]
    async fn upsert_page_rejects_whitespace_only_name() {
        // The handler trims before the empty check, so "   " is a 400 too.
        let (state, _dir) = test_state();
        let err = upsert_page(
            State(state.clone()),
            Path("   ".to_string()),
            Json(UpsertPageRequest::default()),
        )
        .await
        .unwrap_err();
        assert!(matches!(err, ApiError::InvalidRequest(_)));
    }

    // ------------------------------------------------------------------
    // append_to_daily_note handler — 400/201 + autocreation
    // ------------------------------------------------------------------

    #[tokio::test]
    async fn append_to_daily_note_rejects_non_date_shape() {
        let (state, _dir) = test_state();
        let err = append_to_daily_note(
            State(state.clone()),
            Path("26-4-19".to_string()),
            Json(DailyAppendRequest {
                content: "ctx:: demo".to_string(),
            }),
        )
        .await
        .unwrap_err();
        assert!(matches!(err, ApiError::InvalidRequest(_)));
    }

    #[tokio::test]
    async fn append_to_daily_note_rejects_empty_content() {
        let (state, _dir) = test_state();
        let err = append_to_daily_note(
            State(state.clone()),
            Path("2026-07-18".to_string()),
            Json(DailyAppendRequest {
                content: "   ".to_string(),
            }),
        )
        .await
        .unwrap_err();
        assert!(matches!(err, ApiError::InvalidRequest(_)));
    }

    #[tokio::test]
    async fn append_to_daily_note_creates_child_under_autocreated_daily() {
        let (state, _dir) = test_state();
        let (status, Json(child)) = append_to_daily_note(
            State(state.clone()),
            Path("2026-07-18".to_string()),
            Json(DailyAppendRequest {
                content: "ctx:: demo append".to_string(),
            }),
        )
        .await
        .unwrap();

        assert_eq!(status, StatusCode::CREATED);
        assert_eq!(child.content, "ctx:: demo append");

        // The daily note page was autocreated under an autocreated pages::
        // container, and the appended block is its child.
        let daily_id = state
            .semantic_cache
            .lock()
            .unwrap()
            .pages
            .get("2026-07-18")
            .cloned()
            .expect("daily note autocreated + cached");
        assert_eq!(
            block_content(&state, &daily_id).as_deref(),
            Some("# 2026-07-18")
        );
        assert_eq!(child.parent_id.as_deref(), Some(daily_id.as_str()));
        assert!(
            state
                .semantic_cache
                .lock()
                .unwrap()
                .pages_container_id
                .is_some(),
            "pages:: container autocreated"
        );
    }

    // ------------------------------------------------------------------
    // is_valid_date_shape — pure shape validation
    // ------------------------------------------------------------------

    #[test]
    fn is_valid_date_shape_characterization() {
        // Accepts the canonical YYYY-MM-DD shape only (shape, not calendar).
        assert!(is_valid_date_shape("2026-07-18"));
        assert!(is_valid_date_shape("0000-00-00")); // shape-valid; calendar checks are out of scope
                                                    // Rejected: wrong length, wrong separators, non-digits, edges.
        assert!(!is_valid_date_shape("26-4-19"));
        assert!(!is_valid_date_shape("2026-7-8"));
        assert!(!is_valid_date_shape("2026/07/18"));
        assert!(!is_valid_date_shape("2026-07-18 ")); // trailing space → len 11
        assert!(!is_valid_date_shape(" 2026-07-18"));
        assert!(!is_valid_date_shape("202X-07-18"));
        assert!(!is_valid_date_shape(""));
    }

    // ------------------------------------------------------------------
    // Path-shaped names — CHARACTERIZATION of pre-ADR-008 behavior
    // ------------------------------------------------------------------

    #[tokio::test]
    async fn characterize_path_shaped_name_is_opaque_today() {
        // ADR-008 stage 2 will make a path-shaped name like "a > b" resolve or
        // create a PARENT→CHILD path (page "a" with child "b"). TODAY it is an
        // OPAQUE literal: ONE page whose title is the entire string "a > b".
        // This test pins the pre-change behavior so the stage-2 change is
        // LOUD (this test breaks), not accidental.
        let (state, _dir) = test_state();
        let (id1, existed1) = find_or_create_page(&state, "a > b").unwrap();
        assert!(!existed1);

        // Exactly one page, titled with the whole opaque string — not split.
        assert_eq!(container_children(&state), vec![id1.clone()]);
        assert_eq!(block_content(&state, &id1).as_deref(), Some("# a > b"));
        assert_eq!(page_title_from_content("# a > b"), "a > b");

        // Idempotent on the same opaque string; no "a" page created as a
        // side effect (which stage 2 WILL start doing).
        let (id2, existed2) = find_or_create_page(&state, "a > b").unwrap();
        assert!(existed2);
        assert_eq!(id1, id2);
        assert!(
            !state.semantic_cache.lock().unwrap().pages.contains_key("a"),
            "no intermediate 'a' page today — stage 2 changes this"
        );
    }

    // ------------------------------------------------------------------
    // POST /api/v1/path — mkdir-p path-addressed writes (FLO-796, ADR-008)
    // ------------------------------------------------------------------

    /// Total block count across the whole Y.Doc (includes the `pages::`
    /// container). Used to assert idempotency deltas.
    fn total_block_count(state: &AppState) -> usize {
        let doc = state.store.doc();
        let doc_guard = doc.read().unwrap();
        let txn = doc_guard.transact();
        let Some(blocks) = txn.get_map("blocks") else {
            return 0;
        };
        blocks.iter(&txn).count()
    }

    /// Direct childIds of any block (not just the `pages::` container).
    fn child_ids_of(state: &AppState, id: &str) -> Vec<String> {
        let doc = state.store.doc();
        let doc_guard = doc.read().unwrap();
        let txn = doc_guard.transact();
        let Some(blocks) = txn.get_map("blocks") else {
            return vec![];
        };
        read_block_child_ids(&blocks, &txn, id)
    }

    /// Raw-append a child block to `parent_id`'s childIds (no hook, no cache —
    /// like `write_block`, but APPENDS instead of clobbering the parent's
    /// existing childIds). Used to seed exact-duplicate siblings and nested
    /// levels under a page created via `find_or_create_page`.
    fn raw_add_child(
        state: &AppState,
        parent_id: &str,
        child_id: &str,
        content: &str,
        created_at: f64,
    ) {
        let doc = state.store.doc();
        let doc_guard = doc.write().unwrap();
        let mut txn = doc_guard.transact_mut();
        let blocks = txn.get_or_insert_map("blocks");
        let child: yrs::MapRef = blocks.get_or_init(&mut txn, child_id);
        child.insert(&mut txn, "content", Any::String(content.into()));
        child.insert(&mut txn, "createdAt", Any::Number(created_at));
        child.insert(&mut txn, "parentId", Any::String(parent_id.into()));
        let empty: Vec<Any> = vec![];
        child.insert(&mut txn, "childIds", ArrayPrelim::from(empty));
        if let Some(yrs::Out::YMap(parent)) = blocks.get(&txn, parent_id) {
            if let Some(yrs::Out::YArray(child_ids)) = parent.get(&txn, "childIds") {
                let len = child_ids.len(&txn);
                child_ids.insert(&mut txn, len, child_id);
            }
        }
    }

    #[tokio::test]
    async fn path_write_happy_path_creates_full_chain() {
        let (state, _dir) = test_state();
        let (status, Json(resp)) = path_write(
            State(state.clone()),
            Json(PathWriteRequest {
                path: "Demo Page > Section A > Sub B".to_string(),
                content: "leaf content".to_string(),
            }),
        )
        .await
        .unwrap();

        assert_eq!(status, StatusCode::CREATED);
        assert_eq!(resp.chain.len(), 3, "page + 2 intermediates");

        // Segment 1 is a page (canonical heading form); segments 2..N are
        // direct children with content AS-WRITTEN (no heading prefix).
        assert_eq!(
            block_content(&state, &resp.chain[0]).as_deref(),
            Some("# Demo Page")
        );
        assert_eq!(
            block_content(&state, &resp.chain[1]).as_deref(),
            Some("Section A")
        );
        assert_eq!(
            block_content(&state, &resp.chain[2]).as_deref(),
            Some("Sub B")
        );

        // Chain is nested parent→child.
        assert_eq!(
            block_parent(&state, &resp.chain[1]).as_deref(),
            Some(resp.chain[0].as_str())
        );
        assert_eq!(
            block_parent(&state, &resp.chain[2]).as_deref(),
            Some(resp.chain[1].as_str())
        );

        // Content block lands under the leaf segment.
        assert_eq!(resp.block.content, "leaf content");
        assert_eq!(
            resp.block.parent_id.as_deref(),
            Some(resp.chain[2].as_str())
        );

        // The page lives under the (autocreated) pages:: container.
        assert_eq!(container_children(&state), vec![resp.chain[0].clone()]);
    }

    #[tokio::test]
    async fn path_write_repost_creates_zero_new_intermediates() {
        // ADR-008 D7 idempotency: re-POST of the same path reuses every segment
        // and creates ONLY the new content block (block-count delta == 1).
        let (state, _dir) = test_state();
        let path = "Demo Page > Section A > Sub B".to_string();

        let (_s1, Json(resp1)) = path_write(
            State(state.clone()),
            Json(PathWriteRequest {
                path: path.clone(),
                content: "first".to_string(),
            }),
        )
        .await
        .unwrap();
        let count1 = total_block_count(&state);

        let (_s2, Json(resp2)) = path_write(
            State(state.clone()),
            Json(PathWriteRequest {
                path: path.clone(),
                content: "second".to_string(),
            }),
        )
        .await
        .unwrap();
        let count2 = total_block_count(&state);

        assert_eq!(
            resp1.chain, resp2.chain,
            "same segment ids reused — zero new intermediates"
        );
        assert_eq!(
            count2 - count1,
            1,
            "only the second content block is new (count1={count1}, count2={count2})"
        );
        assert_ne!(
            resp1.block.id, resp2.block.id,
            "each POST creates its own content block"
        );
    }

    #[tokio::test]
    async fn path_write_shared_prefix_reuses_intermediate_no_duplicate() {
        // FINDING 1 invariant: two DIFFERENT path writes sharing a prefix
        // ("Demo Page > Section A") reuse the SAME page + intermediate — a
        // single "Section A" under the page, not one per write. Sequential
        // here (a raw two-thread race is timing-sensitive → flaky; see the
        // module note). This pins the shared-prefix reuse invariant that the
        // full-walk SemanticCache critical section preserves under concurrency.
        let (state, _dir) = test_state();

        let (_s1, Json(resp1)) = path_write(
            State(state.clone()),
            Json(PathWriteRequest {
                path: "Demo Page > Section A > Leaf One".to_string(),
                content: "one".to_string(),
            }),
        )
        .await
        .unwrap();

        let (_s2, Json(resp2)) = path_write(
            State(state.clone()),
            Json(PathWriteRequest {
                path: "Demo Page > Section A > Leaf Two".to_string(),
                content: "two".to_string(),
            }),
        )
        .await
        .unwrap();

        // Shared prefix reused; diverging leaf segment is distinct.
        assert_eq!(resp1.chain[0], resp2.chain[0], "same page reused");
        assert_eq!(
            resp1.chain[1], resp2.chain[1],
            "same Section A reused — no duplicate intermediate"
        );
        assert_ne!(resp1.chain[2], resp2.chain[2], "distinct leaf segments");

        // Exactly one page under pages::; exactly one Section A under the page.
        assert_eq!(container_children(&state), vec![resp1.chain[0].clone()]);
        let section_ids = child_ids_of(&state, &resp1.chain[0]);
        assert_eq!(
            section_ids,
            vec![resp1.chain[1].clone()],
            "single Section A intermediate; got {section_ids:?}"
        );
        // Two distinct leaf segments under the shared Section A.
        let leaves = child_ids_of(&state, &resp1.chain[1]);
        assert_eq!(
            leaves.len(),
            2,
            "two distinct leaf segments under Section A; got {leaves:?}"
        );
    }

    #[tokio::test]
    async fn path_write_reuses_intermediate_oldest_wins_on_duplicate_siblings() {
        // An existing intermediate is reused (no duplicate created); among two
        // exact-title duplicate siblings, the OLDEST createdAt wins the match.
        let (state, _dir) = test_state();
        let (page_id, _) = find_or_create_page(&state, "Demo Page").unwrap();

        const NEWER: &str = "00000000-0000-4000-8000-0000000000c1";
        const OLDER: &str = "00000000-0000-4000-8000-0000000000c2";
        raw_add_child(&state, &page_id, NEWER, "Section A", 200.0);
        raw_add_child(&state, &page_id, OLDER, "Section A", 100.0);

        let (_status, Json(resp)) = path_write(
            State(state.clone()),
            Json(PathWriteRequest {
                path: "Demo Page > Section A > leaf".to_string(),
                content: "x".to_string(),
            }),
        )
        .await
        .unwrap();

        assert_eq!(resp.chain[0], page_id, "existing page reused");
        assert_eq!(
            resp.chain[1].as_str(),
            OLDER,
            "oldest-createdAt duplicate sibling wins — no new Section A"
        );
        let kids = child_ids_of(&state, &page_id);
        assert_eq!(
            kids.len(),
            2,
            "no duplicate Section A created; kids={kids:?}"
        );
    }

    #[tokio::test]
    async fn path_write_direct_child_only_does_not_skip_levels() {
        // The corpus `read_skips_levels_write_does_not` property (write half):
        // seed page > A > B > C (nested), POST "Demo Page > C" must NOT descend
        // into the nested C — it creates a NEW direct child C under the page.
        let (state, _dir) = test_state();
        let (page_id, _) = find_or_create_page(&state, "Demo Page").unwrap();
        const A: &str = "00000000-0000-4000-8000-0000000000a1";
        const B: &str = "00000000-0000-4000-8000-0000000000b1";
        const C_NESTED: &str = "00000000-0000-4000-8000-0000000000c3";
        raw_add_child(&state, &page_id, A, "A", 100.0);
        raw_add_child(&state, A, B, "B", 100.0);
        raw_add_child(&state, B, C_NESTED, "C", 100.0);

        let (_status, Json(resp)) = path_write(
            State(state.clone()),
            Json(PathWriteRequest {
                path: "Demo Page > C".to_string(),
                content: "leaf".to_string(),
            }),
        )
        .await
        .unwrap();

        assert_eq!(resp.chain[0], page_id);
        assert_ne!(
            resp.chain[1].as_str(),
            C_NESTED,
            "write must NOT skip levels into the nested C"
        );
        assert_eq!(
            block_parent(&state, &resp.chain[1]).as_deref(),
            Some(page_id.as_str()),
            "new C is a DIRECT child of the page"
        );
        assert_eq!(block_content(&state, &resp.chain[1]).as_deref(), Some("C"));

        let kids = child_ids_of(&state, &page_id);
        assert_eq!(kids.len(), 2, "A + the new direct-child C; kids={kids:?}");
        assert!(kids.iter().any(|k| k == A) && kids.contains(&resp.chain[1]));

        // Content landed under the NEW C; the nested C is untouched.
        assert_eq!(
            resp.block.parent_id.as_deref(),
            Some(resp.chain[1].as_str())
        );
        assert!(
            child_ids_of(&state, C_NESTED).is_empty(),
            "nested C gained no children"
        );
    }

    #[tokio::test]
    async fn path_write_multi_segment_all_new_threads_ids_without_index() {
        // The created-parent-not-in-index case: nothing exists, so the walk
        // creates page → Alpha → Beta → content by threading ids DIRECTLY.
        // Intermediates are direct children (never pages), so they are NEVER in
        // the PageNameIndex — a re-lookup-by-name walk could not nest them.
        // Correct nesting here proves the id-threading mechanism.
        let (state, _dir) = test_state();
        let (status, Json(resp)) = path_write(
            State(state.clone()),
            Json(PathWriteRequest {
                path: "Fresh Page > Alpha > Beta".to_string(),
                content: "deep".to_string(),
            }),
        )
        .await
        .unwrap();

        assert_eq!(status, StatusCode::CREATED);
        assert_eq!(resp.chain.len(), 3);
        assert_eq!(
            block_parent(&state, &resp.chain[1]).as_deref(),
            Some(resp.chain[0].as_str())
        );
        assert_eq!(
            block_parent(&state, &resp.chain[2]).as_deref(),
            Some(resp.chain[1].as_str())
        );
        assert_eq!(
            resp.block.parent_id.as_deref(),
            Some(resp.chain[2].as_str())
        );

        // Intermediates are direct children — NOT registered as pages.
        assert!(
            state
                .page_name_index
                .read()
                .unwrap()
                .page_block_id("Alpha")
                .is_none(),
            "intermediate 'Alpha' is a direct child, never a page"
        );
        assert!(
            state
                .page_name_index
                .read()
                .unwrap()
                .page_block_id("Beta")
                .is_none(),
            "intermediate 'Beta' is a direct child, never a page"
        );

        // Only ONE page under the pages:: container (segment 1).
        assert_eq!(container_children(&state), vec![resp.chain[0].clone()]);
    }

    #[test]
    fn has_top_level_separator_characterization() {
        // A top-level whitespace-delimited '>' is a would-be separator.
        assert!(has_top_level_separator("a > b"));
        assert!(has_top_level_separator("a >  > b"));
        assert!(has_top_level_separator("a >")); // trailing separator (ws-left, end-right)
                                                 // Legitimate single opaque names carry no would-be separator.
        assert!(!has_top_level_separator("Vec<String>")); // generics
        assert!(!has_top_level_separator("a>b")); // bare '>', no whitespace
        assert!(!has_top_level_separator("just a page"));
        assert!(!has_top_level_separator("[[a > b]]")); // '>' inside brackets (depth 1)
    }

    #[tokio::test]
    async fn path_write_rejects_empty_path() {
        let (state, _dir) = test_state();
        let err = path_write(
            State(state.clone()),
            Json(PathWriteRequest {
                path: String::new(),
                content: "x".to_string(),
            }),
        )
        .await
        .unwrap_err();
        assert!(matches!(err, ApiError::InvalidRequest(_)));
    }

    #[tokio::test]
    async fn path_write_rejects_whitespace_path() {
        let (state, _dir) = test_state();
        let err = path_write(
            State(state.clone()),
            Json(PathWriteRequest {
                path: "   ".to_string(),
                content: "x".to_string(),
            }),
        )
        .await
        .unwrap_err();
        assert!(matches!(err, ApiError::InvalidRequest(_)));
    }

    #[tokio::test]
    async fn path_write_rejects_empty_content() {
        let (state, _dir) = test_state();
        let err = path_write(
            State(state.clone()),
            Json(PathWriteRequest {
                path: "Demo Page".to_string(),
                content: "   ".to_string(),
            }),
        )
        .await
        .unwrap_err();
        assert!(matches!(err, ApiError::InvalidRequest(_)));
    }

    #[tokio::test]
    async fn path_write_rejects_malformed_multi_segment() {
        // Whitespace-delimited '>' with an empty middle segment parses opaque —
        // 400, rather than creating a page literally titled "a >  > b".
        let (state, _dir) = test_state();
        let err = path_write(
            State(state.clone()),
            Json(PathWriteRequest {
                path: "a >  > b".to_string(),
                content: "x".to_string(),
            }),
        )
        .await
        .unwrap_err();
        assert!(matches!(err, ApiError::InvalidRequest(_)));
        assert_eq!(
            total_block_count(&state),
            0,
            "malformed path creates no blocks"
        );
    }

    #[tokio::test]
    async fn path_write_generics_name_is_single_page_not_rejected() {
        // `Vec<String>` carries a '>' but no whitespace-delimited separator, so
        // it is a legitimate single opaque page address (ADR-008 D1) — not a 400.
        let (state, _dir) = test_state();
        let (status, Json(resp)) = path_write(
            State(state.clone()),
            Json(PathWriteRequest {
                path: "Vec<String>".to_string(),
                content: "x".to_string(),
            }),
        )
        .await
        .unwrap();
        assert_eq!(status, StatusCode::CREATED);
        assert_eq!(resp.chain.len(), 1, "single opaque page, no split");
        assert_eq!(
            block_content(&state, &resp.chain[0]).as_deref(),
            Some("# Vec<String>")
        );
    }
}
