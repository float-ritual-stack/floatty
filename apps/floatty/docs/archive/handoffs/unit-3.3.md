# Work Unit 3.3 - TantivyIndexHook (COMPLETED)

**Completed**: 2026-01-11 @ 02:19 AM
**Status**: ✅ Complete

## What Was Built

### 1. TantivyIndexHook (`src-tauri/floatty-core/src/hooks/tantivy_index.rs`)

Hook that bridges BlockChange events to WriterHandle operations:

```rust
pub struct TantivyIndexHook {
    writer: WriterHandle,
}

impl BlockHook for TantivyIndexHook {
    fn name(&self) -> &'static str { "tantivy_index" }
    fn priority(&self) -> i32 { 50 }  // After metadata hooks
    fn is_sync(&self) -> bool { false }  // Async
    fn accepts_origins(&self) -> Option<Vec<Origin>> {
        Some(vec![Origin::User, Origin::Remote, Origin::Agent, Origin::BulkImport])
    }
}
```

**BlockChange → WriterMessage mapping**:
| BlockChange | Action |
|-------------|--------|
| Created | `add_or_update()` |
| ContentChanged | `add_or_update()` |
| MetadataChanged | `add_or_update()` (updates has_markers) |
| Deleted | `delete()` |
| Moved, CollapsedChanged | no-op |

### 2. BlockType::as_str() (`src-tauri/floatty-core/src/block.rs`)

Added method for converting BlockType enum to lowercase string:

```rust
impl BlockType {
    pub fn as_str(&self) -> &'static str {
        match self {
            BlockType::Text => "text",
            BlockType::Sh => "sh",
            // ... all 17 variants
        }
    }
}
```

### 3. HookSystem Search Integration (`src-tauri/floatty-core/src/hooks/system.rs`)

Updated `HookSystem::initialize()` to:
1. Create IndexManager (opens/creates `~/.floatty/search_index/`)
2. Spawn TantivyWriter actor
3. Register TantivyIndexHook (priority 50)
4. Spawn periodic commit task (every 5 seconds)
5. Expose `index_manager()` getter for Unit 3.4

**New struct fields**:
```rust
pub struct HookSystem {
    // ... existing fields ...
    index_manager: Option<Arc<IndexManager>>,
    writer_handle: Option<WriterHandle>,
    _commit_handle: Option<tokio::task::JoinHandle<()>>,
}
```

**Graceful degradation**: If search initialization fails, continues without search (logs warning).

### 4. WriterHandle::from_sender (test helper)

Added `#[cfg(test)]` constructor for mock WriterHandle in unit tests.

## Files Changed

| File | Change |
|------|--------|
| `floatty-core/src/hooks/tantivy_index.rs` | NEW - Hook implementation |
| `floatty-core/src/hooks/mod.rs` | Export module + re-export |
| `floatty-core/src/hooks/system.rs` | Search wiring + commit task |
| `floatty-core/src/block.rs` | BlockType::as_str() method |
| `floatty-core/src/search/writer.rs` | from_sender() test helper |

## Tests

- **162 Rust tests pass** (floatty-core)
- **9 Rust tests pass** (floatty-server)
- **318 TypeScript tests pass** (frontend)

New tests:
- `tantivy_index::tests::*` - 8 tests for hook behavior and origin filtering

## Architecture State

```text
Frontend (SolidJS)
    │
    │ WebSocket (Y.Doc sync)
    ▼
floatty-server
    │
    ├── YDocStore.apply_update()
    │       │
    │       └── emit_changes() → ChangeCallback
    │                               │
    │                               ▼
    │                           HookSystem
    │                               │
    │                               ├── MetadataExtractionHook (priority 10)
    │                               ├── PageNameIndexHook (priority 20)
    │                               └── TantivyIndexHook (priority 50) ← NEW
    │                                       │
    │                                       ▼
    │                                   WriterHandle
    │                                       │
    │                                       ▼
    │                                   TantivyWriter (actor)
    │                                       │
    │                                       ▼
    │                                   ~/.floatty/search_index/
    │
    └── Periodic Commit Task (every 5s) → WriterHandle::commit()
```

## Next: Unit 3.4 - Search Service

Create SearchService for queries:

```rust
pub struct SearchService {
    index: Arc<IndexManager>,
}

impl SearchService {
    pub fn search(&self, query: &str, limit: usize) -> Vec<SearchHit>;
    pub fn search_with_filters(&self, query: &str, filters: SearchFilters, limit: usize) -> Vec<SearchHit>;
}
```

**Key considerations**:
1. Use `HookSystem::index_manager()` to get IndexManager
2. SearchHit contains: block_id, score, snippet
3. Use Tantivy's QueryParser with content field
4. Return IDs only - hydrate full blocks from Y.Doc

## Verification Commands

```bash
# All tests
cd src-tauri && cargo test -p floatty-core --lib

# Search-specific tests
cargo test -p floatty-core tantivy --lib

# Run server with debug logging
RUST_LOG=floatty_core=debug cargo run -p floatty-server
```

## Blockers

None. Ready for Unit 3.4.
