# Handoff: Unit 1.5.2 - Registry Implementation

**Completed**: 2026-01-10 @ 11:10 PM
**Status**: ✅ Complete

## What Was Done

- Created `HookRegistry` struct with `RwLock<Vec<Arc<dyn BlockHook>>>`
- Implemented `register()` with priority-sorted insertion
- Implemented `dispatch()` with per-hook origin filtering and sync/async handling
- Added 9 new registry tests (now 64 total tests in floatty-core)
- Exported `HookRegistry` from `lib.rs`

## Files Changed

| File | Change |
|------|--------|
| `floatty-core/src/hooks/mod.rs` | Added `HookRegistry` struct + 9 tests |
| `floatty-core/src/lib.rs` | Added `HookRegistry` to re-exports |

## API Surface

### HookRegistry

```rust
pub struct HookRegistry {
    hooks: RwLock<Vec<Arc<dyn BlockHook>>>,
}

impl HookRegistry {
    pub fn new() -> Self;
    pub fn register(&self, hook: Arc<dyn BlockHook>);
    pub fn len(&self) -> usize;
    pub fn is_empty(&self) -> bool;
    pub fn dispatch(&self, batch: &BlockChangeBatch, store: Arc<YDocStore>);
}
```

Key design decisions:
- **`Arc<dyn BlockHook>`** instead of `Box` - enables async spawn to outlive read guard
- **`RwLock`** for interior mutability - reads (dispatch) vastly outnumber writes (register)
- **Per-hook filtering** - registry filters batch by origin for each hook, hooks receive only relevant changes
- **Sync vs async** - `is_sync()` true calls `process()` directly, false spawns via `tokio::spawn`

## Tests Added

| Test | What it verifies |
|------|------------------|
| `test_registry_empty` | New registry has no hooks |
| `test_register_single` | Can register one hook |
| `test_register_priority_order` | Hooks sorted by priority |
| `test_dispatch_calls_process` | Dispatch invokes hook's process |
| `test_dispatch_origin_filtering` | Only matching origins processed |
| `test_dispatch_sync_blocks` | Sync hooks complete before dispatch returns |
| `test_dispatch_async_spawns` | Async hooks spawned (tokio::test) |
| `test_dispatch_empty_batch_no_call` | Empty batch doesn't call hooks |
| `test_dispatch_priority_order_execution` | Hooks execute in priority order |

## Decisions Made

| Decision | Options Considered | Choice | Rationale |
|----------|-------------------|--------|-----------|
| Hook storage | `Box<dyn>` vs `Arc<dyn>` | `Arc<dyn>` | Async spawn needs owned reference outliving RwLock guard |
| Thread safety | Mutex vs RwLock | RwLock | Dispatch (read) far more frequent than register (write) |
| Origin filtering | Per-batch vs per-hook | Per-hook | Hooks should only receive changes they care about |
| Dispatch signature | async fn vs sync fn | sync fn | Sync returns immediately after spawning async hooks |
| External crates | hookable, tower, bevy | Roll own | ~50 LOC, simpler than integrating external dependency |

## Prior Art Research

Searched for existing crates:
- **hookable**: 7.69% documented, no priority support
- **tower**: Request/response middleware, wrong pattern for broadcast
- **bevy_ecs observers**: No priority ordering, ECS-specific

Conclusion: Roll our own (~50 lines of implementation).

## Setup for Next Unit

Unit 1.5.3 (Origin Filtering) should:

1. **Already works** - origin filtering is implemented in `dispatch()` using `should_process()`
2. **Test focus** - add integration test verifying:
   - Hook writes with `Origin::Hook` don't re-trigger hooks
   - Remote changes don't trigger MetadataHook
   - Remote changes DO trigger TantivyIndexHook
3. **Consider** - is 1.5.3 still needed as separate unit, or merge into 2.1 (Metadata Schema)?

### Suggested Integration Test

```rust
#[test]
fn test_no_infinite_loop() {
    struct MetadataWritingHook { writes: AtomicUsize }

    impl BlockHook for MetadataWritingHook {
        fn accepts_origins(&self) -> Option<Vec<Origin>> {
            Some(vec![Origin::User]) // Not Hook
        }
        fn process(&self, batch: &BlockChangeBatch, store: Arc<YDocStore>) {
            self.writes.fetch_add(1, Ordering::SeqCst);
            // Would write metadata with Origin::Hook here
        }
    }

    // Register hook, dispatch User change
    // Verify writes == 1 (not infinite)
}
```

## Blockers for Next Unit

None. Registry is ready for hook registration.

## Approach Changes

Consider skipping Unit 1.5.3 as separate work:
- Origin filtering is already implemented and tested
- Loop prevention is verified by `test_dispatch_origin_filtering`
- Could merge verification into Unit 2.1 (Metadata Schema) which will create a real MetadataHook

**Recommended**: Proceed to Unit 2.1 directly, with explicit loop prevention test in its scope.
