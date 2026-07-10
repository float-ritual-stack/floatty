# FLO-361: Hook Thread Starvation Fix

## Handoff Prompt

Copy everything below this line into a fresh session.

---

## Task: Fix FLO-361 — Server thread starvation from hook processing

The floatty-server (Axum + tokio) deadlocks under normal GUI editing. The server accepts TCP connections but never responds — 0% CPU, all tokio worker threads parked on `std::sync::RwLock`. Health endpoint (lock-free, no auth) times out because no tokio thread is available to run it. Requires app restart. No data loss but completely blocks usage.

**Branch**: `fix/flo-361-hook-thread-starvation` (already created from main, currently empty)

**Linear**: FLO-361

## Root Cause

FLO-358 (PR #139, merged) added `Origin::Remote` to three **sync** hooks so GUI edits get metadata extraction. This was correct — the server is the sole metadata extractor. But it exposed a scaling problem in the hook pipeline.

### The Starvation Sequence

Every GUI edit (Origin::Remote) now triggers:

1. **MetadataExtractionHook** (sync, p10): Calls `store.update_block_metadata()` per block — each call acquires `doc.write()` individually. For a batch of N blocks, that's N separate write lock acquisitions.

2. **InheritanceIndexHook** (sync, p15): Calls `index.rebuild(&store)` which does a **full rebuild** every time:
   - `store.get_all_block_ids()` → 1 `doc.read()`
   - For EACH of 26,000 blocks: `store.get_block()` → 1 `doc.read()`
   - For EACH ancestor: `store.get_block()` → 1 `doc.read()`
   - Total: ~50,000+ `doc.read()` acquisitions per batch

3. **PageNameIndexHook** (sync, p20): Scans blocks for page patterns

4. All sync hooks run on the tokio dispatch task. `std::sync::RwLock` blocks the **OS thread**, not just the tokio task. When contention from concurrent `POST /api/v1/update` handlers (needing `doc.write()`) blocks enough threads, the entire tokio runtime freezes.

Before FLO-358, only async TantivyIndexHook processed Remote. Now 3 sync hooks do too.

### Why Even Small Edits Deadlock

The InheritanceIndex does a full rebuild (50,000+ lock acquisitions) on EVERY batch, even for a single block edit. This isn't a bulk operation problem — it's the baseline cost per edit at 26,000 blocks.

## Three Fixes Required

### Fix 1: Incremental InheritanceIndex (highest impact)

**File**: `src-tauri/floatty-core/src/hooks/inheritance_index.rs`

Current `rebuild()` iterates ALL blocks and walks ALL ancestors. Change to incremental:

1. Add `update_affected()` method that only recomputes blocks mentioned in the batch + their descendants
2. For each changed block: walk up ancestors collecting inherited markers (same logic)
3. For each changed block: find descendants and recompute their inheritance too (a parent's markers changed → children's inheritance changes)
4. Keep `rebuild()` for cold start (rehydration) but use `update_affected()` in `process()`

The batch contains `BlockChange` variants with block IDs. Extract the set of affected IDs, find their subtrees, recompute only those.

**Key insight**: To find descendants, you need `childIds`. The store's `get_block()` returns `child_ids: Vec<String>`. Walk down from each affected block.

**Key insight**: Metadata changes (from MetadataExtractionHook at p10) also affect inheritance. If a block gains a new `[project::X]` marker, all its descendants' inherited markers change. The batch from MetadataExtractionHook emits `BlockChange::MetadataChanged` — but those have `Origin::Hook` which InheritanceIndex rejects. This is actually fine: the ORIGINAL content change that triggered metadata extraction IS in the batch that reaches InheritanceIndex. The inheritance hook just needs to recompute from the content-changed blocks.

### Fix 2: Batch Metadata Writes

**File**: `src-tauri/floatty-core/src/hooks/metadata_extraction.rs`

Current `process()` calls `extract_and_store()` per block, each acquiring `doc.write()`. Change to:

1. Extract metadata for ALL blocks in the batch (pure computation, no locks)
2. Add `store.batch_update_metadata(updates: Vec<(String, BlockMetadata)>, origin: Origin)` to `store.rs`
3. Single `doc.write()` transaction for the entire batch

**File**: `src-tauri/floatty-core/src/store.rs`

Add `batch_update_metadata()` — same logic as `update_block_metadata()` but loops inside ONE write transaction instead of acquiring/releasing per block.

### Fix 3: `spawn_blocking` for Hook Dispatch

**File**: `src-tauri/floatty-core/src/hooks/system.rs`

In `spawn_dispatch_task()`, wrap the `registry.dispatch()` call in `tokio::task::spawn_blocking()` so sync hooks don't block tokio worker threads. This is a safety net — even if hooks are slow, the HTTP server stays responsive.

```rust
// Current (blocks tokio thread):
registry.dispatch(&batch, Arc::clone(&store));

// Fixed:
let registry = Arc::clone(&registry);
let store = Arc::clone(&store);
tokio::task::spawn_blocking(move || {
    registry.dispatch(&batch, store);
}).await.ok();
```

Note: `HookRegistry` needs to be `Arc`-wrapped for this. Currently it's moved into the async block. Check `system.rs` `spawn_dispatch_task()` for the exact ownership pattern.

## Key Files

| File | What to change |
|------|---------------|
| `floatty-core/src/hooks/inheritance_index.rs` | Add `update_affected()`, use in `process()` |
| `floatty-core/src/hooks/metadata_extraction.rs` | Batch extraction, single store call |
| `floatty-core/src/store.rs` | Add `batch_update_metadata()` |
| `floatty-core/src/hooks/system.rs` | `spawn_blocking` in dispatch task |
| `floatty-core/src/hooks/mod.rs` | May need `HookRegistry` to be `Arc`-compatible |

## Testing

```bash
cd src-tauri && cargo test -p floatty-core
```

Existing tests should still pass. The InheritanceIndex tests are mostly unit tests on the data structure — the `rebuild()` method stays for cold start. Add tests for `update_affected()`.

After code changes:
1. Build and run dev server: `npm run tauri dev`
2. Edit blocks in the GUI
3. Verify server doesn't freeze (health endpoint responds)
4. Verify metadata still gets extracted: `curl -s -H "Authorization: Bearer $KEY" "http://127.0.0.1:$PORT/api/v1/blocks" | jq '.blocks[0].metadata'`

## Architecture Reference

- Hook dispatch: `system.rs` → `HookRegistry::dispatch()` in `mod.rs` (line 236)
- Sync hooks block the dispatch task: `mod.rs` line 274-276
- Store doc lock: `std::sync::RwLock<yrs::Doc>` in `store.rs`
- `update_block_metadata()`: `store.rs` line 855 — acquires `doc.write()` per call
- `get_block()`: `store.rs` line 499 — acquires `doc.read()` per call
- `get_all_block_ids()`: `store.rs` line 483 — acquires `doc.read()`

## Cargo Test

```bash
# CORRECT
cd src-tauri && cargo test -p floatty-core -- test_name

# Package is floatty-core (NOT float-pty, NOT floatty)
# Filter goes AFTER --
```
