# Outline Interpretation — How to Read Blocks Without Misdiagnosing Them

Two recurring agent misconceptions about the floatty outline, both caught live 2026-07-17 during a topology review. Read this before making ANY claim about outline health, block connectivity, or "orphaned/disconnected" content.

## Misconception 1: block = document = full note

**Wrong**: treating every block as a standalone note and concluding "nothing links to/from this block, it's disconnected/unimportant."

**Reality**: many blocks are **structural** — section headers, connective tissue, list scaffolding. Worked example: [[3ca5e78d]] is `## The Ask` inside the FLO-375 page. Inbound links: ~0. Outbound: ~0. That is *correct and expected* — its identity is its **ancestor chain** (`pages:: → FLO-375 → …`) and its **subtree** (14 blocks of actual content), not its link topology.

**How to tell what you're looking at** — the API already carries the interpretive tools; use them instead of link counts:

| Signal | Where | What it tells you |
|---|---|---|
| `ancestorContext.kind` | `?include=nav_classification` (search) / always-on (`/blocks/:id`) | `nav_node` vs `content_block` vs `leaf_marker` |
| `ancestorContext.nearestPageName` | always-on | which document this block belongs to |
| `ancestorContext.subtreeSize` | always-on | header-with-substance vs empty stub |
| `ancestorContext.ancestorBlockIds` | always-on | the chain that gives the block meaning |

A block's unit-of-meaning is usually its **nearest page**, not itself. Judge connectivity at the page level.

## Misconception 2: high stub count = graph rot

**Wrong**: flagging a large ref-only count (e.g. topology showing 1,100 stubs vs ~400 real pages) as "dangling-address mass" or a health problem.

**Reality**: stubs are **lazy addresses, by design**. Evan's workflow: content gets slurped in and deleted often; "jump to a backlink, it's empty, run a command to populate it" is routine. A `[[FLO-375]]` reference doesn't need a permanent home in the outline — the reference is the durable thing, the content is fetch-on-demand. Same for pages with zero inlinks (`orp` in topology): fine.

This is the pointer-over-copy doctrine applied to the graph: **an artifact holds a pointer to the volatile thing, not a copy of it.** Stubs ARE those pointers.

## What actually matters: true orphans (root reachability)

The health metric is **reachability from sanctioned roots**, not link counts. A true orphan is a block/subtree not transitively connected to `pages::` or one of the few sanctioned top-level roots.

Sanctioned roots (as of 2026-07-17): `pages::`, `pinned::`, `images::`, `backup::`, plus `orphaned-blocks::<timestamp>` recovery bags (the sync-integrity sweep's output — true orphans already caught and tagged).

**The probe** — the `root_ids` census. Any root beyond the sanctioned set is a stray:

```bash
KEY=$(grep '^api_key' ~/.floatty/config.toml | cut -d'"' -f2)
curl -s -H "Authorization: Bearer $KEY" "$FLOATTY_URL/api/v1/blocks" | jq -r '.root_ids[]'
# then per-root: GET /api/v1/blocks/:id?include=token_estimate for content + subtree size
```

**Known true-orphan generator (2026-07-17 finding)**: ensure-scripts that `POST /api/v1/blocks` **without a `parentId`** create root blocks. `lane-page-ensure.sh` did this — 9 rexall lane pages accumulated at root (one per sync day), page-shaped but not name-addressable. The fix class: route page creation through the FLO-652 semantic endpoints (`POST /api/v1/pages/:name`, `POST /api/v1/daily/:date/append`) which own the `pages::` placement. Sibling incident: `daily-page-ensure.sh` missed an existing daily on a trailing-space name mismatch and appended a duplicate header template inside it ([[baa1deca]], 2026-07-16).

## The reflex

Before claiming a block/page/graph problem:

1. Is this block a document or structure? → check `kind` / `subtreeSize` / ancestors, not link counts.
2. Is this "orphan" a stub? → stubs and no-inlink pages are workflow, not rot.
3. Is it reachable from a sanctioned root? → THAT is the orphan test. Run the root census.
