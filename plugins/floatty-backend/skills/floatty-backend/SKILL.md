---
name: floatty-backend
description: Interact with floatty-server REST API for block CRUD, search, and daily notes. Use when working with floatty outliner data, creating blocks via API, searching content, or managing daily notes programmatically.
---

## Mental Model

This is an **outliner**, not a document database. A block is a **thought unit** — not a line, not a page.

| Right size | Example |
|-----------|---------|
| A paragraph (3-8 lines) | Phase narrative, arc summary |
| A short list with its heading | Mistake list, technique bullets |
| A code example with its label | Technique demo with context |
| A key insight with its markers | `[type::technique]` block |
| A single line | ctx:: marker, heading, bullet point |

**Anti-patterns:**
- 50 blocks of one-liners → unreadable confetti in the outliner
- One block of 800 words → unscrollable wall that can't be collapsed/moved

Blocks CAN contain newlines. A block is a container, not a line. If you're creating >10 blocks for one section, stop and rethink — use parent→child tree structure instead.

Use the parent→child tree to organize:
- Parent block: section heading
- Child block: the content of that section
- Grandchild: a sub-element within that section

When search returns 20 hits, read the full response — don't aggressively filter. When you request children, siblings, ancestors — the cost is trivial. Always request full context.

### Presence — spatial awareness

Agents can read `GET /api/v1/presence` to know where the human is in the outline right now — the `blockId` and `paneId` of their last focused block. Combine with `floatty_block_get` to understand what they're looking at. Returns 204 if no focus or block was deleted.

### Page name index

Pages are root-level blocks with headings. The page name index supports prefix matching and fuzzy matching (nucleo, same algorithm as Helix/fzf). Use `floatty_search_pages_fuzzy` for typo-tolerant autocomplete. Stubs (`isStub: true`) are pages referenced by `[[wikilinks]]` that don't exist yet.

### Deep linking

`floatty://navigate/<page-name>?pane=<uuid>` opens a page in the outliner. The `pane` param routes to a specific linked pane (used by the pi extension). Without `pane`, navigation targets the active tab's outliner.

### Terminal env vars

Agents running inside floatty terminals (Claude Code, pi mono, etc.) automatically get:
- `FLOATTY_PANE_ID` — the terminal's pane UUID (for deep link routing)
- `FLOATTY_URL` — server URL (no config.toml lookup needed)
- `FLOATTY_API_KEY` — API key (no config.toml lookup needed)

## Setup

The scripts self-locate via `BASH_SOURCE`, so you only need to source one —
the others are resolved relative to it. The probe below covers every install
layout the skill ships in:

```bash
# Install layouts (first match wins):
#   Plugin marketplace cache:  ~/.claude/plugins/cache/*/floatty-backend
#   Claude Code --plugin-dir:  any path containing scripts/floatty-api.sh
#   Legacy skill:              ~/.claude/skills/floatty-backend
#   claude.ai:                 /mnt/skills/user/floatty-backend
#                              /mnt/skills/private/floatty-backend
#   Override:                  FLOATTY_SKILL_DIR=/your/path

if [[ -z "$FLOATTY_SKILL_DIR" ]]; then
  for d in \
    "$HOME"/.claude/plugins/cache/*/floatty-backend \
    "$HOME/.claude/skills/floatty-backend" \
    /mnt/skills/user/floatty-backend \
    /mnt/skills/private/floatty-backend; do
    [[ -d "$d/scripts" ]] && { FLOATTY_SKILL_DIR="$d"; break; }
  done
fi
source "$FLOATTY_SKILL_DIR/scripts/floatty-api.sh"
source "$FLOATTY_SKILL_DIR/scripts/floatty-blocks.sh"
source "$FLOATTY_SKILL_DIR/scripts/floatty-search.sh"
source "$FLOATTY_SKILL_DIR/scripts/floatty-daily.sh"
# Optional: garden, context, ops
source "$FLOATTY_SKILL_DIR/scripts/floatty-garden.sh"
source "$FLOATTY_SKILL_DIR/scripts/floatty-ops.sh"
```

After sourcing `floatty-api.sh`, later scripts (blocks/search/daily/garden/
context/ops) auto-source it themselves via a `declare -F floatty_curl` guard, so
re-sourcing is idempotent.

