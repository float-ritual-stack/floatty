# floatty-server API Reference

Auth required. Config: `~/.floatty-dev/config.toml` (dev) or `~/.floatty/config.toml` (prod).

```bash
KEY=$(grep '^api_key' ~/.floatty-dev/config.toml | cut -d'"' -f2)
PORT=$(grep '^server_port' ~/.floatty-dev/config.toml | cut -d= -f2 | tr -d ' ')
```

**Remote mode (FLO-762)**: when `remote_server_url` is set in config.toml, there is no local server — use that URL instead of `127.0.0.1:$PORT` (same `$KEY`; local key matches the remote's). Inside floatty terminals, prefer the injected `FLOATTY_URL` + `FLOATTY_API_KEY` env vars, which are correct in both modes.

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

### Writing `render::` blocks (agents: include a title)

`POST /api/v1/blocks` with `render:: {spec}` content works — the client picks it
up and executes it automatically, no Enter required. **Include a title marker:**

```bash
curl -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"content":"render:: [title:: Friday Sweep] {\"root\":\"r\",\"elements\":{…}}","parentId":"…"}' \
  "$URL/api/v1/blocks"
```

Without `[title:: …]`, the title is fetched by a **second async LLM call** after
the spec renders, so the block shows raw spec JSON in the editor until it lands
(and permanently if it fails). With the marker the title is set synchronously —
no race, no extra round trip. `PATCH` cannot set `output`, so the content marker
is the only lever an API caller has.

Full rationale + the three title-resolution paths: `.claude/rules/render-door-agent.md`
§"Titles: `[title:: …]` makes a `render::` write atomic".

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
  content truncated to 200 bytes (UTF-8-safe — chars whose entire byte
  range fits under the limit are kept; a char starting under-limit but
  extending past it is dropped). Recursive classification is
  intentionally NOT carried — clients re-classify each preview locally
  if `nav_classification` is also opted in.
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
| `children_preview` | First N child block_id+content (truncated to 200 bytes, UTF-8-safe) | N×1 yrs Map lookup; default 5, cap 20. ~1KB/hit when N=5 (`&children_preview_count=N`) |
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

## Path Addressing (ADR-008)

Multi-segment `page > section > block` addressing — resolve a path to a block (read) or `mkdir -p` a path and write under it. Grammar (ADR-008 D1): the target splits on **whitespace-delimited `>`** at top level (`[[`/`]]` depth-guarded). Bare `a>b` / `Vec<String>` do NOT split. Segment 1 is always a page.

**Not the same as `/api/v1/blocks/resolve/:prefix`** (Short-Hash Resolution, above): that resolves ONE short hex block-id prefix to a full UUID; `/api/v1/resolve` walks a multi-segment `>`-delimited *path* down the child tree. Different input, different job, colliding name — flagged by review.

### Resolve a Path (read) — `GET /api/v1/resolve`

`GET /api/v1/resolve?path=<url-encoded path>&mode=fuzzy|exact` — resolve a path to a block. Read-only: **never creates** (agents create via `POST /api/v1/path`).

| Param | Type | Description |
|-------|------|-------------|
| `path` | String (query) | The `>`-delimited path, URL-encoded. Query param, not a path param — `>` in a URL path segment is encoding pain. |
| `mode` | String | `fuzzy` (default) or `exact`. Absent → fuzzy. Any other value → 400. |

- **fuzzy** (nav/read shape): each segment is a **descendant** selector — may skip levels. Per-segment fuzzy ladder: exact → markdown-stripped → contains (ci, marker-stripped) → marker-value. Cross-level composition (ADR-008 D2): rung → depth-proximity → recency (`updatedAt`) → oldest-`createdAt`.
- **exact** (mirrors the write predicate): **direct-child only**, no skipping, exact-canonicalized match per segment.

Segment 1 resolves via `PageNameIndex` (case-insensitive, oldest-`createdAt`), with a `pages::` container scan fallback for the async-hook-lag window (a just-created page still resolves).

**Miss policy (ADR-008 D3):**
- **404** ONLY when segment 1 (the page) misses on BOTH the index and scan tiers — no junk-page creation from a read.
- **200 with `resolved: false`** on a partial miss deeper in the path: lands at the deepest-resolved block, `unresolved` carries the tail, `termination: "partial_miss"` — an agent sees how far the address got.
- **400** on empty `path` or an invalid `mode`.

Response (camelCase JSON):
```json
{
  "resolved": true,
  "mode": "fuzzy",
  "segments": ["Demo Page", "Section B", "C"],
  "trace": [
    { "segment": "Demo Page", "blockId": "page-uuid", "rung": 1, "rungName": "exact" },
    { "segment": "Section B", "blockId": "sec-uuid",  "rung": 2, "rungName": "markdownStripped" },
    { "segment": "C",         "blockId": "c-uuid",    "rung": 1, "rungName": "exact" }
  ],
  "deepestResolvedId": "c-uuid",
  "unresolved": [],
  "termination": "resolved",
  "block": { "id": "c-uuid", "content": "...", "ancestorContext": { } }
}
```
- `trace` — per RESOLVED segment, page first, in path order; only resolved segments appear. `rung` 1–4 → `rungName` `exact` / `markdownStripped` / `contains` / `marker`. The page segment is always rung 1.
- `deepestResolvedId` — the deepest block that resolved (== the leaf on success).
- `termination` — `resolved` | `partial_miss` | `cap` (fuzzy visited-cap exhausted, ~1000) | `cycle`.
- `block` — the resolved (or deepest-resolved) block in `BlockDto` shape, always-on `ancestorContext` (`effectiveMarkers` included).

**Quoting: `>` is shell redirection — always quote it.** Two safe idioms:
```bash
# (a) let curl percent-encode — single-quote each value so the shell leaves `>` alone
curl -G -H "Authorization: Bearer $KEY" \
  --data-urlencode 'path=Demo Page > Section B > C' \
  --data-urlencode 'mode=fuzzy' \
  "http://127.0.0.1:$PORT/api/v1/resolve"

# (b) pre-encoded query string — %20 for space, %3E for `>`
curl -H "Authorization: Bearer $KEY" \
  "http://127.0.0.1:$PORT/api/v1/resolve?path=Demo%20Page%20%3E%20Section%20B&mode=exact"
```

### Write to a Path — mkdir-p — `POST /api/v1/path` (FLO-796)

`POST /api/v1/path` — write `content` to a block under the location addressed by `path`, creating every missing intermediate along the way (`mkdir -p`). Extends the FLO-652 semantic-endpoint family (`api/discovery.rs`).

Body (camelCase + `deny_unknown_fields`):
```json
{ "path": "Demo Page > Section B > Notes", "content": "the block body" }
```

Write matcher (ADR-008 D2): **exact-canonicalized, direct-child, no level-skipping**; oldest-`createdAt` wins among duplicate siblings — this is `match_exact`, literally rung 1 of the read ladder, so write-then-read round-trips land in the same block. Segment 1 reuses the FLO-652 page find-or-create; segments 2..N are exact direct-child find-or-create; then the content block is appended as a child under the resolved leaf segment.

**Idempotent (ADR-008 D7):** exact find-or-create per segment → a re-POST of the same `path` creates zero new intermediates (only ever a fresh leaf content block). N segments = N Yrs transactions + N WS broadcasts, no batch machinery — partial failure leaves a usable prefix and a retry converges.

Response — **201 Created**:
```json
{
  "block": { "id": "leaf-content-uuid", "content": "the block body", "ancestorContext": { } },
  "chain": ["page-uuid", "sectionB-uuid", "notes-uuid"]
}
```
- `block` — the created content block (`BlockDto`, always-on `ancestorContext`).
- `chain` — the resolved/created path spine, **rootmost-first** (page → … → leaf segment). Address any intermediate directly without a follow-up walk. The content block is NOT in `chain` — it's the child appended under the last chain entry.

**400 Bad Request** when:
- `path` is empty/whitespace, or `content` is empty/whitespace.
- the path parses OPAQUE while carrying a would-be top-level `>` separator (`a >  > b`, `a >`) — a malformed multi-segment path is rejected rather than creating a page literally titled with the broken string. (A no-separator name like `Vec<String>` or `a>b` stays a legitimate single-page address.)

```bash
# single-quoted JSON body — the shell never sees `>` as redirection
curl -X POST -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"path":"Demo Page > Section B > Notes","content":"ctx::mkdir-p write"}' \
  "http://127.0.0.1:$PORT/api/v1/path"
```

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
| `/api/v1/state-diff` | POST | State-vector PULL diff (`{ stateVector: "<base64>" }` → `{ update, latestSeq, epoch }`) |
| `/api/v1/state/hash` | GET | SHA256 hash + block count |
| `/api/v1/update` | POST | CRDT merge (`{ update: "<base64>" }`) |
| `/api/v1/restore` | POST | **DESTRUCTIVE** — replace Y.Doc (`{ state: "<base64>" }`, requires `X-Floatty-Confirm-Destructive: true`) |
| `/api/v1/export/binary` | GET | Download `.ydoc` file |
| `/api/v1/export/json` | GET | Download JSON export |
| `/api/v1/health` | GET | Version + git info (no auth) |

`/update` = CRDT merge (no-op if server ahead). `/restore` = nuclear replacement.

### `POST /api/v1/state-diff` (fast-boot Phase 0)

The symmetric partner of the state-vector PUSH (`Y.encodeStateAsUpdate(doc, serverSV)` → `POST /update`). Send `Y.encodeStateVector(localDoc)`; get back only the ops you lack.

```bash
curl -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"stateVector":"<base64>"}' "http://127.0.0.1:$PORT/api/v1/state-diff"
# → { "update": "<base64>", "latestSeq": 4211, "epoch": 0 }
```

- **Survives compaction.** It diffs against actual doc state, not the seq log — unlike `GET /updates?since=N`, which 410s once the server compacts past the client's last seq and forces a full-state refetch.
- **An empty state vector returns the full state** (equivalent to `GET /state`), so it is safe as a cold-cache boot path.
- **An up-to-date client gets an empty update** (2-byte v1 header). The client-side "carries real ops" threshold is `> 2` bytes.
- **`latestSeq` / `epoch` are captured under the SAME doc read guard as the encode** — a mispaired seq would let a client seed its baseline past an update the diff doesn't contain. `epoch` mismatch means the diff crosses a `/restore` boundary: hard-reset (adopt), never merge.
- Request body is **camelCase + `deny_unknown_fields`** — `state_vector` is a 422, not a silent field-drop into an empty vector (which would masquerade as a full refetch).

## Ghost Writer Path

REST write → Persist SQLite (FIRST) → Apply Y.Doc → Broadcast WS.
Risk: non-atomic persist→broadcast. Mitigated by 120-sec health check detecting block count drift.

## Binary Import

```bash
npx tsx scripts/binary-import.ts ~/path/to/backup.ydoc
```
