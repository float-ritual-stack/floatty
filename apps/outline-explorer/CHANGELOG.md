# outline-explorer · personal log

Newest first. No semver, no ceremony — just "hey, what's changed."

Format: date · headline · PR. Bullets describe what's NEW or DIFFERENT after the change, written so future-Evan can scan and remember.

---

## [[2026-05-08]] · Tool description discoverability sweep — alias bouquets across MCP + AI SDK surfaces

### Why

`tool_search` matches on the description string. Agents searching natural-language verbs ("get block by id", "read block", "look up block") were missing `get_block` because the description led with "Fetch" and didn't carry the verb aliases. Same gap on every other tool. Biggest single miss: `get_inbound` — canonical agent verb is "backlinks", and the word didn't appear anywhere in the description.

### What changed

Twelve of thirteen tools across two surfaces (one tool — `suggest_walks` — skipped because the agent invokes it as the final step of its own analysis chain, not via search):

- **MCP server** (`src/mcp/tools.ts`) — what `tool_search` indexes
- **AI SDK chat agent** (`src/lib/tools/*.ts`) — in-app chat surface, separate code path because it pulls Next.js's `server-only` guard

Each description now leads with an alias bouquet (`"verb1 / verb2 / verb3 / verb4 a thing"`) so substring + semantic matchers hit the natural-language verb space agents reach for. Body text and disambiguators preserved verbatim.

### Highest-impact fixes

- `get_inbound` now leads with `"Find backlinks / inbound links / references / what-links-here"` — was completely missing the canonical agent verb.
- `add_block` description now matches the tool name — was registered as `add_block` but described as "Create a new block", so agents searching either verb hit half the matching surface. Now: `"Add / create / insert / make / write / post / append a new block"`.
- `patch_block` expanded with intent-verbs (`move`, `rename`, `reparent`, `collapse`, `rewrite`) — agents phrase mutations by intent, not mechanism. Schema parameter names already covered the mechanism; the intent-verbs anchor the semantic matcher.
- `get_block` and friends gained sibling-tool disambiguators (`"For block IDs use get_block; for full-text search use search_blocks"`) where there's a real "agent picks the wrong tool" risk in the search_blocks ↔ get_block ↔ get_inbound triangle.

### Files

- `src/mcp/tools.ts` — 12 description rewrites
- `src/lib/tools/{expand-page,search-blocks,get-inbound,qmd-search,qmd-get,qmd-multi-get,get-block}.ts` — 7 in-app chat tool descriptions kept in symmetry

Lint + typecheck clean. Zero behavioural change — descriptions only.

### Deferred

- MCP server bundle rebuild (`pnpm mcp:dev` / `pnpm build`) — new descriptions only reach a running MCP client after rebuild + restart.

---

## [[2026-04-29]] · MCP expansion — dual-shape reads + token previews + write CRUD · [[PR #291]]

### MCP tools 9 → 14

**New read tools / shape changes:**
- `expand_page` and `get_block` now return BOTH `tree` (rendered string, capped at 200 nodes) AND `treeNodes` (full structured `TreeNode[]` with `childIds`). Live artifacts can navigate sub-blocks; agents skim the string. `treeTruncated: boolean` flag fires when the string view is partial.
- `tokenEstimate` always-on for both — `{totalChars, blockCount, maxDepth}` from the same DFS, no extra round-trip.
- **NEW** `estimate_subtree(blockId)` — cheap size peek via `?include=token_estimate` alone. Returns `{blockCount, totalChars, maxDepth, estimatedTokens, directChildren}` without serialising the tree. Use before pulling large subtrees. Heuristic: <50 = pull all, 50–200 = consider scoping, >200 = paginate via `search_blocks({parentId})`.
- `search_blocks` gained `parentId` param — restricts search to descendants of a block. Pairs with `estimate_subtree` for "this hub page is huge, scope my search."

**New write tools** (kill the bash + curl + jq juggling):
- `add_block({content, parentId | afterId})` — XOR-validated at the MCP boundary with a clear error message.
- `patch_block({blockId, content?, parentId?, collapsed?})` — empty-body guard returns clear UX error instead of no-op API hit.
- `create_page({name})` — wraps [[FLO-652]] semantic upsert. Returns server-canonical name (case-insensitive idempotency means `"my page"` request might return existing `"My Page"`); request name preserved as `requestedName`.
- `append_to_daily({date, content})` — autocreates daily note if missing. YYYY-MM-DD validated.

**Field rename (BC break, single-user app, atomic):**
- `expand_page.blockCount` → `treeBlockCount`. Both `expand_page` and `get_block` now expose `childCount` + `treeBlockCount` symmetrically.

### Type fixes

- `TreeNode.childIds: string[]` was missing — silent drift from the API's `Vec<String>`. Live artifacts can now rebuild nested tree shape from the flat DFS response.
- `TokenEstimate` extracted as a named export.

### Doctrine codified

- New repo-level rule [`.claude/rules/personal-tool-pr-scope.md`](../../.claude/rules/personal-tool-pr-scope.md) — bot-only review (CodeRabbit + Greptile) means bundle aggressively, don't apply team-coordination PR scoping. Two coherent PRs that don't depend on each other = parallel, not stacked.
- Linked from worktree CLAUDE.md "Pattern References" alongside `lint-discipline.md` + `symmetry-check.md`.

### Internals

- `floattyFetch` extended to accept `RequestInit` for write methods (was GET-only).

### Out of scope (parallel Rust PR, not stacked)

- `POST /api/v1/blocks/bulk` — transactional batch create with `tempId` resolution (~15 single POSTs × 200ms = 3s of skill-driven latency today).
- `GET /api/v1/blocks/:id/neighbourhood?radius=N` — one-shot `{focal, inbound[], outbound[]}` with `ancestorContext` baked in.
