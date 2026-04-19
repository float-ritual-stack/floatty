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
| `ancestors` | Parent chain to root (max 10) |
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

Agents consuming the API can rely on the field being populated. Walker output is ~0.19× raw spec JSON (agent-oriented crude walker, no visual formatting preserved). Cached in-memory via LRU keyed by `(block_id, hash(output.data))`. Applies to both `/api/v1/blocks/:id` and `/api/v1/outlines/:name/blocks/:id`. **Bulk endpoints** (`GET /api/v1/blocks`, `GET /api/v1/outlines/:name/blocks`) do NOT apply the projection — use per-block GETs if you need markdown for many doors.

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
- **400 Bad Request** when date is empty / content field missing

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
