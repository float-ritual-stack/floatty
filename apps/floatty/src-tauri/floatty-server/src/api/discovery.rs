//! Discovery handlers — markers, stats, daily note, presence, attachments.
//!
//! Also hosts the "semantic endpoints for outline conventions" track
//! ([[FLO-652]]): `POST /api/v1/pages/:name` (upsert) and
//! `POST /api/v1/daily/:date/append` — both hide the `pages::`-container
//! structural detail from API consumers so agents (ink-chat, Desktop
//! Daddy, future surfaces) don't have to rediscover outline layout rules
//! on every new tool.

use axum::{
    extract::{Path, State},
    http::{header, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use std::collections::HashMap;
use yrs::{Map, ReadTxn, Transact};

use super::{ApiError, AppState, BlockContextQuery, BlockWithContextResponse};
use crate::api::{self, BlockDto};
use crate::block_service::{lookup_inherited, read_block_dto};

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
        let inherited_markers = {
            let index = state
                .inheritance_index
                .read()
                .map_err(|_| ApiError::LockPoisoned)?;
            lookup_inherited(&index, &page_id)
        };
        let mut block_dto =
            read_block_dto(&block_map, &txn, &page_id, inherited_markers, true);

        // FLO-679 PR 2: AncestorContext on daily-note response (singleton
        // path — effective_markers always-on).
        let inh = state
            .inheritance_index
            .read()
            .map_err(|_| ApiError::LockPoisoned)?;
        let pni = state
            .page_name_index
            .read()
            .map_err(|_| ApiError::LockPoisoned)?;
        let opts = crate::block_service::AncestorContextOpts::from_query(&ctx_query)
            .always_effective();
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

async fn get_presence(State(state): State<AppState>) -> impl IntoResponse {
    let Some(info) = state.broadcaster.get_last_presence() else {
        return StatusCode::NO_CONTENT.into_response();
    };

    let doc = state.store.doc();
    let Ok(doc_guard) = doc.read() else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    let txn = doc_guard.transact();
    let block_exists = txn
        .get_map("blocks")
        .and_then(|m| m.get(&txn, &info.block_id))
        .is_some();

    if !block_exists {
        return StatusCode::NO_CONTENT.into_response();
    }

    Json(serde_json::json!({
        "blockId": info.block_id,
        "paneId": info.pane_id,
    }))
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

    Ok((
        StatusCode::OK,
        [(
            header::CONTENT_TYPE,
            header::HeaderValue::from_static(content_type),
        )],
        bytes,
    ))
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
    // Held across the full body, including the `create_block` calls — those
    // touch the Y.Doc write lock and the hook system, neither of which is
    // held at this point, so no deadlock. The async hook that updates
    // `PageNameIndex` runs AFTER we release this lock.
    let mut cache = state
        .semantic_cache
        .lock()
        .map_err(|_| ApiError::LockPoisoned)?;
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
        },
    )?;

    cache.pages.insert(name_key, page.id.clone());
    Ok((page.id, false))
}

/// Read a page block as a `BlockDto` for returning from the upsert handler.
/// Scoped to this module — the full `get_block` in `block_service` builds a
/// context response (ancestors, siblings, etc.) that we don't need here.
///
/// FLO-679 PR 2: the returned BlockDto carries `ancestorContext` (always-on
/// for singleton paths, mirrors `/blocks/:id`). For a freshly-upserted page
/// the ancestor chain is just the `pages::` container; for an existing page
/// the chain reflects whatever the outline has materialised.
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
        let inherited_markers = {
            let index = state
                .inheritance_index
                .read()
                .map_err(|_| ApiError::LockPoisoned)?;
            lookup_inherited(&index, id)
        };
        let mut dto = read_block_dto(&block_map, &txn, id, inherited_markers, true);

        // FLO-679 PR 2: always-on AncestorContext on the upsert response.
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
    if name.trim().is_empty() {
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
        },
    )?;

    // FLO-679 PR 2: attach AncestorContext to the newly-created child
    // (always-on for singleton paths). The hook system is async so the
    // PageNameIndex / InheritanceIndex lookups reflect at-call-time state —
    // for a fresh append under an existing daily note, the daily note is
    // already in PageNameIndex so nearestPage* populates correctly.
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
