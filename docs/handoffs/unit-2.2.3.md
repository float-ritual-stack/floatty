# Handoff: Unit 2.2.3 - Hook System Wiring

**Completed**: 2026-01-10 @ 11:44 PM
**Status**: ✅ Complete

## What Was Done

- Created `hooks/system.rs` with `HookSystem` struct and `initialize()` function
- HookRegistry created at startup with MetadataExtractionHook registered
- Spawned dispatch task that subscribes to ChangeEmitter and dispatches to hooks
- Implemented cold-start rehydration: iterates existing blocks, emits `BulkImport` changes
- Integrated into `floatty-server/src/main.rs` (HookSystem initialized after store creation)

## Files Changed

| File | Change |
|------|--------|
| `floatty-core/src/hooks/system.rs` | NEW - HookSystem, dispatch task, cold-start rehydration |
| `floatty-core/src/hooks/mod.rs` | Added `system` submodule and `HookSystem` re-export |
| `floatty-core/src/lib.rs` | Added `HookSystem` to re-exports |
| `floatty-server/src/main.rs` | Initialize HookSystem at startup |

## Types/Functions Added

### HookSystem (`hooks::system`)

```rust
pub struct HookSystem {
    registry: Arc<HookRegistry>,
    emitter: ChangeEmitter,
    _dispatch_handle: tokio::task::JoinHandle<()>,
}

impl HookSystem {
    /// Initialize with default hooks (MetadataExtractionHook)
    /// Also performs cold-start rehydration
    pub fn initialize(store: Arc<YDocStore>) -> Self

    /// Get registry reference
    pub fn registry(&self) -> &Arc<HookRegistry>

    /// Get emitter reference for external emission
    pub fn emitter(&self) -> &ChangeEmitter

    /// Emit a batch of changes
    pub fn emit(&self, batch: BlockChangeBatch) -> Result<usize, EmitError>

    /// Emit a single change
    pub fn emit_change(&self, change: BlockChange) -> Result<usize, EmitError>
}
```

### Helper Functions

```rust
/// Spawn dispatch task: emitter → registry
fn spawn_dispatch_task(
    rx: broadcast::Receiver<Arc<BlockChangeBatch>>,
    registry: Arc<HookRegistry>,
    store: Arc<YDocStore>,
) -> tokio::task::JoinHandle<()>

/// Iterate existing blocks, emit BulkImport changes for rehydration
fn rehydrate_existing_blocks(emitter: &ChangeEmitter, store: &YDocStore) -> usize
```

## Tests Added

| Test | What it verifies |
|------|------------------|
| `test_hook_system_initialize` | HookSystem creates with MetadataExtractionHook registered |
| `test_rehydration_emits_changes` | Cold start emits BulkImport changes for existing blocks |
| `test_rehydration_skips_empty_content` | Empty blocks not included in rehydration |
| `test_dispatch_task_receives_changes` | Emitted changes dispatched to hooks |
| `test_full_integration_metadata_populated` | End-to-end: block with markers → metadata populated |

## Decisions Made

| Decision | Options Considered | Choice | Rationale |
|----------|-------------------|--------|-----------|
| HookSystem ownership | Separate registry/emitter vs combined | Combined struct | Easier lifecycle management, single point of initialization |
| Dispatch task | Inline dispatch vs spawned task | Spawned task | Non-blocking, handles broadcast channel async recv |
| Cold start origin | User vs BulkImport | BulkImport | Semantically correct, hooks can filter if needed |
| Empty block handling | Include all vs skip empty | Skip empty | No metadata to extract, avoids noise |

## Architecture Notes

### Initialization Flow

```
floatty-server main.rs
    │
    ▼
YDocStore::new()
    │
    ▼
HookSystem::initialize(store)
    │
    ├── Create HookRegistry
    │
    ├── Register MetadataExtractionHook (priority 10)
    │
    ├── Create ChangeEmitter
    │
    ├── spawn_dispatch_task(rx, registry, store)
    │       │
    │       └── loop { rx.recv() → registry.dispatch() }
    │
    └── rehydrate_existing_blocks()
            │
            └── for block in Y.Doc → emit ContentChanged(BulkImport)
```

### Runtime Flow (after startup)

```
External change (API, sync, etc.)
    │
    ▼
emitter.emit_batch(changes)
    │
    ▼
dispatch task receives
    │
    ▼
registry.dispatch(&batch, store)
    │
    ├── MetadataExtractionHook (priority 10, sync)
    │       └── extract markers/wikilinks → store.update_block_metadata()
    │
    └── [future] PageNameIndexHook (priority 20)
            └── update autocomplete index
```

## What's NOT Done Yet

1. **External emission**: The HookSystem has `emit()` methods, but no external caller uses them yet. The API routes would need to emit changes when blocks are created/updated.

2. **API integration**: Creating a block via REST API doesn't trigger hooks because the API doesn't emit changes to the HookSystem. This is a separate concern (Unit 2.4 or new unit).

## Setup for Next Unit

Unit 2.4 (PageNameIndex) can now:

1. **Create PageNameIndexHook** at priority 20
2. **Subscribe to HookSystem emitter** (or be registered with HookRegistry)
3. **Read metadata.outlinks** populated by MetadataExtractionHook
4. **Track existing pages** (blocks under `pages::`)
5. **Track referenced pages** (from outlinks)
6. **Mark stubs** (referenced but not existing)
7. **Expose search method** for autocomplete

### PageNameIndex Design

```rust
pub struct PageNameIndexHook {
    index: Arc<RwLock<PageNameIndex>>,
}

pub struct PageNameIndex {
    existing: HashSet<String>,    // Blocks under pages::
    referenced: HashSet<String>,  // From metadata.outlinks
}

impl PageNameIndex {
    pub fn search(&self, prefix: &str) -> Vec<PageSuggestion>;
}
```

## Blockers for Next Unit

**None** - hook system is wired and running. MetadataExtractionHook populates `block.metadata` on content changes.

## Approach Changes

Consider adding a separate unit for **API → HookSystem integration**:
- API routes need to emit changes when blocks are mutated via REST
- This enables external tools (CLI, agents) to trigger metadata extraction
- Could be Unit 2.3.5 or folded into Unit 2.4

---

**Test Results**:
- `cargo test -p floatty-core` → 117 passed
- `cargo test -p floatty-server` → 9 passed
- `npm run test` → 318 passed
