# floatty-server API Reference

## Base Configuration

| Setting | Default | Override |
|---------|---------|----------|
| Base URL | `http://localhost:8765` | `FLOATTY_URL` env var |
| API Key | From `~/.floatty/config.toml` | `FLOATTY_API_KEY` env var |

## Authentication

All API requests require Bearer token authentication:

```bash
curl -H "Authorization: Bearer YOUR_API_KEY" \
     -H "Content-Type: application/json" \
     http://localhost:8765/api/v1/blocks
```

## Endpoints

### Health Check

```
GET /api/v1/health
```

**Response:**
```json
{"status": "ok", "version": "0.8.4", "gitSha": "e2f3c53", "gitDirty": false}
```

---

### List All Blocks

```
GET /api/v1/blocks
```

**Response:**
```json
{
  "blocks": [
    {
      "id": "a9cab933-1639-4d3d-9bc9-5f13411d7e12",
      "content": "Block content here",
      "parentId": null,
      "childIds": ["def456", "ghi789"],
      "collapsed": false,
      "blockType": "text",
      "metadata": { "markers": [], "outlinks": [] },
      "createdAt": 1772465715784,
      "updatedAt": 1772856904273
    }
  ],
  "rootIds": ["a9cab933-1639-4d3d-9bc9-5f13411d7e12"]
}
```

---

### Get Single Block

```
GET /api/v1/blocks/{id}
```

**Response:**
```json
{
  "id": "abc123",
  "content": "Block content",
  "parentId": null,
  "childIds": [],
  "collapsed": false,
  "metadata": {}
}
```

**Errors:**
- `404` - Block not found

**Context Retrieval** (FLO-338, v0.7.42+):

Add `?include=` to get surrounding context in a single request:

```
GET /api/v1/blocks/{id}?include=ancestors,siblings&sibling_radius=3
GET /api/v1/blocks/{id}?include=tree,token_estimate&max_depth=3
GET /api/v1/blocks/{id}?include=children
```

| Include | What it adds |
|---------|-------------|
| `ancestors` | Parent chain up to root (max 10), each with id + content |
| `siblings` | N blocks before/after within parent (default radius: 2) |
| `children` | Direct children (id + content) |
| `tree` | Full subtree DFS (max 1000 nodes), each with id, content, depth |
| `token_estimate` | `{totalChars, blockCount, maxDepth}` |

| Param | Default | Description |
|-------|---------|-------------|
| `sibling_radius` | 2 | Number of siblings before/after to include |
| `max_depth` | 50 | Maximum tree traversal depth |

Root blocks return `{before:[], after:[]}` for siblings. Without `include`, response is the plain block object (backward compatible).

---

### Resolve Short-Hash Prefix

```
GET /api/v1/blocks/resolve/{prefix}
```

Resolve a short hex prefix (git-sha style) to a full block UUID. Used by external tools (floatctl, pi extension, agents) that have 8-char prefixes from "Copy Block ID".

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `prefix` | string (path) | yes | 6+ hex characters, or full UUID |

**Response (unique match):**
```json
{
  "id": "a9cab933-1639-4d3d-9bc9-5f13411d7e12",
  "block": {
    "id": "a9cab933-1639-4d3d-9bc9-5f13411d7e12",
    "content": "Block content",
    "parentId": "...",
    "childIds": [],
    "collapsed": false,
    "blockType": "text",
    "metadata": { ... },
    "createdAt": 1772465715784,
    "updatedAt": 1772856904273
  }
}
```

Note: wraps the block in `{id, block}` so the resolved full UUID is explicit.

**Errors:**
- `400` - Prefix too short (< 6 hex chars) or invalid characters
- `404` - No block matches prefix
- `409` - Ambiguous: multiple blocks match (try a longer prefix)

**Examples:**
```bash
# 8-char prefix (typical from Copy Block ID)
curl -H "Authorization: Bearer $KEY" \
  "http://127.0.0.1:$PORT/api/v1/blocks/resolve/a9cab933"

# Full UUID (redirects to exact lookup)
curl -H "Authorization: Bearer $KEY" \
  "http://127.0.0.1:$PORT/api/v1/blocks/resolve/a9cab933-1639-4d3d-9bc9-5f13411d7e12"
```

