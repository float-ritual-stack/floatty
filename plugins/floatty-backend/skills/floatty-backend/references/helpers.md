# Helper Script Reference

## Search Operations (`floatty-search.sh`)

`floatty_search` now defaults to rich (breadcrumbs + metadata). Use `floatty_search_lean` only when piping IDs.

| Helper | Returns | Notes |
|--------|---------|-------|
| `floatty_search <query> [limit]` | Full hits: blockId, score, content, breadcrumb, metadata | Default. Always use this. |
| `floatty_search_rich <query> [limit]` | Alias for `floatty_search` | Backward compat |
| `floatty_search_lean <query> [limit]` | blockId, score, content only | For piping IDs. You lose the graph. |
| `floatty_search_pretty <query>` | One-liner per hit (ID, score, snippet) | Display only |
| `floatty_search_context <query> [limit]` | Formatted output with breadcrumbs, markers, outlinks | Human-readable |
| `floatty_search_markers <marker> [value]` | Rich results filtered by marker | |
| `floatty_search_ids <query>` | Just block UUIDs | Uses lean. For piping. |
| `floatty_search_backlinks <page>` | Blocks whose metadata.outlinks contain the page | Filters out BM25 text-match noise |

### Page Search (`floatty-search.sh`)

Uses the page name index (nucleo fuzzy matching). Pages are root-level blocks with headings.

| Helper | Returns | Notes |
|--------|---------|-------|
| `floatty_search_pages <prefix> [limit]` | Pages matching prefix | Case-insensitive start-of-name |
| `floatty_search_pages_fuzzy <query> [limit]` | Pages matching fuzzy query | Typo-tolerant, nucleo scoring |
| `floatty_pages_list [limit]` | All pages | Empty prefix, default 50 |
| `floatty_search_pages_pretty <query> [limit]` | Formatted one-liner per page | Shows stub status |

### Presence (`floatty-search.sh`)

Where is the human in the outline right now?

| Helper | Returns | Notes |
|--------|---------|-------|
| `floatty_presence` | `{ blockId, paneId }` JSON or empty | Returns 1 if no presence |
| `floatty_presence_context [radius]` | Focused block + ancestors + siblings + children | Combines presence + block_get |

**Not exposed by helpers**: `types` filter, `has_markers` filter, `parent_id` scoping. Use `floatty_curl` directly:

```bash
floatty_curl "$FLOATTY_URL/api/v1/search?q=TODO&parent_id=$PAGE_ID&has_markers=true&include_breadcrumb=true&include_metadata=true"
```

## Block Operations (`floatty-blocks.sh`)

`floatty_block_get` now includes ancestors + children by default. Use `floatty_block_get_lean` for CRUD piping.

| Helper | Returns | Notes |
|--------|---------|-------|
| `floatty_resolve <prefix>` | Full UUID + block data | Short-hash → block |
| `floatty_page <prefix_or_id> [depth]` | Full page tree as raw JSON + token estimate | Returns everything. Blocks are lines — 400-block daily = ~15K chars. |
| `floatty_page_pretty <prefix_or_id> [max_blocks] [depth]` | Formatted tree summary (default 50 blocks visible) | For quick scans. Use `floatty_page` when you need the full data. |
| `floatty_block_get <id>` | Block + ancestors + children | Default. Always use this. |
| `floatty_block_get_lean <id>` | Block only, no context | For CRUD piping. |
| `floatty_block_context <id> [radius]` | Block + ancestors + siblings + children | Use when you need timeline (siblings = before/after) |
| `floatty_block_tree <id> [depth]` | Full subtree DFS + token estimate | |
| `floatty_block_create <content> [parent_id]` | New block | No positional control — use raw curl with `afterId`/`atIndex` |
| `floatty_block_create_tree <header> <child1>...` | Block + flat children | |
| `floatty_blocks_list [filter]` | All blocks, optionally grepped | |

## Context Retrieval (`floatty-context.sh`)

Run as: `$FLOATTY_SKILL_DIR/scripts/floatty-context.sh <command>`

| Command | Purpose |
|---------|---------|
| `today [limit]` | Today's ctx:: markers with metadata |
| `yesterday [limit]` | Yesterday's ctx:: markers |
| `project <n> [limit]` | Blocks for a project |
| `sysop-notes [limit]` | sysop::note captures |
| `todos [limit]` | todo:: items |
| `meeting <type> [limit]` | Meeting blocks |
| `search-ctx <query> [limit]` | Search with formatted breadcrumb context |
| `block <id>` | Block content by ID (lean — just .content) |
| `context <id> [radius]` | Full context via include param |
| `tree <id> [depth]` | Subtree with token estimate |

## Daily Workflows (`floatty-daily.sh`)

