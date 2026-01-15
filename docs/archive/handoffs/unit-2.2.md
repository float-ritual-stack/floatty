# Handoff: Unit 2.2 - Marker Extraction Hook

**Completed**: 2026-01-10 @ 11:31 PM
**Status**: ✅ Complete

## What Was Done

- Created `parsing.rs` with marker and wikilink extraction functions
- Created `MetadataExtractionHook` implementing `BlockHook` trait
- Added `update_block_metadata()` method to `YDocStore` for hooks to write metadata
- Added regex, chrono, and tracing dependencies to floatty-core
- Ported wikilink parsing from TypeScript (bracket-counting algorithm)
- Ported marker parsing (prefix `sh::` and tag `[project::X]` patterns)

## Files Changed

| File | Change |
|------|--------|
| `floatty-core/src/hooks/parsing.rs` | NEW - Marker/wikilink parsing utils with 30 tests |
| `floatty-core/src/hooks/metadata_extraction.rs` | NEW - Hook implementation with 9 tests |
| `floatty-core/src/hooks/mod.rs` | Added module exports and re-exports |
| `floatty-core/src/store.rs` | Added `update_block_metadata()` method |
| `floatty-core/src/lib.rs` | Added re-exports for hook and parsing |
| `floatty-core/Cargo.toml` | Added regex, chrono, tracing dependencies |

## Types/Functions Added

### Parsing Module (`hooks::parsing`)

```rust
// Prefix markers (sh::, ctx::, ai::, etc.)
pub fn extract_prefix_marker(content: &str) -> Option<String>

// Tag markers ([project::floatty], [mode::dev])
pub fn extract_tag_markers(content: &str) -> Vec<Marker>

// Combined marker extraction
pub fn extract_all_markers(content: &str) -> Vec<Marker>

// Wikilink parsing (with nested bracket support)
pub fn find_wikilink_end(content: &str, start: usize) -> Option<usize>
pub fn parse_wikilink_inner(inner: &str) -> (String, Option<String>)
pub fn extract_wikilink_targets(content: &str) -> Vec<String>
pub fn has_wikilink_patterns(content: &str) -> bool
```

### MetadataExtractionHook

```rust
impl BlockHook for MetadataExtractionHook {
    fn name(&self) -> &'static str { "metadata_extraction" }
    fn priority(&self) -> i32 { 10 }
    fn is_sync(&self) -> bool { true }
    fn accepts_origins(&self) -> Option<Vec<Origin>> {
        Some(vec![Origin::User, Origin::Agent, Origin::BulkImport])
    }
    fn process(&self, batch: &BlockChangeBatch, store: Arc<YDocStore>) { ... }
}
```

### YDocStore Method

```rust
pub fn update_block_metadata(
    &self,
    block_id: &str,
    metadata: BlockMetadata,
) -> Result<(), StoreError>
```

## Tests Added

| Test | What it verifies |
|------|------------------|
| `test_prefix_marker_*` | sh::, ctx::, ai::, case insensitivity |
| `test_tag_marker_*` | [project::X] extraction, multiple tags |
| `test_find_wikilink_end_*` | Bracket counting for nested [[]] |
| `test_parse_inner_*` | Target/alias extraction, nested pipes |
| `test_extract_*` | Full wikilink extraction with recursion |
| `test_hook_*` | Hook trait compliance and origin filtering |

## Decisions Made

| Decision | Options Considered | Choice | Rationale |
|----------|-------------------|--------|-----------|
| Parsing in Rust | Port from TS vs call TS | Port | Keeps processing in Rust, no IPC overhead |
| Bracket counting | Regex vs manual | Manual | Regex can't handle arbitrary nesting |
| Nested targets | Extract all vs outer only | Extract all | Enables backlinks to both `[[outer [[inner]]]]` and `[[inner]]` |
| Store method | Direct Y.Doc access vs method | Method on YDocStore | Encapsulates transaction logic, consistent with existing pattern |

## Architecture Notes

### Hook Execution Flow

```
BlockChange::ContentChanged
    → HookRegistry.dispatch()
    → origin filter (accepts User, Agent, BulkImport)
    → MetadataExtractionHook.process()
        → extract_all_markers(content)
        → extract_wikilink_targets(content)
        → store.update_block_metadata(id, metadata)
            → Y.Doc transaction (no origin tag - hooks handle filtering)
```

### Origin Filtering Pattern

The hook explicitly **excludes** `Origin::Hook` and `Origin::Remote`:
- `Origin::Hook`: Prevents infinite loops (hook writing metadata triggering itself)
- `Origin::Remote`: Metadata already extracted at source client

### What's NOT Wired Yet

The hook is implemented but not registered anywhere at startup. The next unit (2.3 or 2.4) should:
1. Create a startup function that builds `HookRegistry`
2. Register `MetadataExtractionHook` with the registry
3. Connect the registry to the change emitter

## Setup for Next Unit

Unit 2.3 (Wikilink Extraction) is effectively **merged into this unit** - wikilink parsing is already implemented.

**Next actual unit**: Unit 2.4 (PageNameIndex) should:

1. Create `PageNameIndexHook` at priority 20
2. Track existing pages (blocks under `pages::`)
3. Track referenced pages (from `metadata.outlinks`)
4. Mark stubs (referenced but not existing)
5. Expose autocomplete search method

### PageNameIndex Design

```rust
pub struct PageNameIndex {
    existing: HashSet<String>,    // Blocks under pages::
    referenced: HashSet<String>,  // From metadata.outlinks
}

impl PageNameIndex {
    pub fn search(&self, prefix: &str) -> Vec<PageSuggestion>;
}
```

## Blockers for Next Unit

**HookRegistry startup wiring** - hooks are defined but not registered. This could be:
- Part of Unit 2.4 (first hook to need it runs the wiring)
- Separate unit if wiring is complex

## Approach Changes

None needed - proceeding as planned. Unit 2.3 (Wikilink Extraction) was absorbed since wikilink parsing was natural to include with marker parsing.

---

**Test Results**:
- `cargo test -p floatty-core` → 112 passed (6 doc tests ignored)
- `cargo test -p floatty-server` → 9 passed
- `npm run test` → 318 passed
