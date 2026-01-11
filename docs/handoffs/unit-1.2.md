# Handoff: Unit 1.2 - Change Emitter

**Completed**: 2026-01-10 @ 09:29 PM
**Status**: ✅ Complete

## What Was Done

- Created `emitter.rs` with ChangeEmitter struct
- Uses tokio broadcast channel for multi-subscriber pub/sub
- Added ChangeBuilder helper for constructing BlockChange events
- Added `parse_origin()` helper for converting origin strings to Origin enum
- Exported from lib.rs

## Files Changed

| File | Change |
|------|--------|
| `floatty-core/src/emitter.rs` | New file - ChangeEmitter, ChangeBuilder, parse_origin |
| `floatty-core/src/lib.rs` | Added `pub mod emitter` and re-exports |
| `floatty-core/Cargo.toml` | Added tokio dependency with sync feature |

## API Surface

### ChangeEmitter

```rust
impl ChangeEmitter {
    pub fn new() -> Self;
    pub fn with_capacity(capacity: usize) -> Self;
    pub fn subscribe(&self) -> broadcast::Receiver<Arc<BlockChangeBatch>>;
    pub fn subscriber_count(&self) -> usize;
    pub fn emit(&self, change: BlockChange) -> Result<usize, EmitError>;
    pub fn emit_batch(&self, batch: BlockChangeBatch) -> Result<usize, EmitError>;
    pub fn emit_batch_with_id(&self, changes: Vec<BlockChange>, transaction_id: String) -> Result<usize, EmitError>;
}
```

### ChangeBuilder

```rust
impl ChangeBuilder {
    pub fn new(origin: Origin) -> Self;
    pub fn created(self, id, content, parent_id) -> Self;
    pub fn content_changed(self, id, old_content, new_content) -> Self;
    pub fn metadata_changed(self, id, old_metadata, new_metadata) -> Self;
    pub fn moved(self, id, old_parent_id, new_parent_id) -> Self;
    pub fn deleted(self, id, content) -> Self;
    pub fn collapsed_changed(self, id, collapsed) -> Self;
    pub fn build(self) -> Vec<BlockChange>;
}
```

### Helper

```rust
pub fn parse_origin(origin_str: Option<&str>) -> Origin;
```

## Tests Added

| Test | What it verifies |
|------|------------------|
| `test_emit_single_change` | Single change emits and is received |
| `test_emit_batch` | Batch of changes emits correctly |
| `test_multiple_subscribers` | Multiple receivers all get the same batch |
| `test_emit_empty_batch_is_noop` | Empty batch doesn't emit |
| `test_emit_no_subscribers_ok` | Emitting with no subscribers doesn't error |
| `test_parse_origin` | Origin string parsing (case-insensitive) |
| `test_change_builder` | Builder pattern works, origin propagates |
| `test_change_builder_empty` | Empty builder produces empty list |

## Decisions Made

| Decision | Options Considered | Choice | Rationale |
|----------|-------------------|--------|-----------|
| Channel type | mpsc vs broadcast | broadcast | Multi-subscriber pattern (search + metadata hooks) |
| Batch wrapping | Box vs Arc | Arc | Efficient cloning across multiple subscribers |
| Capacity | Small (16) vs Large (256) | 256 | Allow buffering during burst writes |
| No-subscriber behavior | Error vs Ok(0) | Ok(0) | Not an error condition, just means no one is listening |

## Architecture Note

This unit implements the **emit** side of the Change Emitter. The actual Y.Doc observation is NOT wired up yet - that's a separate concern.

**Why separation?**
- The emitter is reusable (can be called from API handlers, tests, etc.)
- Y.Doc observer integration requires understanding the yrs observer API
- Testing is easier with the emitter decoupled from Y.Doc

## What's NOT Done Yet

- **Y.Doc observer integration**: The emitter exists but nothing calls `emit()` yet. This could be:
  1. Unit 1.3 (Debounce + Dedupe) can add debounced emission
  2. Or a separate unit to wire API handlers to emit on mutation

- **Previous state tracking**: ContentChanged needs old_content, but we don't track previous state yet. Options:
  1. Maintain a shadow state map
  2. Only emit "changed" without old value (loses diff capability)
  3. Use Y.Doc's built-in change tracking

## Setup for Next Unit

Unit 1.3 (Debounce + Dedupe) should:
1. Create a debounced wrapper around ChangeEmitter
2. Accumulate changes over a time window (1-2s)
3. Dedupe repeated changes to same block
4. Emit batches periodically or on flush

**Alternative**: If debouncing is done at the hook level, Unit 1.3 could instead focus on wiring API handlers to emit changes directly.

## Integration Points

To complete the Change Emitter pipeline:

1. **API handlers** (api.rs create/update/delete) could call emitter.emit()
2. **Y.Doc observer** could watch for changes and emit
3. **Hooks** subscribe and process changes

The ChangeBuilder helper is designed for option 1 (API handlers construct changes manually).

## Blockers for Next Unit

None. The emitter is ready to be called from anywhere.