| Helper | Endpoint | Purpose |
|--------|----------|---------|
| `floatty_daily_get [date] [include]` | `GET /api/v1/daily/:date` | Fetch a daily note (children by default; pass `tree` for full subtree) |
| `floatty_daily_append <content> [date]` | `POST /api/v1/daily/:date/append` (FLO-652) | Append a child block under the daily note. Autocreates the daily note on FLO-652-capable servers. On release v0.11.10 (which predates FLO-652) falls back to `floatty_daily_find_or_create + floatty_block_create`, which errors if the daily note is missing. |
| `floatty_daily_add <content> [project] [mode]` | (via `floatty_daily_append`) | Timestamped entry, adds `[project::X] [mode::Y]` markers |
| `floatty_tldr <summary> [did] [learned] [next] [project]` | (via `floatty_daily_append` + `floatty_block_create`) | TLDR block tree under today's daily note |
| `floatty_daily_find_or_create [date]` | `GET /api/v1/daily/:date` | Returns daily note UUID; errors if not found (for manual scripts) |
| `floatty_page_upsert <name>` | `POST /api/v1/pages/:name` (FLO-652) | Get-or-create a page. 200 if exists, 201 if new, 404 + explicit error on pre-FLO-652 servers. |
| `floatty_daily_create [date]` | `POST /api/v1/blocks` | DEPRECATED (FLO-636) — creates a `## $date` root block. Kept for backward compat only; prefer `floatty_page_upsert`. |
| `floatty_ctx <message> [project] [mode]` | (via `floatty_daily_add`) | Quick ctx:: capture to today's daily |

## Gardening (`floatty-garden.sh`)

| Helper | Endpoint(s) | Purpose |
|--------|-------------|---------|
| `floatty_find_page <title>` | `GET /api/v1/pages/search` | Resolve page title to `{id, name, isStub}`. Uses PageNameIndex (server-side, ~27ms vs ~180ms for the old full-block download). |
| `floatty_find_blocks <term>` | `GET /api/v1/blocks` + jq `ascii_downcase \| contains` | Find blocks by literal content substring. No endpoint exists for this yet — full outline scan. |
| `floatty_sort_children <parent_id> [--dry-run]` | `GET /api/v1/blocks` + `PATCH ... atIndex/afterId` | Alphabetical sort of a block's children |
| `floatty_dedup_pages [--dry-run]` | `GET /api/v1/blocks` (dry-run); adds `GET /api/v1/search?outlink=` for wikilink rewrites (merge path) | Find and optionally merge `# Title` duplicates. Intentionally scans all blocks — PageNameIndex would miss `# Title` blocks parented outside the `pages::` container (which are the merge targets we care about). |
| `floatty_dedup_sh [--dry-run]` | `GET /api/v1/blocks` | Find duplicate `sh::` blocks |
| `floatty_orphan_sweep [--fix]` | `GET /api/v1/blocks` | Report childIds pointing at missing blocks |

## Operations (`floatty-ops.sh`)

| Helper | Endpoint | Purpose |
|--------|----------|---------|
| `floatty_topology` | `GET /api/v1/topology` | Whole-outline graph: `{ n: nodes, e: edges, c: counts, daily, meta }` |
| `floatty_page_content <name>` | `GET /api/v1/topology/content/:pageName` | Page content by NAME. Response: `{ name, lines: [[depth, text]], block_count }` (snake_case — unlike most endpoints). |
| `floatty_page_content_pretty <name>` | (via `floatty_page_content`) | Indented outline rendering |
| `floatty_state_hash` | `GET /api/v1/state/hash` | `{ hash, blockCount, timestamp }` — cheap sync health check |
| `floatty_export_binary` | `GET /api/v1/export/binary` | Download full Y.Doc as base64 |
| `floatty_export_json` | `GET /api/v1/export/json` | Download full outline as JSON |
| `floatty_search_reindex` | `POST /api/v1/search/reindex` | Force Tantivy rebuild from Y.Doc → `{ rehydrated: N }` |
| `floatty_search_clear` | `POST /api/v1/search/clear` | Clear the search index (follow with reindex) |
| `floatty_backup_status` | `GET /api/v1/backup/status` | Running / last / next / count / size / dir |
| `floatty_backup_list` | `GET /api/v1/backup/list` | All hourly/daily/weekly snapshots |
| `floatty_backup_trigger` | `POST /api/v1/backup/trigger` | Force an immediate snapshot |
| `floatty_backup_config` | `GET /api/v1/backup/config` | Retention settings |
| `floatty_backup_restore <path>` | `POST /api/v1/backup/restore` | DESTRUCTIVE — replace Y.Doc from a snapshot |
