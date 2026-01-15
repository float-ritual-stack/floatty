# Work Unit 3.2 - Writer Actor + CodeRabbit Cleanup (COMPLETED)

**Completed**: 2026-01-11 @ 01:58 AM
**Commits**: `5905372`, `490e888`

## What Was Built

### 1. TantivyWriter Actor (`src-tauri/floatty-core/src/search/writer.rs`)

Actor pattern for async Tantivy index updates:

```rust
pub struct TantivyWriter {
    writer: IndexWriter,
    fields: SchemaFields,
    rx: mpsc::Receiver<WriterMessage>,
}

pub struct WriterHandle {
    tx: mpsc::Sender<WriterMessage>,
}

/// Messages that can be sent to the writer actor.
pub enum WriterMessage {
    /// Add or update a document (delete by ID first, then add).
    AddOrUpdate {
        block_id: String,
        content: String,
        block_type: String,
        parent_id: Option<String>,
        updated_at: i64,
        has_markers: bool,
    },
    /// Delete a document by block ID.
    Delete { block_id: String },
    /// Commit pending changes to disk.
    Commit,
    /// Shutdown the actor.
    Shutdown,
}
```

**Key design decisions**:
- Bounded mpsc channel (1000 capacity) provides backpressure during bulk indexing
- Term-based deletion pattern: `delete_term()` then `add_document()` for updates
- Actor runs in tokio task, owned by `WriterHandle`
- 50MB heap size for IndexWriter

### 2. Y.Doc Observation Wiring (`src-tauri/floatty-core/src/store.rs`)

All block mutations now trigger hooks:

```rust
// store.rs - snapshot/diff approach
pub fn set_change_callback(&self, callback: impl Fn(Vec<BlockChange>) + Send + Sync + 'static)

// In apply_update():
let before = self.snapshot_blocks();
// ... apply Y.Doc update ...
let after = self.snapshot_blocks();
let changes = self.compute_changes(&before, &after);
self.emit_changes(changes);
```

**Critical fix**: Changed `Origin::Remote` → `Origin::User` because `MetadataExtractionHook` only accepts `[User, Agent, BulkImport]` origins.

### 3. CodeRabbit PR Review Fixes

| Fix | File | Change |
|-----|------|--------|
| Tantivy upgrade | `Cargo.toml` | 0.22 → 0.25 |
| TempDir lifetime | `hooks/system.rs` | Return `(TempDir, Arc<YDocStore>)` tuple |
| Cleanup behavior | `BlockItem.tsx` | `flushContentUpdate()` not `cancelContentUpdate()` |
| Unused field | `api.rs` | Removed `origin` from request structs |
| Docs | Various | Pipe escapes, code fence languages, test counts |

## Files Changed

| File | Purpose |
|------|---------|
| `src-tauri/floatty-core/Cargo.toml` | Added tokio dependency for mpsc |
| `src-tauri/floatty-core/src/search/writer.rs` | NEW - Writer actor |
| `src-tauri/floatty-core/src/search/mod.rs` | Exports, WriterClosed error |
| `src-tauri/floatty-core/src/lib.rs` | Re-exports |
| `src-tauri/floatty-core/src/store.rs` | Y.Doc observation + Origin fix |
| `src-tauri/floatty-core/src/hooks/system.rs` | TempDir fix, change callback wiring |
| `src-tauri/floatty-server/src/api.rs` | Hook emission, origin field removal |
| `src-tauri/floatty-server/src/main.rs` | Hook system initialization |
| `src/components/BlockItem.tsx` | Cleanup flush fix |

## Tests

- **154 Rust tests pass**
- Writer tests (6 new): `test_add_or_update`, `test_delete`, `test_commit`, `test_shutdown`, `test_capacity`, `test_update_replaces`

Note: The 19 search-related tests were added in Unit 3.4 (SearchService), not this unit.

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
    │       ├── snapshot/diff → compute_changes()
    │       │
    │       └── emit_changes() → ChangeCallback
    │                               │
    │                               ▼
    │                           HookSystem
    │                               │
    │                               ├── MetadataExtractionHook (priority 10)
    │                               └── PageNameIndexHook (priority 20)
    │
    └── REST API (create/update/delete_block)
            │
            └── Also emits BlockChange → HookSystem
```

## Next: Unit 3.3 - TantivyIndexHook

Create hook that maps BlockChange events to WriterHandle operations:

```rust
pub struct TantivyIndexHook {
    writer: WriterHandle,
}

impl BlockHook for TantivyIndexHook {
    fn name(&self) -> &'static str { "tantivy_index" }
    fn priority(&self) -> i32 { 50 }  // After metadata hooks
    fn is_sync(&self) -> bool { false }  // Async
    fn accepts_origins(&self) -> Option<Vec<Origin>> {
        Some(vec![Origin::User, Origin::Agent, Origin::BulkImport])
        // NOT Origin::Hook - don't index metadata-only updates
    }

    async fn handle(&self, change: &BlockChange, store: &YDocStore) -> Result<()> {
        match change {
            BlockChange::Created { id, .. } |
            BlockChange::ContentChanged { id, .. } => {
                let block = store.get_block(id)?;
                self.writer.add_or_update(
                    id.clone(),
                    block.content,
                    block.block_type,
                    block.parent_id,
                    now(),
                    !block.metadata.markers.is_empty(),
                ).await?;
            }
            BlockChange::Deleted { id, .. } => {
                self.writer.delete(id.clone()).await?;
            }
            _ => {} // Moved, Collapsed - no index update needed
        }
        Ok(())
    }
}
```

**Key considerations for Unit 3.3**:
1. Register in `HookSystem::initialize()` after creating WriterHandle
2. Commit strategy: periodic commit task or commit after batch
3. Cold-start rehydration should index existing blocks (BulkImport origin)
4. Block type extraction from content prefix (`sh::`, `ai::`, etc.)

## Verification Commands

```bash
# All tests
cargo test -p floatty-core --lib

# Search tests only
cargo test -p floatty-core search:: --lib

# Run server with debug logging
RUST_LOG=floatty_core=debug,floatty_server=debug cargo run -p floatty-server
```

## Blockers

None. Ready for Unit 3.3.