**Server**: `http://127.0.0.1:8765` (local dev/release, override: `FLOATTY_URL` env var). Agents running inside a floatty terminal get `FLOATTY_URL` injected automatically and should use it as-is.
**API Key**: `floatty-1890872e6255d2d0` (override: `FLOATTY_API_KEY` env var)

**jq availability**: `floatty-api.sh` auto-detects jq — checks PATH first, then `/tmp/jq` (where `floatctl` bootstrap installs it in claude.ai sandboxes), then falls back to `apt-get install`. If you've already bootstrapped floatctl, jq is ready.

**CRITICAL — use bash, not sh**: These scripts use bash syntax (`source`, `[[ ]]`, arrays). In claude.ai sandboxes, wrap in `bash -c '...'` or use `#!/usr/bin/env bash`.

**CRITICAL — zsh echo corrupts JSON**: Use `printf '%s'` not `echo` when piping captured output. Or pipe directly: `floatty_search "query" | jq ...`

## Rules

### Prefer the API over reinvention

The server exposes primitives for the operations agents need. If you find
yourself downloading the whole outline (`GET /api/v1/blocks`) to filter it
in Python/jq, stop and check whether an endpoint does it server-side. A
non-exhaustive map (see `references/api-reference.md` for the full list):

| You want to... | Use this helper | Endpoint |
|---|---|---|
| Find a page by title | `floatty_find_page` | `GET /api/v1/pages/search` |
| Prefix-match pages | `floatty_search_pages` | `GET /api/v1/pages/search?prefix=` |
| Fuzzy-match pages | `floatty_search_pages_fuzzy` | `GET /api/v1/pages/search?fuzzy=true` |
| List all pages | `floatty_pages_list` | `GET /api/v1/pages/search?prefix=` |
| Get/resolve today's daily note | `floatty_daily_get` | `GET /api/v1/daily/:date` |
| Append to today's daily note | `floatty_daily_append` | `POST /api/v1/daily/:date/append` (FLO-652, fallback auto) |
| Create/resolve a page by name | `floatty_page_upsert` | `POST /api/v1/pages/:name` (FLO-652) |
| Full-text + structured search | `floatty_search` | `GET /api/v1/search` (20+ filter params) |
| Backlinks (outlink-filtered) | `floatty_search_backlinks` | `GET /api/v1/search?outlink=` |
| Block ancestors + siblings + children | `floatty_block_context` | `GET /api/v1/blocks/:id?include=…` |
| Short-hash → UUID | `floatty_resolve` | `GET /api/v1/blocks/resolve/:prefix` |
| Page content by name (rendered) | `floatty_page_content` | `GET /api/v1/topology/content/:pageName` |
| Whole-outline graph | `floatty_topology` | `GET /api/v1/topology` |
| Vocabulary discovery | `floatty_markers`, `floatty_marker_values`, `floatty_stats` | `GET /api/v1/markers`, `…/values`, `…/stats` |
| Where's the user looking? | `floatty_presence`, `floatty_presence_context` | `GET /api/v1/presence` |
| Backup status / trigger | `floatty_backup_status`, `floatty_backup_trigger` | `GET/POST /api/v1/backup/…` |
| Rebuild search index | `floatty_search_reindex` | `POST /api/v1/search/reindex` |

**The test**: before writing a helper that pulls `GET /api/v1/blocks` + Python
filter, grep `routes` in `apps/floatty/src-tauri/floatty-server/src/api/*.rs`
for the operation. The API has grown significantly — a helper written six
months ago may be reinventing something that now has a dedicated endpoint.

### Search: always read the full response

`floatty_search` returns breadcrumbs + metadata by default. Every hit includes:

- `.breadcrumb` — where the block lives in the tree (LOCATION)
- `.metadata.markers` — parsed `ctx::`, `project::`, `mode::` etc (STRUCTURED TAGS)
- `.metadata.outlinks` — parsed `[[wikilinks]]` (GRAPH EDGES)
- `.score` — BM25 relevance (RANKING)

These are the navigation layer. Do not jq-filter them out. Do not select only `.content`. If you strip the metadata, you lose the graph and will need extra API calls to recover what you already had.