---

### Create Block

```
POST /api/v1/blocks
```

**Request Body:**
```json
{
  "content": "New block content",
  "parentId": "optional-parent-id",
  "afterId": "optional-sibling-id",
  "atIndex": 0
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `content` | string | yes | Block content |
| `parentId` | string | no | Parent block UUID (omit for root block) |
| `afterId` | string | no | Insert after this sibling UUID |
| `atIndex` | int | no | Insert at this position (0-based) |

**Positional insertion** (v0.7.29+, FLO-283): `afterId` and `atIndex` are mutually exclusive. If neither is provided, block appends to end of parent's children. If `afterId` is specified, the new block is inserted immediately after that sibling. If `atIndex` is specified, the block is inserted at that index.

**Response:**
```json
{
  "id": "new-block-id",
  "content": "New block content",
  "parentId": "optional-parent-id",
  "childIds": [],
  "collapsed": false,
  "metadata": {}
}
```

---

### Update Block

```
PATCH /api/v1/blocks/{id}
```

**Request Body:**
```json
{
  "content": "Updated content",
  "parentId": "new-parent-id",
  "afterId": "sibling-id",
  "atIndex": 0
}
```

All fields are optional. Supports three operations:

| Operation | Fields | Description |
|-----------|--------|-------------|
| Content update | `content` | Change block text |
| Reparent | `parentId` | Move to new parent (appends to end) |
| Reparent + position | `parentId` + `afterId` or `atIndex` | Move to new parent at specific position |
| Reposition | `afterId` or `atIndex` (no `parentId`) | Reorder within current parent |

**Repositioning** (v0.7.29+, FLO-283): `afterId` and `atIndex` are mutually exclusive. `afterId` cannot reference the block being moved (self-referential moves are rejected).

**Response:** Updated block object

---

### Delete Block

```
DELETE /api/v1/blocks/{id}
```

**Response:**
```json
{"success": true}
```

**Note:** Deleting a block also deletes all its children (subtree deletion).

---

### Search Blocks

```
GET /api/v1/search?q={query}&limit={limit}
```

**Parameters:**
| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `q` | string | `""` | Full-text query (optional — omit for filter-only) |
| `limit` | int | 20 | Max results to return |
| `types` | string | | Comma-separated block types to include (OR logic) |
| `exclude_types` | string | | Comma-separated block types to exclude (MustNot) |
| `has_markers` | bool | | Filter by marker presence |
| `parent_id` | string | | Search within subtree |
| `outlink` | string | | Filter by [[wikilink]] target (exact match) |
| `marker_type` | string | | Filter by marker type (e.g., "project") |
| `marker_val` | string | | Filter by marker value. Joins with marker_type → "type::value" |
| `inherited` | bool | true | When false, use own-only marker fields |
| `created_after` | i64 | | Epoch seconds — block creation time lower bound |
| `created_before` | i64 | | Epoch seconds — block creation time upper bound |
| `ctx_after` | i64 | | Epoch seconds — ctx:: event time lower bound |
| `ctx_before` | i64 | | Epoch seconds — ctx:: event time upper bound |
| `include_breadcrumb` | bool | false | Add parent chain array per hit |
| `include_metadata` | bool | false | Add block metadata per hit |

**Response:**
```json
{
  "hits": [
    {
      "blockId": "abc123-uuid-format",
      "score": 6.59,
      "content": "block text",
      "snippet": "<b>matched</b> text with highlights",
      "breadcrumb": ["grandparent content", "parent content"],
      "metadata": { "extractedAt": 1773379628493, "isStub": false, "markers": [...], "outlinks": [...] }
    }
  ],
  "total": 3
}
```

`snippet` is HTML with `<b>` tags around matched terms (from Tantivy SnippetGenerator). Present for text queries, null for filter-only. `breadcrumb` and `metadata` are only present when the corresponding `include_*` param is true.

**Content preprocessing (v0.9.6):**
- `prefix::value` compounds are stripped from content field — prefix lives in `markers` field only. Value parts kept.
- `[[wikilinks]]` → inner text (brackets stripped)
- Field boost: content 2.0x, markers 1.0x. Prose matches outrank marker-only matches.

---

### Semantic Endpoints (FLO-652)

Semantic siblings of the low-level block CRUD. Hide structural conventions (`pages::` container, daily-note naming) from API consumers so agents don't need to rediscover outline layout rules. Ships in a future floatty-server release; the dev binary already has them.

```
GET  /api/v1/daily/:date              — resolve daily note (existed pre-FLO-652)
POST /api/v1/pages/:name              — upsert page under pages:: (idempotent)
POST /api/v1/daily/:date/append       — append child under daily note, autocreate on miss
```

#### Upsert Page

`POST /api/v1/pages/:name` — body `{}`. Returns a `BlockDto`. **Concurrency-safe**: multiple parallel POSTs for the same name return the same page id.

- `200 OK` when the page existed (case-insensitive match via PageNameIndex)
- `201 Created` on create (autocreates `pages::` container too if absent)
- `400 Bad Request` on empty / whitespace-only name

```bash
curl -X POST -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' -d '{}' \
  "$FLOATTY_URL/api/v1/pages/Shell-Lite%20Spec"
