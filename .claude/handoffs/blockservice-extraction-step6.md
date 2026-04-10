# Handoff: BlockService Extraction — Steps 6-8

## Status: COMPLETE

Steps 6-8 done (PR #214). Review fixes for #212 and #213 also included.
Next: PR #3 (per-outline hooks + scoped search).

## Branch State

```
Branch: feat/multi-outline-blockservice (from feat/multi-outline integration branch)
Commits: 6 on this branch
  998ee77 refactor(server): move pure helpers to block_service.rs (Step 1)
  bb409bd refactor(server): move get_blocks to block_service.rs (Step 2a)
  2a57806 refactor(server): move get_block + context helpers to block_service.rs (Step 2b)
  409dcce refactor(server): move create_block to block_service.rs (Step 3)
  4797069 refactor(server): move update_block to block_service.rs (Step 4)
  5e71855 refactor(server): move delete_block to block_service.rs (Step 5)
PR: #213 (Steps 1-5, targets feat/multi-outline)
Tests: 77 pass
```

## What's in block_service.rs Now

All block CRUD + helpers:
- `extract_timestamp`, `resolve_block_id`, `resolve_body_field`, `read_block_dto`, `lookup_inherited`
- `read_block_content`, `read_block_parent_id`, `read_block_child_ids`, `parse_includes`
- `get_ancestors`, `get_siblings`, `get_children_refs`, `get_subtree`, `compute_token_estimate`
- `build_block_context_response`, `collect_descendants`
- `get_blocks(store, inheritance_index, query)`
- `get_block(store, inheritance_index, id, ctx_query)`
- `create_block(store, broadcaster, hook_system, req)`
- `update_block(store, broadcaster, hook_system, id, req)`
- `delete_block(store, broadcaster, hook_system, id)`

## Step 6: Rewire Outline Handlers (PR B)

The 5 outline handlers at these lines (grep to confirm — lines shift):
- `outline_get_blocks` — currently calls `read_all_blocks_json` helper
- `outline_create_block` — duplicates create logic
- `outline_get_block` — duplicates get logic
- `outline_update_block` — duplicates update logic
- `outline_delete_block` — duplicates delete logic

Rewire each to: `get_context(&name)` → `block_service::fn(&ctx.store, ...)`

The outline handlers resolve an OutlineContext first, then should delegate to block_service.

## Step 7: Delete Phase 1 Duplicates (PR C)

Delete these functions from api.rs:
- `outline_create_block` (Phase 1 duplicate body — now calls block_service)
- `outline_update_block`
- `outline_delete_block`
- `outline_get_blocks`
- `outline_get_block`
- `outline_get_stats`
- `outline_export_json` (Phase 1 version)
- `read_all_blocks_json` helper
- `reject_default_mutation`
- `resolve_outline` (bare store version)

Wait — after Step 6 rewires them, they won't be duplicates anymore, they'll be thin wrappers like the legacy handlers. Step 7 might just be verifying they're clean, not deleting them.

Re-read the plan at `~/.claude/plans/replicated-spinning-liskov.md` to clarify what "delete" means here.

## Step 8: Final Verification

- Rebuild dev server, run curl lifecycle
- `/outlines/default/blocks` = `/api/v1/blocks` (same response shape)
- Create outline → blocks → isolation → delete → cleanup

## Key Files

- `src-tauri/floatty-server/src/block_service.rs` — service (1300 lines)
- `src-tauri/floatty-server/src/api.rs` — handlers + routes
- `src-tauri/floatty-server/src/outline_manager.rs` — OutlineContext
- `~/.claude/plans/replicated-spinning-liskov.md` — full plan

## Lessons from Steps 1-5

1. **Batch dependent functions** — move callers with callees in one pass
2. **Grep ALL callers** — surprise callers exist (search breadcrumb called get_ancestors)
3. **Orphaned imports cascade** — clean up unused imports after each move
4. **Service function signatures**: reads take `(store, inheritance_index, ...)`, mutations take `(store, broadcaster, hook_system, ...)`