```
WRONG: floatty_search "query" | jq '.hits[] | .content'
RIGHT: floatty_search "query"   (read the full JSON)
```

### Backlinks: use outlinks metadata, not text matching

`floatty_search_backlinks "Page Title"` searches for `[[Page Title]]` and filters results to blocks whose `.metadata.outlinks` actually contain the target. This separates real backlinks from BM25 text-match noise. Do not manually search for page titles and then write Python to check if the text appears in content.

### Block context: always include

`floatty_block_get` includes ancestors + children by default. For timeline context (what came before/after), use `floatty_block_context` which adds siblings.

Do not use lean variants (`floatty_search_lean`, `floatty_block_get_lean`) unless piping IDs to another command. You lose the graph.

### Block ID given — use it, don't search for it

When user provides a block ID like `[[5b6684d2]]` in their message, you HAVE the ID. Use it directly.

1. Try helper: `floatty_block_get 5b6684d2`
2. If 404 → try direct curl: `curl -s -H "Authorization: Bearer $FLOATTY_API_KEY" "$FLOATTY_URL/api/v1/blocks/5b6684d2"`
3. If still 404 → get full UUID from presence (if user is focused on it): `floatty_presence` → use returned `blockId` for direct lookup
4. **NEVER** search by content/page name when you already have the ID
5. **NEVER** declare "block doesn't exist" when user just referenced it — your resolution is broken, not their block
6. Max 3 resolution attempts before asking user for the full UUID

### Don't chain resolve → block_get → page

`floatty_page` handles resolution internally. Go straight to `floatty_page <prefix>` when you want the tree. The chain `floatty_resolve` → `floatty_block_get` → `floatty_page` wastes 2 calls — resolve and block_get are redundant because page does both.

Use `floatty_resolve` only when you need just the ID (e.g., for a PATCH or DELETE).
Use `floatty_block_get` only when you need ancestors+children but not the full tree.

### The graph walk

To build a picture of any block:

1. `floatty_search "query"` — read full hits (breadcrumb = location, metadata = edges)
2. `floatty_search_backlinks "Page Title"` — what points here (filtered by outlinks)
3. `floatty_block_context $ID 3` — the block + ancestors + siblings + children
4. Follow `.metadata.outlinks` as next hops — each is a ready-made wikilink target

This is 2-4 API calls. Do not build elaborate Python post-processing pipelines.

## Common Operations

```bash
# Full page tree from short-hash — ONE call (resolve is built-in)
floatty_page 5696d8b9

# Formatted summary for quick scan (default 50 blocks visible)
floatty_page_pretty 5696d8b9

# Only use floatty_resolve when you need just the ID, not the tree
floatty_resolve 5696d8b9

# Search (returns breadcrumbs + metadata by default)
floatty_search "ctx::2026-03-11"

# Search formatted for display
floatty_search_context "intent primitives"

# Find backlinks (filtered by outlinks metadata)
floatty_search_backlinks "PR #1682"

# Block with ancestors + children
floatty_block_get $ID

# Block with ancestors + siblings + children (timeline context)
floatty_block_context $ID 3

# Get today's daily note (uses PageNameIndex, not search)
floatty_daily_get
floatty_daily_get "2026-03-31"
floatty_daily_get "2026-03-31" "tree,token_estimate"

# Add entry to today's daily note
floatty_daily_add "Fixed scroll yanking bug"

# Create TLDR
floatty_tldr "session summary" "what I did" "what I learned" "next steps"

# ─── Filter Search (v0.9.2 — Tantivy field filters) ───

# All blocks with project:: markers
floatty_search_by_marker "project"

# Blocks linking to a specific issue
floatty_search_by_outlink "FLO-483"

# ctx:: markers in a date range (seconds, not ms!)
START=$(date -j -f "%Y-%m-%d" "2026-03-14" "+%s")
END=$(date -j -f "%Y-%m-%d" "2026-03-16" "+%s")
floatty_search_ctx_range $START $END

# Blocks created in last 24h
floatty_search_created_range $(($(date +%s) - 86400))

# Filter-only search (no text query, just filters)
floatty_search_filter "marker_type=project&has_markers=true"

# ─── Page Search (nucleo fuzzy + prefix matching) ───

# List all pages
floatty_pages_list

# Search pages by prefix
floatty_search_pages "2026-03"

# Fuzzy search — typo-tolerant (same algorithm as Helix/fzf)
floatty_search_pages_fuzzy "mnday-hedlines"

# Pretty-print page results
floatty_search_pages_pretty "headlines"

# ─── Presence (where is the human?) ───

# Get user's current focused block
floatty_presence

# Get focused block with full surrounding context
floatty_presence_context 3
```