```

#### Append to Daily Note

`POST /api/v1/daily/:date/append` — body `{ "content": "..." }`. Returns the new child's `BlockDto`. Autocreates the daily note (and `pages::`) on first use.

- `201 Created` with the new block
- `400 Bad Request` when `:date` isn't `YYYY-MM-DD` shape (prevents orphan pages) OR content is empty

```bash
curl -X POST -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' \
  -d '{"content":"ctx::quick note"}' \
  "$FLOATTY_URL/api/v1/daily/2026-04-19/append"
```

**Use this instead of** `POST /api/v1/blocks` with a search-resolved parent_id — callers no longer need to know that daily notes live under `pages::` or what their content format looks like. Replaces the old heading-search-plus-create-root-block pattern that silently created orphaned `## $date` blocks ([[FLO-636]] in shell form).

---

### Topology (Graph)

```
GET /api/v1/topology
GET /api/v1/topology/content/:pageName
```

`GET /api/v1/topology` returns a graph-shaped view of the outline for
cross-page analysis:

```json
{
  "n": { ... },   // nodes (pages keyed by name)
  "e": { ... },   // edges (wikilink graph)
  "c": { ... },   // counts per page
  "daily": [...], // daily-note nodes
  "meta": { ... } // generation timestamp, totals
}
```

`GET /api/v1/topology/content/:pageName` returns a page's rendered content
by NAME (no UUID lookup). **Note:** response uses `snake_case`, unlike most
endpoints which are camelCase:

```json
{
  "name": "2026-04-20",
  "lines": [[0, "text"], [1, "child text"], ...],  // (depth, content) pairs
  "block_count": 10
}
```

Case-insensitive match. 404 if the page isn't in PageNameIndex.

```bash
curl -H "Authorization: Bearer $KEY" "$URL/api/v1/topology/content/2026-04-20"
```

Helper: `floatty_page_content` + `floatty_page_content_pretty`.

---

### Vocabulary Discovery

```
GET /api/v1/markers
GET /api/v1/markers/{type}/values
GET /api/v1/stats
```

| Endpoint | Returns |
|----------|---------|
| `GET /api/v1/markers` | Distinct marker types + counts |
| `GET /api/v1/markers/{type}/values` | Values for a marker type (e.g., `/api/v1/markers/project/values`) |
| `GET /api/v1/stats` | Block count, root count, type distribution, metadata coverage |

---

### Search Pages (Page Name Index)

```
GET /api/v1/pages/search
```

Search the page name index for autocomplete. Supports prefix matching and fuzzy matching (nucleo, same algorithm as Helix/fzf).

**Parameters:**
| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `prefix` | string | `""` | Search text — prefix or fuzzy query |
| `limit` | int | 10 | Max results |
| `fuzzy` | bool | false | Use nucleo fuzzy matching (typo-tolerant) instead of prefix matching |

**Response:**
```json
{
  "pages": [
    { "name": "2026-03-09-monday-headlines", "isStub": false },
    { "name": "PR #1682", "isStub": true }
  ]
}
```

`isStub`: true = referenced by `[[wikilink]]` but no page block exists yet.

