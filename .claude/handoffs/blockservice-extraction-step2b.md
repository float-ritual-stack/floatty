# Handoff: BlockService Extraction — Step 2b

## Resume Point

You are continuing a BlockService extraction from `api.rs` into `block_service.rs`. Steps 1 and 2a are done. Pick up at Step 2b.

## Branch State

```
Branch: feat/multi-outline-blockservice (from feat/multi-outline integration branch)
Commits: 2 on this branch
  998ee77 refactor(server): move pure helpers to block_service.rs (Step 1)
  bb409bd refactor(server): move get_blocks to block_service.rs (Step 2a)
Tests: 77 pass (1 pre-existing flaky: test_search_returns_results)
```

## What's Already in block_service.rs

5 helpers + 1 service function:
- `extract_timestamp` — f64/BigInt → i64
- `resolve_block_id` — short-hash prefix resolution
- `resolve_body_field` — field-name error context wrapper
- `read_block_dto` — canonical BlockDto producer
- `lookup_inherited` — InheritanceIndex → InheritedMarkerDto
- `get_blocks(store, inheritance_index, query)` — list all blocks with filters

## What to Move Next (Step 2b)

Move `get_block` + all ?include= context helpers from api.rs to block_service.rs:

**Functions to move** (api.rs line numbers may shift from prior edits — grep to confirm):
- `build_block_context_response` (~line 1780) — orchestrator for ?include=
- `read_block_content` (~line 1819) — read content string from Y.Map
- `get_ancestors` (~line 1868) — walk parent chain
- `get_siblings` (~line 1885) — read sibling context
- `get_children_refs` (~line 1926) — direct children
- `get_subtree` (~line 1938) — DFS traversal
- `compute_token_estimate` (~line 1978) — count chars/blocks/depth
- `parse_includes` (~line 2025) — comma-separated string → HashSet
- `collect_descendants` (~line 2921) — DFS for delete (move now, used by delete later)

**Types that stay in api.rs** (used broadly by handlers):
- `BlockContextQuery`, `BlockRef`, `TreeNode`, `SiblingContext`, `TokenEstimate`, `BlockWithContextResponse`

Make these `pub` in api.rs if not already. Import them in block_service.rs.

**Then rewire the legacy `get_block` handler** to call `block_service::get_block(...)`.

## Extraction Discipline

1. **Move, don't copy.** Cut from api.rs → paste into block_service.rs → update imports → `cargo check`
2. **Compile after EACH function move.** Don't batch.
3. **Make moved functions `pub(crate)`** so api.rs handlers can call them.
4. **Run `cargo test -p floatty-server` after rewiring each handler.** Target: 77 pass.

## Remaining Steps After 2b

Per plan at `~/.claude/plans/replicated-spinning-liskov.md`:

- **Step 3**: Move `create_block` → `block_service::create_block(&OutlineContext, req)`
- **Step 4**: Move `update_block`
- **Step 5**: Move `delete_block` (last — uses `collect_descendants`)
- **Step 6**: Rewire outline handlers to use block_service
- **Step 7**: Delete Phase 1 duplicate handlers (10 functions to delete)
- **Step 8**: Final verification (rebuild dev server, curl lifecycle, parity check)

## Architecture Rules (from plan)

- **BlockService has no route-awareness.** No branching on ctx.name or route family.
- **Mutation pipeline is explicit:** resolve → mutate Y.Doc → drop guard → persist → hooks → broadcast
- **OutlineContext** has two HookSystem accessors:
  - `ensure_hook_system()` — triggers init, for writes
  - `hook_system_if_initialized()` — cheap check, for flush

## Key Files

- `src-tauri/floatty-server/src/block_service.rs` — destination
- `src-tauri/floatty-server/src/api.rs` — source (~6400 lines)
- `src-tauri/floatty-server/src/outline_manager.rs` — OutlineContext definition
- `~/.claude/plans/replicated-spinning-liskov.md` — full plan with checklists

## How to Start

```bash
cd /Users/evan/projects/_float/float-substrate/floatty
git checkout feat/multi-outline-blockservice
# Read the plan
cat ~/.claude/plans/replicated-spinning-liskov.md
# Read current block_service.rs
cat src-tauri/floatty-server/src/block_service.rs
# Find the functions to move
grep -n "fn build_block_context_response\|fn read_block_content\|fn get_ancestors\|fn get_siblings\|fn get_children_refs\|fn get_subtree\|fn compute_token_estimate\|fn parse_includes\|fn collect_descendants" src-tauri/floatty-server/src/api.rs
# Start moving
```