## Search API Parameters

For queries needing params not exposed by helpers, use `floatty_curl` directly:

| Param | Default | Purpose |
|-------|---------|---------|
| `q` | required | Search text (can be empty string for filter-only) |
| `limit` | 20 | Max results |
| `include_breadcrumb` | true (via helper) | Parent chain per hit — `list[string]` of ancestor block content (nearest parent last), NOT just page names. e.g. `["pages::", "# 2026-04-20"]`. |
| `include_metadata` | true (via helper) | Markers + outlinks per hit |
| `types` | all | Filter by block type prefix (`sh,ai`) |
| `has_markers` | false | Only blocks with `::` annotations |
| `parent_id` | all | Search within a subtree |
| `marker_type` | all | Filter by marker prefix (`project`, `ctx`, `mode`, etc.) |
| `marker_val` | all | Filter by marker value (requires `marker_type`). e.g. `marker_type=project&marker_val=floatty` |
| `inherited` | true | Set `false` to exclude inherited markers (own-only). Default includes both. |
| `outlink` | all | Filter blocks containing `[[outlink]]` target (e.g., `outlink=FLO-483`) |
| `created_after` | none | Unix timestamp in **seconds** (local TZ) — blocks created after |
| `created_before` | none | Unix timestamp in **seconds** (local TZ) — blocks created before |
| `ctx_after` | none | Unix timestamp in **seconds** — blocks with `ctx::` datetime after |
| `ctx_before` | none | Unix timestamp in **seconds** — blocks with `ctx::` datetime before |

**Filter-only search** (v0.9.3): `q` is now fully optional. Omit it entirely or pass empty — both work with any filter combination.

```bash
# All blocks with project:: markers
floatty_curl "$FLOATTY_URL/api/v1/search?q=&marker_type=project&limit=20&include_metadata=true"

# Blocks linking to a specific issue
floatty_curl "$FLOATTY_URL/api/v1/search?q=&outlink=FLO-483&include_breadcrumb=true"

# ctx:: markers in a date range (seconds, not ms)
START=$(date -j -f "%Y-%m-%d" "2026-03-14" "+%s")
END=$(date -j -f "%Y-%m-%d" "2026-03-16" "+%s")
floatty_curl "$FLOATTY_URL/api/v1/search?q=ctx&ctx_after=$START&ctx_before=$END"

# Combined: text + marker filter
floatty_curl "$FLOATTY_URL/api/v1/search?q=PR%20%231764&marker_type=project&include_breadcrumb=true"
```

## Vocabulary Discovery (v0.9.3)

Discover what markers and values exist in the outline without searching:

```bash
# What marker types exist? (project, ctx, mode, issue, sh, sc, sysop, ...)
floatty_curl "$FLOATTY_URL/api/v1/markers"

# What values exist for a marker type?
floatty_curl "$FLOATTY_URL/api/v1/markers/project/values"
# → {markerType: "project", total: 12, values: [{value: "floatty", count: 352}, ...]}

# Outline stats (block count, marker coverage, type distribution)
floatty_curl "$FLOATTY_URL/api/v1/stats"
```

Use `/markers/:type/values` to answer "what projects exist?" without guessing search terms. Use `/stats` for outline health checks.

## Page Search API Parameters

| Param | Default | Purpose |
|-------|---------|---------|
| `prefix` | `""` | Search text (prefix or fuzzy query) |
| `limit` | 10 | Max results |
| `fuzzy` | false | Use nucleo fuzzy matching instead of prefix |

```bash
# Direct curl for page search
floatty_curl "$FLOATTY_URL/api/v1/pages/search?prefix=monday&fuzzy=true&limit=5"
```

## Block Context Parameters

`GET /api/v1/blocks/:id` accepts `include=` for surrounding context:

