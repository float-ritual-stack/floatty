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

| Helper | Purpose |
|--------|---------|
| `floatty_daily_create [date]` | DEPRECATED (FLO-636) — creates a `## $date` root block instead of the canonical `# $date` page under `pages::`. Prints a warning; open floatty and click `[[YYYY-MM-DD]]` instead. Kept for backward compat only. |
| `floatty_daily_add <content>` | Add timestamped entry to today's daily note. Errors if the daily note doesn't exist yet (FLO-636 — no more silent root-block creation). Create the page in floatty first. |
| `floatty_tldr <summary> [did] [learned] [next]` | Create TLDR block tree |

## Gardening (`floatty-garden.sh`)

| Helper | Purpose |
|--------|---------|
| `floatty_find_page <title>` | Resolve page title to UUID |
| `floatty_find_blocks <term>` | Find blocks by content substring |
| `floatty_sort_children <parent_id> [--dry-run]` | Alphabetical sort |
| `floatty_dedup_pages [--dry-run]` | Merge duplicate pages |
| `floatty_dedup_sh [--dry-run]` | Merge duplicate sh:: blocks |
| `floatty_orphan_sweep [--fix]` | Fix dangling childId references |
