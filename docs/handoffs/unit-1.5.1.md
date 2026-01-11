# Handoff: Unit 1.5.1 - Hook Interface

**Completed**: 2026-01-10 @ 10:54 PM
**Status**: ✅ Complete

## What Was Done

- Created `hooks` module with `BlockHook` trait definition
- Trait is object-safe (`Box<dyn BlockHook>` works)
- Added `should_process()` helper for origin filtering
- Comprehensive documentation with architecture diagrams
- 9 unit tests covering object safety, origin filtering, and processing

## Files Changed

| File | Change |
|------|--------|
| `floatty-core/src/hooks/mod.rs` | **New** - BlockHook trait + helper + tests |
| `floatty-core/src/lib.rs` | Added `pub mod hooks` and re-exports |

## API Surface

### BlockHook Trait

```rust
pub trait BlockHook: Send + Sync {
    fn name(&self) -> &'static str;
    fn priority(&self) -> i32;
    fn is_sync(&self) -> bool;
    fn accepts_origins(&self) -> Option<Vec<Origin>>;
    fn process(&self, batch: &BlockChangeBatch, store: Arc<YDocStore>);
}
```

### Helper Function

```rust
pub fn should_process(hook: &dyn BlockHook, origin: Origin) -> bool;
```

## Tests Added

| Test | What it verifies |
|------|------------------|
| `test_trait_object_safety` | Trait can be used as `Box<dyn BlockHook>` |
| `test_boxed_hook_methods` | Methods work through trait object |
| `test_should_process_with_filter` | Origin filtering rejects excluded origins |
| `test_should_process_accepts_all` | `None` accepts all origins |
| `test_metadata_hook_pattern` | MetadataHook excludes Hook + Remote |
| `test_tantivy_hook_pattern` | TantivyHook includes Remote, excludes Hook |
| `test_process_receives_batch` | Hook's `process()` receives correct batch |

## Decisions Made

| Decision | Options Considered | Choice | Rationale |
|----------|-------------------|--------|-----------|
| `Arc<YDocStore>` in process | `&YDocStore` vs `Arc<YDocStore>` | `Arc<YDocStore>` | Hooks may need to spawn tasks that outlive the call |
| `&BlockChangeBatch` ref | ref vs owned | ref | Sync hooks shouldn't need to clone the batch |
| `&'static str` for name | `String` vs `&'static str` | `&'static str` | Hooks are statically registered, no allocation needed |
| Helper `should_process()` | Method vs free function | Free function | Keeps trait minimal, registry uses this helper |

## Architecture Notes

### Priority Ranges

| Range | Purpose | Example |
|-------|---------|---------|
| 0-19 | Critical metadata extraction | MetadataHook (10) |
| 20-49 | Index maintenance | PageNameIndexHook (20) |
| 50-99 | Search/analytics | TantivyIndexHook (50) |
| 100+ | User-defined, logging | Custom hooks |

### Origin Filtering Patterns

**MetadataHook** (extracts metadata from content):
```rust
Some(vec![Origin::User, Origin::Agent, Origin::BulkImport])
// Excludes Hook (prevents loops) and Remote (already extracted)
```

**TantivyIndexHook** (maintains local search index):
```rust
Some(vec![Origin::User, Origin::Remote, Origin::Agent, Origin::BulkImport])
// Includes Remote (needs local indexing), excludes Hook
```

## Setup for Next Unit

Unit 1.5.2 (Registry Implementation) should:

1. Create `HookRegistry` struct with `Vec<Box<dyn BlockHook>>`
2. Implement `register()` that inserts sorted by priority
3. Implement `dispatch()` that:
   - Iterates hooks in priority order
   - Calls `should_process()` to check origin
   - For sync hooks: calls `process()` directly
   - For async hooks: spawns a task
4. Consider thread safety (`Mutex` or `RwLock` for the hook list)

### Signature Sketch

```rust
pub struct HookRegistry {
    hooks: Vec<Box<dyn BlockHook>>,
}

impl HookRegistry {
    pub fn new() -> Self;
    pub fn register(&mut self, hook: Box<dyn BlockHook>);
    pub async fn dispatch(&self, batch: &BlockChangeBatch, store: Arc<YDocStore>);
}
```

## Blockers for Next Unit

None. The trait is ready for registry implementation.

## Approach Changes

None needed. The work unit plan remains accurate.
