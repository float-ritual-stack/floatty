# Work Unit 2.4 - PageNameIndex (COMPLETED)

## What Was Built

PageNameIndex - Fast autocomplete index for [[wikilinks]]:

1. **PageNameIndex** (`src-tauri/floatty-core/src/hooks/page_name_index.rs`):
   - Tracks **existing pages** (direct children of `pages::` container)
   - Tracks **referenced pages** (from `metadata.outlinks` across all blocks)
   - `search(prefix)` returns suggestions: existing pages first, then stubs
   - Case-insensitive prefix matching

2. **PageNameIndexHook**:
   - Priority 20 (after MetadataExtractionHook at 10)
   - Processes Created, ContentChanged, Deleted, Moved events
   - Updates index when blocks enter/leave `pages::` container
   - Reads `metadata.outlinks` from store to track references

3. **YDocStore.get_block()** (`src-tauri/floatty-core/src/store.rs`):
   - New method to read block by ID from Y.Doc
   - Returns `Option<Block>` with all fields including metadata

4. **HookSystem.page_name_index()** (`src-tauri/floatty-core/src/hooks/system.rs`):
   - Exposes PageNameIndex Arc for external access
   - HookSystem now owns PageNameIndexHook reference

5. **REST API** (`src-tauri/floatty-server/src/api.rs`):
   - `GET /api/v1/pages/search?prefix=xxx&limit=10`
   - Returns `{ pages: [{ name: string, isStub: boolean }] }`

## Tests Added

- `PageNameIndex` unit tests (search, add/remove, stubs, prefix matching)
- Helper function tests (strip_heading_prefix, is_pages_container)
- Hook trait tests (priority, origin filtering)
- All 135 floatty-core tests pass
- All 9 floatty-server tests pass

## Files Changed

```
floatty-core:
  src/hooks/mod.rs          - Export PageNameIndex, PageNameIndexHook, PageSuggestion
  src/hooks/page_name_index.rs - NEW: Index + Hook implementation
  src/hooks/system.rs       - Register PageNameIndexHook, expose index
  src/lib.rs                - Re-export new types
  src/store.rs              - Add get_block() method

floatty-server:
  src/api.rs                - Add page search endpoint, update AppState
  src/main.rs               - Pass HookSystem to create_router
```

## Verification

```bash
cargo test -p floatty-core --lib     # 135 tests
cargo test -p floatty-server         # 9 tests

# Manual test after running server:
curl "http://localhost:8765/api/v1/pages/search?prefix=my"
```

## Next: Unit 3.1 (Tantivy Crate Setup)

The next unit sets up Tantivy for full-text search. The PageNameIndex provides fast prefix matching for [[wikilinks]], while Tantivy will enable content search across all blocks.

Entry checklist for 3.1:
- [ ] Unit 2.4 committed (PageNameIndex complete)
- [ ] Understand Tantivy schema requirements from SEARCH_ARCHITECTURE_LAYERS.md

---
Completed: 2026-01-10
