# Handoff: Unit 0.1 - Origin Enum

**Completed**: 2026-01-10 @ 08:42 PM
**Status**: ✅ Complete

## What Was Done

- Created `Origin` enum with five variants: `User`, `Hook`, `Remote`, `Agent`, `BulkImport`
- Added derive macros: `Debug`, `Clone`, `Copy`, `PartialEq`, `Eq`, `Hash`, `Default`, `Serialize`, `Deserialize`
- Added serde `snake_case` rename for JSON compatibility
- Added helper methods:
  - `triggers_metadata_hooks()` - returns true for User/Agent/BulkImport (not Hook/Remote)
  - `triggers_index_hooks()` - returns true for User/Remote/Agent/BulkImport (not Hook)
- Added `Display` impl for string conversion
- Added `TryFrom<&str>` for parsing from Y.Doc transaction origin strings
- Exported from `lib.rs`

## Files Changed

| File | Change |
|------|--------|
| `floatty-core/src/origin.rs` | New file - Origin enum definition |
| `floatty-core/src/lib.rs` | Added `pub mod origin` and `pub use origin::Origin` |

## Tests Added

| Test | What it verifies |
|------|------------------|
| `test_origin_equality` | Enum comparison works |
| `test_origin_copy` | Copy semantics (not move) |
| `test_origin_display` | String formatting |
| `test_origin_from_str` | Parsing from strings (case-insensitive) |
| `test_triggers_metadata_hooks` | Correct filtering for metadata hooks |
| `test_triggers_index_hooks` | Correct filtering for index hooks |
| `test_serde_roundtrip` | JSON serialization/deserialization |
| `test_serde_snake_case` | Verifies `bulk_import` serializes as `"bulk_import"` |

## Decisions Made

| Decision | Options Considered | Choice | Rationale |
|----------|-------------------|--------|-----------|
| Snake_case serde | snake_case vs camelCase | snake_case | Matches TypeScript origin strings (`'bulk_import'`) |
| Helper methods | Traits vs methods | Methods | Simpler, enum is small |
| Default variant | User vs None | User | Most common case, matches TS default |
| TryFrom error type | Custom error vs `()` | `()` | Simple parsing, no context needed |

## Blockers Encountered

None.

## Simplifications Made

- Replaced manual `Default` impl with `#[derive(Default)]` + `#[default]` attribute per clippy suggestion
- Marked doc example as `ignore` since it references types (BlockChange, YDocStore.update_metadata) that don't exist yet

## Setup for Next Unit

Unit 0.2 should:
1. Import `Origin` into store.rs (already exported)
2. Add origin parameter to YDocStore methods that mutate
3. **NOTE**: Current YDocStore doesn't have block-level mutation methods - it only has `apply_update()` for applying pre-encoded Y.Doc updates
4. The actual block mutations happen in TypeScript (useBlockStore.ts) which already has `'user'` origin strings on transactions
5. Unit 0.2 may need to focus on the Hook Registry's use of Origin for filtering, rather than adding origin to store methods

## Approach Changes

Based on code review:

- **Original Plan**: Add origin parameter to YDocStore mutation methods
- **Reality**: YDocStore doesn't have mutation methods - mutations happen in TypeScript Y.Doc, then sync to Rust
- **Revised approach for 0.2**:
  - Skip adding origin to YDocStore methods (no such methods exist)
  - Instead, focus on preparing for Unit 1.5.x (Hook Registry) which will use Origin for filtering
  - Unit 0.2 can be considered already partially complete (TS side done in commit 5b5227a)

**Recommendation**: Proceed directly to Phase 1.x (Change Emitter) since origin tagging in transactions is already done in TypeScript.
