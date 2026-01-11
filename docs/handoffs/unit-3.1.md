# Work Unit 3.1 - Tantivy Setup (COMPLETED)

## What Was Built

Tantivy search index infrastructure for floatty blocks:

1. **Tantivy Dependency** (`Cargo.toml`):
   - Added `tantivy = "0.25"` (upgraded from 0.22 during PR review)
   - Compiles successfully with all existing code

2. **Schema Definition** (`src-tauri/floatty-core/src/search/schema.rs`):
   - 6 fields matching spec:
     - `block_id`: STRING | STORED (primary key for deletions)
     - `content`: TEXT (full-text search with tokenization)
     - `block_type`: STRING | FAST (facet filtering: sh, ai, ctx, etc.)
     - `parent_id`: STRING | STORED (context retrieval)
     - `updated_at`: DATE | FAST | STORED (recency sorting)
     - `has_markers`: BOOL | FAST | STORED (filter for ctx:: blocks)
   - `build_schema()` function creates schema
   - `get_field()` helper for type-safe field access

3. **IndexManager** (`src-tauri/floatty-core/src/search/index_manager.rs`):
   - `open_or_create()` - Opens/creates index at `~/.floatty/search_index/`
   - `open_or_create_at(path)` - For testing with temp directories
   - `index()` - Returns Tantivy Index reference
   - `schema()` - Returns Schema reference
   - `fields()` - Returns `SchemaFields` struct with typed field references
   - `path()` - Returns index path for debugging

4. **SchemaFields** struct:
   - Strongly-typed field references (no string lookups at runtime)
   - Fields: `block_id`, `content`, `block_type`, `parent_id`, `updated_at`, `has_markers`

5. **Error Types** (`src-tauri/floatty-core/src/search/mod.rs`):
   - `SearchError::CreateDir` - I/O error creating directory
   - `SearchError::Tantivy` - Tantivy operation error
   - `SearchError::OpenDir` - Directory open error
   - `SearchError::OpenIndex` - Index open error
   - `SearchError::NoIndexDir` - Home directory not found

## Tests Added

All new tests pass (148 total in floatty-core):

**Schema tests** (`schema.rs`):
- `test_schema_has_all_fields` - All 6 fields exist
- `test_schema_field_count` - Exactly 6 fields
- `test_block_id_is_stored` - block_id is stored for retrieval
- `test_content_is_text` - content is indexed for full-text search
- `test_get_field_helper` - Helper returns valid fields
- `test_get_field_panics_on_missing` - Panics on nonexistent field

**IndexManager tests** (`index_manager.rs`):
- `test_open_creates_index` - Creates new index in empty directory
- `test_open_existing_index` - Reopens existing index
- `test_schema_fields_accessible` - Field names match schema
- `test_can_create_writer` - Writer creation succeeds
- `test_can_create_reader` - Reader creation succeeds
- `test_index_path_method` - Path getter returns correct path
- `test_get_index_path` - Default path is `~/.floatty/search_index/`

## Files Changed

```
floatty-core:
  Cargo.toml                          - Added tantivy = "0.22"
  src/lib.rs                          - Added search module and re-exports
  src/search/mod.rs                   - NEW: Module structure, SearchError
  src/search/schema.rs                - NEW: Schema definition
  src/search/index_manager.rs         - NEW: IndexManager struct
```

## Verification

```bash
# Build passes
cargo build -p floatty-core
# → Finished `dev` profile in 11.93s

# All tests pass
cargo test -p floatty-core --lib
# → 148 passed; 0 failed
```

## Decisions Made

| Decision | Rationale |
|----------|-----------|
| Store `index_path` in IndexManager | ManagedDirectory doesn't expose path; need it for debugging |
| Use Tantivy 0.22 | Latest stable (note: `IndexSortByField` deprecated in 0.23) |
| No index sorting | `IndexSortByField` deprecated, deferred to query-time sorting |
| `get_field()` returns panic on missing | Schema is static, missing field is programmer error |

## Next: Unit 3.2 (Writer Actor)

Unit 3.2 will:
1. Create `TantivyWriter` actor with bounded mpsc channel (capacity: 1000)
2. Implement message types:
   - `AddOrUpdate { id, doc }` → delete_term + add_document
   - `Delete { id }` → delete_term only
   - `Commit` → writer.commit()
3. Handle concurrent writes safely

**IndexManager provides**:
```rust
let manager = IndexManager::open_or_create()?;
let writer = manager.index().writer::<TantivyDocument>(50_000_000)?;
let fields = manager.fields();

// For term-based deletion:
use tantivy::Term;
let term = Term::from_field_text(fields.block_id, "block_123");
writer.delete_term(term);

// For adding documents:
let mut doc = TantivyDocument::new();
doc.add_text(fields.block_id, "block_123");
doc.add_text(fields.content, "Hello world");
writer.add_document(doc)?;
```

---
Completed: 2026-01-11 @ 12:30 AM
