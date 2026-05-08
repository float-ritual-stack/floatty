# floatty-server API Reference

Auth required. Config: `~/.floatty-dev/config.toml` (dev) or `~/.floatty/config.toml` (prod).

```bash
KEY=$(grep '^api_key' ~/.floatty-dev/config.toml | cut -d'"' -f2)
PORT=$(grep '^server_port' ~/.floatty-dev/config.toml | cut -d= -f2 | tr -d ' ')
```

## Block CRUD

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/v1/blocks` | All blocks (`{ blocks: [...], root_ids: [...] }`) |
| GET | `/api/v1/blocks/:id` | Single block (supports short-hash prefix, 6+ hex chars) |
| POST | `/api/v1/blocks` | Create block (`{ content, parentId?, afterId? }`) |
| PATCH | `/api/v1/blocks/:id` | Update block (`{ content?, parentId?, collapsed? }`) |
| DELETE | `/api/v1/blocks/:id` | Delete block + subtree |

### Block Context Retrieval

`GET /api/v1/blocks/:id?include=ancestors,siblings,children,tree,token_estimate`

| Include | What |
|---------|------|
| `ancestors` | Parent chain to root (max 20; was 10 pre-v0.13.2 — bumped after live-outline depth probe found real-world max=16) |
| `siblings` | N blocks before/after (`&sibling_radius=2`) |
| `children` | Direct children |
| `tree` | Full subtree DFS (max 1000) |
| `token_estimate` | totalChars, blockCount, maxDepth |

### Door Block Markdown Projection (FLO-633)

`GET /api/v1/blocks/:id` always returns a non-null `metadata.renderedMarkdown` for door blocks (`outputType === "door"`) with non-empty output. Four-layer fallback chain, response-only (no Y.Doc writes, no WS broadcasts):

1. `output.data.normalizedMarkdown` (future, not yet used)
2. `metadata.renderedMarkdown` (frontend hook — preferred when present)
3. `walk_spec_to_markdown(output.data.spec)` — server-side Rust walker
4. `walk_generic_json_to_markdown(output.data)` — last-resort fallback

Agents consuming the API can rely on the field being populated. Walker output is ~0.19× raw spec JSON (agent-oriented crude walker, no visual formatting preserved). Cached in-memory via LRU keyed by `(block_id, hash(output.data))`. Applies to `GET /api/v1/blocks/:id`. **Bulk endpoint** `GET /api/v1/blocks` does NOT apply the projection — use per-block GETs if you need markdown for many doors.

### Short-Hash Resolution

All `:id` params and body fields (`parentId`, `afterId`) accept 6+ hex-char prefixes.
- 200 = unique match
- 400 = too short / invalid hex
- 404 = no match
- 409 = ambiguous (returns match list)

Client-side: `shortHashIndex` singleton memo in WorkspaceContext for O(1) 8-char lookups.

## Search

`GET /api/v1/search` — full-text + structured filters. `q` is optional (filter-only with AllQuery).

| Param | Type | Description |
|-------|------|-------------|
| `q` | String | Full-text (optional) |
| `limit` | usize | Max results (default 20) |
| `types` | String | Comma-separated block types |
| `has_markers` | bool | Filter by marker presence |
| `parent_id` | String | Search within subtree |
| `outlink` | String | [[wikilink]] target (exact) |
| `marker_type` | String | Marker type (e.g., "project") |
| `marker_val` | String | Marker value (e.g., "floatty"). Joins with marker_type internally |
| `inherited` | bool | When false, use own-only marker fields (default true) |
| `exclude_types` | String | Comma-separated block types to exclude (MustNot) |
| `created_after/before` | i64 | Epoch seconds — block creation time |
| `ctx_after/before` | i64 | Epoch seconds — ctx:: event time |
| `include_breadcrumb` | bool | Parent chain per hit |
| `include_metadata` | bool | Block metadata per hit |
| `include` | String | Comma-separated AncestorContext opt-ins: `effective_markers`, `inbound_samples` (FLO-679 PR 2) |
| `inbound_sample_count` | usize | Cap for `inbound_samples` (default 5; max 50) |

Each `BlockSearchHit` carries (in addition to `blockId`/`score`/`content`/
`snippet`/`breadcrumb`/`metadata`/`blockType`/`ancestorContext`):

| Field | Type | Notes |
|-------|------|-------|
| `createdAt` | i64 (ms) | Block creation timestamp from Y.Map. Mirrors `BlockDto.createdAt`. Dropped from wire when 0 (FLO-684) |
| `updatedAt` | i64 (ms) | Last-edit timestamp. Single source of truth = block's Y.Map `updatedAt`. Frontend stamps on every local edit; REST mutations stamp on PATCH/POST. Symmetry harness asserts `BlockSearchHit.updatedAt == BlockDto.updatedAt` (FLO-684) |
| `outputType` | String | `"door"` / `"eval-result"` / `"search-results"` etc. when set. Mirrors `BlockDto.outputType` so MCP/agent consumers can distinguish doors from text without a follow-up GET (FLO-684) |

### AncestorContext (FLO-679 PR 2 — every block-returning endpoint)

Every endpoint that returns a block-shaped response carries an
`ancestorContext` sub-object that surfaces the navigation-layer view of
the block's place in the outline. Surfaces:

- `GET /api/v1/blocks/:id` — always-on, including `effectiveMarkers`
- `GET /api/v1/blocks/resolve/:prefix` — same shape as `/blocks/:id`
- `GET /api/v1/blocks` — opt-in via `?ancestorContext=true` (off by default for bulk)
- `GET /api/v1/search` — always-on cheap fields per hit
- `GET /api/v1/pages/search` — non-stub pages get `ancestorContext`
- `GET /api/v1/presence` — focused block, always-on cheap fields ([[FLO-680]])
- `GET /api/v1/daily/:date` — daily note page, always-on `effectiveMarkers`
- `POST /api/v1/pages/:name` (upsert) — newly-created or existing page, always-on
- `POST /api/v1/daily/:date/append` — appended child, always-on

Wire shape (camelCase JSON):

```json
{
  "ancestorContext": {
    "nearestPageBlockId": "uuid-of-page-block",
    "nearestPageName": "FLO-679",
    "ancestorBlockIds": ["root-id", "...", "immediate-parent-id"],
    "subtreeSize": 47,
    "inboundCount": 12,
    "ancestorOutlinks": ["FLO-368", "FLO-680"],
    "effectiveMarkers": [
      { "markerType": "project", "value": "floatty",
        "source": { "kind": "inherited", "sourceBlockId": "ancestor-uuid" } }
    ],
    "inboundSamples": [
      { "blockId": "src-uuid", "content": "see [[FLO-679]] for context" }
    ],
    "kind": "nav_node",
    "childrenPreview": [
      { "id": "child-uuid-1", "content": "first child preview, truncated…" },
      { "id": "child-uuid-2", "content": "second child preview" }
    ],
    "siblings": {
      "before": [{ "id": "prev-uuid", "content": "prev sibling content" }],
      "after":  [{ "id": "next-uuid", "content": "next sibling content" }]
    }
  }
}
```

Field semantics:

- `ancestorBlockIds` is **rootmost-first** (matches breadcrumb composer's
  `take(5).rev()` shape — root → ... → immediate parent). Capped at 20
  by the walker (`ANCESTOR_CONTEXT_MAX_DEPTH` in `block_service.rs`).
  When the chain is longer than 20, the rootmost ancestors are silently
  truncated; callers can detect this via `ancestorBlockIds.len() == 20`.
- `ancestorOutlinks` is the deduped union of `[[wikilink]]`s across the
  block itself and its walked ancestors — "all destinations reachable from
  this block's lineage."
- `subtreeSize` counts the block itself plus descendants up to a cap
  (1000); use as a "navigate vs. read" hint.
- `inboundCount` is how many blocks point at this block's nearest page —
  load-bearing-block signal.
- `kind` is a navigation-layer projection over content + structure
  (`nav_node` / `content_block` / `leaf_marker`). Derived via
  `classify_block_kind` (which reuses `parse_block_type` from
  `floatty-core::block`); mirrors `classifyBacklink` in
  `apps/floatty/src/lib/backlinkClassify.ts`. NOT load-bearing for
  `is_empty()` — bare-root with `kind` alone still ships as `None`.
- `childrenPreview` is the first N children as `BlockRef`s with
  content truncated to 200 chars (UTF-8-safe). Recursive classification
  is intentionally NOT carried — clients re-classify each preview
  locally if `nav_classification` is also opted in.
- `siblings` is the prev/next preview within the parent's `childIds`
  via `get_siblings(radius=1)`. Same `SiblingContext` DTO as the
  per-singleton `/blocks/:id?include=siblings` field. Returns `null`
  for root blocks (no parent).

Cost-tier opt-ins (use `?include=` on search/presence; always-on for `/blocks/:id`):

| `?include=` value | What it adds | Cost |
|---|---|---|
| `effective_markers` | Own + inherited markers with provenance | InheritanceIndex lookup |
| `inbound_samples` | Top-N source-block previews (default 5, `&inbound_sample_count=N`) | Reverse-index walk |
| `nav_classification` | Block's `kind` (`nav_node` / `content_block` / `leaf_marker`) | One yrs `content` read + child-list-empty check (~100ns) |
| `children_preview` | First N child block_id+content (truncated 200) | N×1 yrs Map lookup; default 5, cap 20. ~1KB/hit when N=5 (`&children_preview_count=N`) |
| `siblings` | Prev/next sibling `BlockRef`s within parent's `childIds` | Two yrs lookups via parent's `child_ids`; ~200B/hit |

Endpoints whose response is `None`/absent for `ancestorContext`:

- A `/blocks` bulk response without `?ancestorContext=true`
- A `pages/search` stub (no `blockId` → no chain to compute)
- A `/presence` 204 (no focus set)

The contract is enforced by a symmetry harness in
`apps/floatty/src-tauri/floatty-server/tests/symmetry_ancestor_context.rs`
— if a future change drifts any endpoint's shape, that test fires.

## Daily Note

`GET /api/v1/daily/:date` — Resolve daily note page by date string (e.g., `2026-03-31`).

Looks up the page named exactly `:date` in the PageNameIndex. Returns the page block in the same shape as `GET /api/v1/blocks/:id`. Defaults to `include=children` if no `include` param specified.

```bash
# Get today's daily note with children
curl -H "Authorization: Bearer $KEY" "http://127.0.0.1:$PORT/api/v1/daily/2026-03-31"