**Notes:**
- Empty prefix returns all pages alphabetically.
- Prefix matching is case-insensitive and matches from the start of the page name.
- Fuzzy matching scores all pages and returns matches sorted by score (existing pages beat stubs at equal scores).
- Page names are derived from root-level block headings (first line, heading prefix stripped).

**Examples:**
```bash
# All pages
curl -H "Authorization: Bearer $KEY" "$URL/api/v1/pages/search"

# Prefix match
curl -H "Authorization: Bearer $KEY" "$URL/api/v1/pages/search?prefix=2026-03&limit=5"

# Fuzzy match (typo-tolerant)
curl -H "Authorization: Bearer $KEY" "$URL/api/v1/pages/search?prefix=mnday-hedlines&fuzzy=true&limit=5"
```

---

### Presence

```
GET /api/v1/presence
POST /api/v1/presence
```

Track the user's focused block in the outliner. Used by agents to know where the human is.

**GET — Read current presence:**

Returns the last focused block, or `204 No Content` if no presence set or the block was deleted.

**Response (200):**
```json
{
  "blockId": "165bba2a-988b-4ed3-8f73-864394185865",
  "paneId": "pane-2b908f0e-93fd-4e35-a505-995c73c4bd1d"
}
```

**POST — Set presence:**

**Request Body:**
```json
{
  "block_id": "165bba2a-988b-4ed3-8f73-864394185865",
  "pane_id": "pane-2b908f0e-93fd-4e35-a505-995c73c4bd1d"
}
```

**Response:** `200 OK`

**Notes:**
- Presence is broadcast to all WebSocket clients.
- GET validates the block still exists — stale presence returns 204.
- `paneId` is optional (may be null if set without pane context).

---

### Export

```
GET /api/v1/export/binary   — Full Y.Doc as base64 (content-type: application/octet-stream)
GET /api/v1/export/json     — Full outline as JSON
```

One-shot dumps for backup / migration. Helpers: `floatty_export_binary`,
`floatty_export_json`.

---

### Search Index Maintenance

```
POST /api/v1/search/reindex  → { rehydrated: N }
POST /api/v1/search/clear    → 204
```

Tantivy is ephemeral — rebuilt from Y.Doc on app start. These let you
rebuild/clear manually. Helpers: `floatty_search_reindex`, `floatty_search_clear`.

---

### Backup

```
GET  /api/v1/backup/status   — { running, lastBackup, nextBackup, backupCount, totalSizeBytes, backupDir }
GET  /api/v1/backup/list     — all snapshots (hourly/daily/weekly)
GET  /api/v1/backup/config   — { enabled, intervalHours, retainHourly, retainDaily, retainWeekly, backupDir }
POST /api/v1/backup/trigger  — force immediate snapshot
POST /api/v1/backup/restore  — DESTRUCTIVE; body { path: "/path/to/backup.ydoc" }
```

Helpers: `floatty_backup_status`, `floatty_backup_list`, `floatty_backup_config`,
`floatty_backup_trigger`, `floatty_backup_restore`.

---

### Sync / State

```
GET /api/v1/state          — Full Y.Doc base64 (large)
GET /api/v1/state-vector   — Smaller reconciliation vector
GET /api/v1/state/hash     — { hash, blockCount, timestamp } — cheap probe
GET /api/v1/updates?since= — Delta updates since a sequence number
POST /api/v1/update        — Apply a CRDT update
POST /api/v1/restore       — DESTRUCTIVE Y.Doc replacement (needs confirm header)
```

Helper: `floatty_state_hash`. The rest are for frontend sync infrastructure
and rarely useful from helpers.

---

## WebSocket Sync

```
WS ws://localhost:8765/ws
```

Real-time Y.Doc sync for CRDT collaboration. Used by floatty frontend for live updates.

---

## Error Responses

All errors follow this format:

```json
{
  "error": "Error message",
  "code": "ERROR_CODE"
}
```

Common codes:
- `UNAUTHORIZED` - Invalid or missing API key
- `NOT_FOUND` - Block ID doesn't exist
- `BAD_REQUEST` - Invalid request body
- `INTERNAL_ERROR` - Server error