| Include | What you get |
|---------|-------------|
| `ancestors` | Parent chain up to root (max 10) |
| `siblings` | N blocks before/after (`sibling_radius=N`, default 2) |
| `children` | Direct children (id + content) |
| `tree` | Full subtree DFS (max 1000 nodes) |
| `token_estimate` | totalChars, blockCount, maxDepth |

Combine freely: `?include=ancestors,children,siblings,token_estimate&sibling_radius=5`

## Field Naming

| Context | ID field | Why |
|---------|----------|-----|
| Block CRUD | `.id` | Primary key — this IS the block |
| Search hit | `.blockId` | Foreign key — REFERENCES a block |

When piping search results to block CRUD: `.blockId` → the ID param.

## Metadata — What Hooks Auto-Extract

Every block can have `.metadata` populated by frontend hooks:

**Markers**: `ctx`, `project`, `mode`, `todo`, `sysop`, `meeting`, `dispatch`, any custom `prefix::`. Bare prefixes have no `.value`. Tag markers (`project::floatty`) have `.value`.

**Outlinks**: `[[wikilink]]` targets as strings. These are the graph edges — use them to navigate, not to parse from content.

## Door-Block Markdown Projection (FLO-633)

Door blocks (`outputType === "door"`) are agent-written structured views — a JSON element graph at `output.data.spec`. Raw spec JSON is verbose and hard to consume. Use `.metadata.renderedMarkdown` instead — it's a text projection optimized for agents (~0.19× the token cost of the raw spec).

`GET /api/v1/blocks/:id` always returns a non-null `renderedMarkdown` for door blocks with non-empty output. Four-layer fallback applied server-side:

1. `output.data.normalizedMarkdown` (future)
2. Frontend-hook `metadata.renderedMarkdown` (preferred when present)
3. Server-side Rust walker over `output.data.spec`
4. Generic JSON flattener (last resort)

The server fills tiers 3–4 on read when tiers 1–2 produced nothing. **Cache is content-addressed** — mutating the block's output invalidates the cached markdown automatically.

**Agent rules**:
- ✅ Read `.metadata.renderedMarkdown` first. It's the agent-friendly view.
- ✅ Fall back to `output.data.spec` only if you need the structured graph (e.g., programmatically re-rendering).
- ❌ Don't parse `output.data.agentRaw` — that's a debug field, not a contract.
- ❌ Don't expect `renderedMarkdown` on bulk reads (`GET /api/v1/blocks`) — bulk endpoints skip the projection to avoid N× walker cost. Use per-block GETs when you need markdown for multiple doors.
- ❌ Don't expect `renderedMarkdown` on search hits — search returns a `BlockSearchHit` DTO with partial metadata, not a full `BlockDto`. Follow up with `floatty_block_get` on the `.blockId` if you need the markdown.

## References

Read these when you need detail beyond what's above:

- **[helpers.md](references/helpers.md)** — Full helper function reference with all params and return shapes
- **[api-reference.md](references/api-reference.md)** — Raw HTTP endpoint docs, request/response shapes, error codes
- **[workflows.md](references/workflows.md)** — Common workflow patterns (brain boot, session capture, gardening)

## Troubleshooting

**"Invalid API key"**: Default is `floatty-1890872e6255d2d0`. Check server matches. Override with `FLOATTY_API_KEY`.
**No blocks**: Verify server: `curl -s -H "Authorization: Bearer floatty-1890872e6255d2d0" http://127.0.0.1:8765/api/v1/health`
**Empty search**: Tantivy index may need time to sync. Try broader terms.
**Block prefix returns 404 but block exists**: Helper scripts are wrappers. If they fail, try direct `curl` to the same endpoint. If prefix resolution fails but full UUID works, there may be an index sync delay — use `floatty_presence` to get the full UUID when user is focused on the block.
**Daily note not found**: `floatty_daily_add` now returns an explicit error when today's daily note doesn't exist ([[FLO-636]] behaviour — no more silent root-block creation). Open floatty and click `[[YYYY-MM-DD]]` to create the daily note under `pages::`, then retry. Once the FLO-652 endpoints ship in a release, a follow-up will add `floatty_daily_append_via_api` that autocreates via `POST /api/v1/daily/:date/append`.
