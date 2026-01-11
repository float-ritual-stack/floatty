# Handoff: Unit 2.1 - Metadata Schema

**Completed**: 2026-01-10 @ 11:20 PM
**Status**: ✅ Complete

## What Was Done

- Created `BlockMetadata` struct with typed fields for markers, outlinks, and stub detection
- Created `Marker` struct for `::` pattern storage (type + optional value)
- Updated `Block` struct to use `Option<BlockMetadata>` instead of `Option<serde_json::Value>`
- Generated TypeScript bindings via ts-rs
- Updated TypeScript `Block` interface to use generated `BlockMetadata` type
- Added 8 new unit tests for metadata types

## Files Changed

| File | Change |
|------|--------|
| `floatty-core/src/metadata.rs` | NEW - Metadata types with 8 unit tests |
| `floatty-core/src/block.rs` | Updated metadata field to use `BlockMetadata` |
| `floatty-core/src/lib.rs` | Added `metadata` module and re-exports |
| `src/generated/BlockMetadata.ts` | NEW - ts-rs generated type |
| `src/generated/Marker.ts` | NEW - ts-rs generated type |
| `src/generated/Block.ts` | Updated to reference `BlockMetadata` |
| `src/lib/blockTypes.ts` | Updated imports and `Block` interface |

## Types Added

### Rust (floatty-core)

```rust
pub struct Marker {
    pub marker_type: String,
    pub value: Option<String>,
}

pub struct BlockMetadata {
    pub markers: Vec<Marker>,
    pub outlinks: Vec<String>,
    pub is_stub: bool,
    pub extracted_at: Option<i64>,
}
```

### TypeScript (generated)

```typescript
export type Marker = {
  markerType: string;
  value: string | null;
};

export type BlockMetadata = {
  markers: Array<Marker>;
  outlinks: Array<string>;
  isStub: boolean;
  extractedAt: number | null;
};
```

## Tests Added

| Test | What it verifies |
|------|------------------|
| `test_marker_new` | Marker without value |
| `test_marker_with_value` | Marker with value |
| `test_metadata_empty` | Empty metadata is_empty() |
| `test_metadata_add_marker` | Adding markers |
| `test_metadata_add_outlink` | Adding outlinks |
| `test_metadata_markers_of_type` | Filtering by type |
| `test_metadata_stub` | Stub flag handling |
| `test_metadata_serialization` | JSON round-trip |
| `test_metadata_skip_empty_fields` | Empty fields not serialized |

## Decisions Made

| Decision | Options Considered | Choice | Rationale |
|----------|-------------------|--------|-----------|
| Marker value | Always present vs Optional | Optional | Prefix markers like `sh::` have no value |
| outlinks | Array vs HashSet | Array | Preserve order, allow duplicates for nested wikilinks |
| extracted_at | Required vs Optional | Optional | Null until first extraction |
| is_stub | Separate flag vs inferred | Separate flag | Simplifies queries, explicit over inferred |

## API Layer Note

The floatty-server API layer (`api.rs`) still uses `serde_json::Value` for metadata in request/response DTOs. This is intentional:
- API accepts arbitrary JSON for maximum flexibility
- Hooks can deserialize to `BlockMetadata` when processing
- Allows agents to store custom metadata fields without schema changes

When hooks write metadata, they serialize `BlockMetadata` to JSON for Y.Doc storage.

## Setup for Next Unit

Unit 2.2 (Marker Extraction) should:

1. Create a `MetadataExtractionHook` implementing `BlockHook`
2. Subscribe to `BlockChange::ContentChanged` events
3. Parse content for `::` markers (reuse patterns from `inlineParser.ts`)
4. Parse content for `[[wikilinks]]` (reuse patterns from `wikilinkUtils.ts`)
5. Write extracted `BlockMetadata` to block via store update
6. Use `Origin::Hook` to prevent infinite loops

### Key Patterns to Extract

**Prefix markers** (derived from block type):
- `sh::`, `term::` → `Marker { type: "sh", value: None }`
- `ai::`, `chat::` → `Marker { type: "ai", value: None }`
- `ctx::` → `Marker { type: "ctx", value: None }`

**Tag markers** (inline in content):
- `[project::floatty]` → `Marker { type: "project", value: Some("floatty") }`
- `[mode::dev]` → `Marker { type: "mode", value: Some("dev") }`

**Wikilinks**:
- `[[Page Name]]` → outlinks: ["Page Name"]
- `[[Target|Alias]]` → outlinks: ["Target"]
- `[[outer [[inner]]]]` → outlinks: ["outer [[inner]]", "inner"]

## Blockers for Next Unit

None. Schema is ready for population.

## Approach Changes

None needed - proceeding as planned.

---

**Test Results**:
- `cargo test -p floatty-core` → 75 passed
- `cargo test -p floatty-server` → 9 passed
- `npm run test` → 318 passed