# Get with full subtree
curl -H "Authorization: Bearer $KEY" "http://127.0.0.1:$PORT/api/v1/daily/2026-03-31?include=tree,token_estimate"
```

Returns 404 if no page with that name exists.

## Semantic Endpoints (FLO-652)

Semantic siblings of the low-level block CRUD. Hide structural conventions (`pages::` container, daily-note naming) from API consumers so agents don't have to rediscover layout rules.

### Upsert Page

`POST /api/v1/pages/:name` — get-or-create a page under the `pages::` container.

Idempotent. Body is currently empty (`{}`). Responses:
- **200 OK** when the page already existed (lookup via PageNameIndex, case-insensitive)
- **201 Created** when the page was freshly created (autocreates the `pages::` container too if absent)
- **400 Bad Request** when the name is empty / whitespace-only

Returns a `BlockDto` — same shape as `GET /api/v1/blocks/:id`. Page content is written as `# ${name}` (CommonMark heading) so it renders correctly when zoomed.

Concurrency-safe: a per-process `semantic_cache` mutex in `AppState` serialises the find-or-create path so simultaneous POSTs for the same name return the same page id and the same 200/201 classification. Cache also bridges the async `PageNameIndex` hook-update window.

```bash
curl -X POST -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" -d '{}' \
  "http://127.0.0.1:$PORT/api/v1/pages/Shell-Lite%20Spec"
```

