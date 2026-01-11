# Handoff: Unit 1.1 - BlockChange Types

**Completed**: 2026-01-10 @ 09:23 PM
**Status**: ✅ Complete

## What Was Done

- Created `events.rs` with BlockChange enum and BlockChangeBatch struct
- Added 6 change variants: Created, ContentChanged, MetadataChanged, Moved, Deleted, CollapsedChanged
- Each variant carries origin for hook filtering
- Helper methods: `block_id()`, `origin()`, `triggers_metadata_hooks()`, `triggers_index_hooks()`
- BlockChangeBatch for grouping changes from single transactions
- Exported from lib.rs

## Files Changed

| File | Change |
|------|--------|
| `floatty-core/src/events.rs` | New file - BlockChange enum, BlockChangeBatch struct |
| `floatty-core/src/lib.rs` | Added `pub mod events` and re-exports |

## Types Defined

### BlockChange Variants

```rust
pub enum BlockChange {
    Created { id, content, parent_id, origin },
    ContentChanged { id, old_content, new_content, origin },
    MetadataChanged { id, old_metadata, new_metadata, origin },
    Moved { id, old_parent_id, new_parent_id, origin },
    Deleted { id, content, origin },
    CollapsedChanged { id, collapsed, origin },
}
```

### BlockChangeBatch

```rust
pub struct BlockChangeBatch {
    pub changes: Vec<BlockChange>,
    pub timestamp: i64,
    pub transaction_id: Option<String>,
}
```

## Tests Added

| Test | What it verifies |
|------|------------------|
| `test_block_change_created` | Basic variant construction and accessors |
| `test_block_change_hook_origin_filtering` | Hook origin doesn't trigger hooks |
| `test_block_change_remote_origin` | Remote triggers index but not metadata hooks |
| `test_batch_operations` | Batch add, len, affected_block_ids |
| `test_batch_filter_by_origin` | Origin-based filtering |
| `test_serde_roundtrip` | JSON serialization |
| `test_serde_tag_format` | Verifies snake_case type tags |

## Decisions Made

| Decision | Options Considered | Choice | Rationale |
|----------|-------------------|--------|-----------|
| MetadataChanged variant | Bundle with ContentChanged vs separate | Separate | Hooks write metadata with Origin::Hook, need distinct filtering |
| CollapsedChanged variant | Include vs omit | Include | UI state that hooks might care about |
| old_content in ContentChanged | Include vs omit | Include | Enables diff-based processing, undo |
| content in Deleted | Include vs omit | Include | Search index cleanup, undo support |
| Serde tag style | Adjacent vs internal | Internal (`#[serde(tag = "type")]`) | Cleaner JSON, easy pattern matching |

## Architecture Note

**Key insight from entry review**: YDocStore has no block-level mutation methods - all mutations happen via Y.Doc transactions (either from TypeScript via WebSocket sync, or from API handlers in api.rs).

This means Unit 1.2 (Store Integration) will:
1. Wrap the Y.Doc observer to capture changes
2. Transform raw CRDT events into BlockChange types
3. NOT add methods to YDocStore (mutations already exist in api.rs)

## Setup for Next Unit

Unit 1.2 (Store Emitter Integration) should:
1. Add a broadcast channel to the store or create a separate ChangeEmitter struct
2. Register a Y.Doc `observe_deep()` callback
3. Transform Y.Doc events into BlockChange variants
4. Emit changes via the broadcast channel
5. Handle the origin extraction from transaction metadata

**Critical for 1.2**: The Y.Doc transaction origin is set in TypeScript (`_doc.transact(() => {...}, 'user')`). The Rust observer can read this via `txn.origin()` to determine the Origin enum value.

## Blockers for Next Unit

None.
