# Handoff: Unit 1.3 - Debounce + Dedupe

**Completed**: 2026-01-10 @ 10:52 PM
**Status**: ✅ Complete

## What Was Done

- Created `batcher.rs` with `BatchedChangeCollector` struct
- Implements time-based batching (configurable flush interval, default 1s)
- Implements deduplication by block ID with smart merging
- Implements threshold-based flushing (default 50 changes)
- Background flush task via `start_flush_task()`
- Handles special merge cases (Created+Deleted = Cancelled, Created+ContentChanged = Created with new content)

## Files Changed

| File | Change |
|------|--------|
| `floatty-core/src/batcher.rs` | **New** - BatchedChangeCollector, ChangeState, merge logic |
| `floatty-core/src/lib.rs` | Added `pub mod batcher` and re-export |
| `floatty-core/Cargo.toml` | Added tokio `time` and `rt` features |

## API Surface

### BatchedChangeCollector

```rust
impl BatchedChangeCollector {
    pub fn new(emitter: ChangeEmitter) -> Self;
    pub fn with_config(emitter: ChangeEmitter, interval_ms: u64, threshold: usize) -> Self;

    // Submit changes for batching
    pub async fn submit(&self, change: BlockChange) -> bool;  // returns true if threshold flush occurred
    pub async fn submit_batch(&self, changes: Vec<BlockChange>);

    // Manual flush
    pub async fn flush(&self);

    // Inspection
    pub async fn has_pending(&self) -> bool;
    pub async fn pending_count(&self) -> usize;

    // Subscribe (delegates to underlying emitter)
    pub fn subscribe(&self) -> Receiver<Arc<BlockChangeBatch>>;

    // Background task (call once at startup)
    pub fn start_flush_task(self: &Arc<Self>) -> JoinHandle<()>;
}
```

### Deduplication Strategy

| Existing State | New Change | Result |
|----------------|------------|--------|
| None | Any | Store as initial state |
| Created | Deleted | Cancelled (no-op) |
| Created | ContentChanged | Created with new content |
| ContentChanged | ContentChanged | Merged (old_start → new_end) |
| ContentChanged | Deleted | Deleted |
| Any | Deleted | Deleted (supersedes) |
| Cancelled | Any | Cancelled |

### ChangeState Enum

Internal enum tracks accumulated state per block:
- `Created { content, parent_id, origin }`
- `ContentChanged { old_content, new_content, origin }`
- `MetadataChanged { old_metadata, new_metadata, origin }`
- `Moved { old_parent_id, new_parent_id, origin }`
- `Deleted { content, origin }`
- `CollapsedChanged { collapsed, origin }`
- `Cancelled` - no-op (Created then Deleted in same batch)

## Tests Added

| Test | What it verifies |
|------|------------------|
| `test_single_change_collects` | Change is buffered in pending |
| `test_flush_emits_and_clears` | Flush emits batch and clears pending |
| `test_dedupe_content_changes` | Multiple ContentChanged merge correctly |
| `test_created_then_deleted_cancels` | Created+Deleted produces empty batch |
| `test_created_then_content_changed` | Created content is updated |
| `test_threshold_triggers_flush` | Threshold triggers automatic flush |
| `test_preserves_order` | First-occurrence order preserved in batch |
| `test_multiple_blocks_independent` | Changes to different blocks don't interfere |
| `test_submit_batch` | Bulk submit works |
| `test_deleted_supersedes_content_change` | Deleted wins over prior changes |

## Decisions Made

| Decision | Options Considered | Choice | Rationale |
|----------|-------------------|--------|-----------|
| State tracking | HashMap<id, BlockChange> vs ChangeState enum | ChangeState enum | Need to track merged state (old_start → new_end), not just latest change |
| Order preservation | Vec of changes vs order Vec + HashMap | Separate order Vec | O(1) dedup + deterministic order |
| Async API | sync Mutex + spawn_blocking vs async Mutex | tokio::sync::Mutex | Simpler, avoids thread pool overhead |
| Cancelled representation | None in HashMap vs Cancelled state | Cancelled state | Preserves order slot, cleaner merge logic |

## Architecture Note

The batcher is **fully async** - `submit()`, `flush()`, etc. are async methods. This aligns with the hook system which will also be async.

The `start_flush_task()` returns a `JoinHandle` so callers can abort if needed. The task runs forever, flushing at the configured interval.

## What's NOT Done Yet

- **Wiring to Y.Doc observer**: Nothing calls `submit()` yet. The Change Emitter (1.2) + Batcher (1.3) are ready, but need a hook to connect them to actual Y.Doc mutations.
- **Previous state tracking**: The batcher assumes callers provide correct `old_content`. If Y.Doc observer integration happens, it needs to track shadow state.

## Setup for Next Unit

Unit 1.5.1 (Hook Interface) should:
1. Define the `BlockHook` trait that receives `BlockChangeBatch`
2. Consider whether hooks receive raw or batched changes
3. The batcher's `subscribe()` returns `Receiver<Arc<BlockChangeBatch>>` - hooks can subscribe to this

**Alternative path**: If hooks need per-change granularity (not batched), they can subscribe directly to `ChangeEmitter`. The batcher adds optional coalescing for expensive operations (search indexing).

## Integration Points

To complete the pipeline:

```
Y.Doc mutation → Observer → ChangeEmitter.emit() → BatchedChangeCollector.submit() → flush → HookRegistry → hooks
                                   ↑                                                              ↓
                              or directly                                              Search, Metadata, etc.
```

Two subscription patterns:
1. **Real-time hooks** subscribe to `ChangeEmitter` directly
2. **Expensive hooks** subscribe to `BatchedChangeCollector` for coalesced batches

## Blockers for Next Unit

None. The foundation is ready for hooks.

## Approach Changes

None needed. The work unit plan anticipated this structure correctly.
