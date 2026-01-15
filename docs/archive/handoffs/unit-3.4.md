# Work Unit 3.4 - Search Service (COMPLETED)

**Completed**: 2026-01-11 @ 02:46 AM
**Status**: ✅ Complete

## What Was Built

### 1. SearchService (`src-tauri/floatty-core/src/search/service.rs`)

Query interface wrapping IndexManager for full-text search:

```rust
pub struct SearchService {
    index: Arc<IndexManager>,
}

impl SearchService {
    pub fn new(index: Arc<IndexManager>) -> Self;
    pub fn search(&self, query: &str, limit: usize) -> Result<Vec<SearchHit>, SearchError>;
    pub fn search_with_filters(
        &self,
        query: &str,
        filters: SearchFilters,
        limit: usize
    ) -> Result<Vec<SearchHit>, SearchError>;
}
```

### 2. SearchHit (`src-tauri/floatty-core/src/search/service.rs`)

Return type for search results:

```rust
pub struct SearchHit {
    pub block_id: String,  // Use to hydrate from Y.Doc
    pub score: f32,        // Tantivy relevance score
    pub snippet: Option<String>,  // Future: highlighted snippet
}
```

### 3. SearchFilters (`src-tauri/floatty-core/src/search/service.rs`)

Filter predicates for narrowing results:

```rust
pub struct SearchFilters {
    pub block_types: Option<Vec<String>>,  // OR within, AND with text query
    pub has_markers: Option<bool>,         // Filter by marker presence
    pub parent_id: Option<String>,         // Filter by parent (subtree search)
}
```

### 4. QueryParserError (`src-tauri/floatty-core/src/search/mod.rs`)

Added to SearchError enum for query parsing failures.

### 5. Schema Fix: has_markers Field

Changed `has_markers` from `bool` field to `STRING` field for term-based queries:

```rust
// Before: add_bool_field("has_markers", FAST | STORED)
// After:  add_text_field("has_markers", STRING | STORED)
```

**Breaking change**: Existing indexes need to be deleted (`rm -rf ~/.floatty/search_index/`).

## Query Architecture

```text
Query → QueryParser → text_query
                          │
Filters → filter_queries ─┤
                          ▼
                    BooleanQuery (text AND filters)
                          │
                          ▼
                    TopDocs::with_limit(limit)
                          │
                          ▼
                    [block_ids + scores]
                          │
                          ▼
                    Y.Doc → [full blocks]
```

**Key pattern**: Search returns IDs only. Hydrate full blocks from Y.Doc (CRDT is source of truth).

## Filter Logic

| Filter | Implementation |
|--------|----------------|
| `block_types` | OR within (any match), AND with text query |
| `has_markers` | Term query on "true"/"false" string |
| `parent_id` | Term query on exact parent ID |

All filters combine with AND logic against the text query.

## Files Changed

| File | Change |
|------|--------|
| `floatty-core/src/search/service.rs` | NEW - SearchService implementation |
| `floatty-core/src/search/mod.rs` | Export service, add QueryParse error |
| `floatty-core/src/search/schema.rs` | has_markers: bool → STRING |
| `floatty-core/src/lib.rs` | Re-export SearchService types |

## Tests

- **171 Rust tests pass** (floatty-core)
- 9 new tests in `search::service::tests`:
  - `test_search_basic`
  - `test_search_empty_query`
  - `test_search_no_matches`
  - `test_search_limit`
  - `test_search_filter_block_type`
  - `test_search_filter_multiple_types`
  - `test_search_filter_has_markers`
  - `test_search_combined_filters`
  - `test_search_score_ordering`

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
    │                               └── TantivyIndexHook (priority 50)
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
    ├── Periodic Commit Task (every 5s)
    │
    └── SearchService ← NEW
            │
            └── IndexManager.index().reader()
                    │
                    └── QueryParser → TopDocs → block_ids
```

## Next: Unit 3.5 - Tauri Commands

Wire SearchService to frontend via Tauri commands:

```rust
// In src-tauri/src/lib.rs or separate commands module

#[tauri::command]
pub async fn search_blocks(
    query: String,
    limit: Option<usize>,
    filters: Option<SearchFilters>,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<SearchHit>, String> {
    let service = SearchService::new(state.index_manager()?);
    let filters = filters.unwrap_or_default();
    service.search_with_filters(&query, filters, limit.unwrap_or(20))
        .map_err(|e| e.to_string())
}
```

**Key considerations**:
1. Access IndexManager via `HookSystem::index_manager()`
2. Handle `None` case (search not available)
3. Return SearchHit directly (block_id + score)
4. Frontend hydrates full blocks from Y.Doc

## Verification Commands

```bash
# All tests
cd src-tauri && cargo test -p floatty-core --lib

# Search-specific tests
cargo test -p floatty-core search:: --lib

# If schema changed, delete old index
rm -rf ~/.floatty/search_index/
```

## Blockers

None. Ready for Unit 3.5.