### Append to Daily Note

`POST /api/v1/daily/:date/append` — append a child block under the specified daily note, autocreating the daily note (and `pages::` container) when missing.

Body: `{ "content": "..." }` — the child block's content.

Responses:
- **201 Created** with the new child's `BlockDto`
- **400 Bad Request** when:
  - `:date` isn't `YYYY-MM-DD` shape — prevents creating orphan pages that `GET /api/v1/daily/:date` cannot resolve
  - `content` is empty / whitespace-only — empty appends are almost never intentional

```bash
curl -X POST -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"content":"ctx::quick note"}' \
  "http://127.0.0.1:$PORT/api/v1/daily/2026-04-19/append"
```

Use this instead of `POST /api/v1/blocks` with a search-resolved `parentId` — callers no longer need to know that daily notes live under `pages::` or what their content format looks like.

## Vocabulary Discovery

| Endpoint | Returns |
|----------|---------|
| `GET /api/v1/markers` | Distinct marker types + counts |
| `GET /api/v1/markers/:type/values` | Values for a marker type |
| `GET /api/v1/stats` | Block count, roots, type distribution, metadata coverage |

## Sync & State

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/v1/state` | GET | Full Y.Doc state (base64) |
| `/api/v1/state-vector` | GET | State vector for reconciliation |
| `/api/v1/state/hash` | GET | SHA256 hash + block count |
| `/api/v1/update` | POST | CRDT merge (`{ update: "<base64>" }`) |
| `/api/v1/restore` | POST | **DESTRUCTIVE** — replace Y.Doc (`{ state: "<base64>" }`, requires `X-Floatty-Confirm-Destructive: true`) |
| `/api/v1/export/binary` | GET | Download `.ydoc` file |
| `/api/v1/export/json` | GET | Download JSON export |
| `/api/v1/health` | GET | Version + git info (no auth) |

`/update` = CRDT merge (no-op if server ahead). `/restore` = nuclear replacement.

## Ghost Writer Path

REST write → Persist SQLite (FIRST) → Apply Y.Doc → Broadcast WS.
Risk: non-atomic persist→broadcast. Mitigated by 120-sec health check detecting block count drift.

## Binary Import

```bash
npx tsx scripts/binary-import.ts ~/path/to/backup.ydoc
```
