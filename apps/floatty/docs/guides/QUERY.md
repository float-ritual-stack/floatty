# `query::` — standing queries in the outline

A `query::` block is a saved search that renders its results *as rows under the block*, live. Backlinks are one of these with the predicate pinned to "links here"; `query::` lets you write the predicate. Rows render through the same renderer as the backlinks drawer: crumb › content, first-child peek, `▸` expand-in-place, facet chips (page / link / marker) that narrow the list, sort, and free-text filter. Plain click on a row navigates (⌘L pane links honoured); `[[wikilinks]]` inside rows are live.

## Shape

```
query:: <term> <term> … [option:: value] [option:: value]
```

Terms are whitespace-separated and **AND** together. A leading `!` negates a term. A half-typed or malformed query never breaks the block — bad pieces show as `⚠` in the header and the rest still evaluates.

## Terms

| Term | Matches blocks that… | Example |
|---|---|---|
| `link:<target>` | link to exactly this page / block (same identity the backlink index uses: page name, block id, or short hash) | `link:⬜` · `link:Project Catalyst` · `link:7fc0276f` |
| `link~<regex>` | have any outlink whose target matches (case-insensitive) | `link~^(PC\|REX)-\d+$` — any Catalyst ticket |
| `page:<name>` | sit under this page (nearest direct child of `pages::`) | `page:2026-w37` |
| `page~<regex>` | nearest page title matches | `page~^2026-09` — this month's dailies |
| `under:[[block or page]]` | are inside this subtree (id, short hash, or page name) | `under:[[week prep stuff]]` |
| `since:<N>d` | were updated in the last N days | `since:14d` |
| `text~<regex>` | first line matches | `text~refill\|consent` |
| `marker:<type>[:<value>]` | carry this marker — **own or inherited** (a `[project::x]` on a heading reaches every block beneath it) | `marker:project:rangle/rexall-catalyst` · `marker:owner` (any owner) |

Status is a *glyph link*, not a pill: `[[⬜]]` todo · `[[🟨]]` doing · `[[✅]]` done · `[[👀]]` waiting. So a todo board is `link:⬜`, not `marker:status`.

## Options (pills on the query line)

| Option | Effect |
|---|---|
| `[display:: rows]` (default) / `[display:: titles]` | full rows, or the title line only — titles + a ⌘L-linked pane = master/detail |
| `[limit:: N]` | cap (default 200); the header shows `N of total` and a `+more` line when truncated |
| `[create_block:: [[target]]]` | where a block you add under this query is created (its last child); default = under the query block itself. Note the **underscore** — hyphens aren't marker keys |
| `[stamp:: key=value …]` | what write-through applies to blocks added or moved here (default: derived from the query's exact terms — `link:⬜` stamps `[[⬜]]`, `marker:project:x` stamps `[project::x]`) |

## Write-through

Blocks you create under a query, or move into one — by drag, Enter, or an agent's API reparent — get the query's stamp applied **on the server** (`PropStampHook`): the glyph flips, pills are written into the block's text, and extraction/indexing follow. Moving a block *out* of a query does not unset anything. A `query::` block is never stamped itself. Real children of a query that also match show once, in place.

## A board in three lines

```
## backlog [project::demo/qv]
  [[⬜]] [[DEMO-101]] write the ADR summary
  [[🟨]] [[DEMO-103]] stamp hook live check
  …
## board
  query:: link:⬜ marker:project:demo/qv [create_block:: [[<backlog hash>]]]
  query:: link:🟨 marker:project:demo/qv [create_block:: [[<backlog hash>]]]
  query:: link:✅ marker:project:demo/qv [display:: titles]
```

The cards carry no project pill — they inherit it from the heading. Drag a card from the ⬜ query to the 🟨 one and the server rewrites its glyph. Enter at the end of a query line creates the new card in the backlog, stamped.

## Setting properties without the UI

Agents flip status/pills with `POST /api/v1/blocks/:id/props` — see `help:: props` and `.claude/rules/api-reference.md` §Authored props. Never write `metadata.markers`; it's a derived cache and the next extraction overwrites it.

## Under the hood

Grammar `src/lib/queryPredicate.ts`, evaluation `src/lib/queryEval.ts` (seeds from the backlink index / subtree, filters, sorts newest-first, caps), rows `BlockRefList`, redirect `src/lib/queryCreate.ts`, stamping `floatty-core/src/hooks/prop_stamp.rs`. Decisions: `docs/adrs/ADR-009-query-views-and-authored-props.md`.
