# outline-explorer · personal log

Newest first. No semver, no ceremony — just "hey, what's changed."

Format: date · headline · PR. Bullets describe what's NEW or DIFFERENT after the change, written so future-Evan can scan and remember.

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
