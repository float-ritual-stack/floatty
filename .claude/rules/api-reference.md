# floatty-server API Reference

Auth required. Config: `~/.floatty-dev/config.toml` (dev) or `~/.floatty/config.toml` (prod).

```bash
KEY=$(grep api_key ~/.floatty-dev/config.toml | cut -d'"' -f2)
PORT=$(grep server_port ~/.floatty-dev/config.toml | cut -d= -f2 | tr -d ' ')
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
