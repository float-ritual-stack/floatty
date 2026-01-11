# Handoff: Unit 0.3 - API Origin + Metadata

**Completed**: 2026-01-10 @ 09:05 PM
**Status**: ✅ Complete

## What Was Done

- Added `metadata` field to Block struct (was commented out placeholder)
- Added `origin` parameter to CreateBlockRequest and UpdateBlockRequest
- Added `metadata` to BlockDto for API responses
- Updated `update_block` handler to support partial updates (content and/or metadata)
- All metadata extracted from Y.Doc and returned in API responses

## Files Changed

| File | Change |
|------|--------|
| `floatty-core/src/block.rs` | Added `metadata: Option<serde_json::Value>` with ts-rs type annotation |
| `floatty-server/src/api.rs` | Added origin to requests, metadata to responses, partial PATCH support |

## API Changes

### CreateBlockRequest
```rust
pub struct CreateBlockRequest {
    pub content: String,
    pub parent_id: Option<String>,
    #[serde(default)]
    pub origin: Option<String>,  // NEW: "user", "agent", "remote", etc.
}
```

### UpdateBlockRequest
```rust
pub struct UpdateBlockRequest {
    pub content: Option<String>,           // Now optional for partial updates
    pub metadata: Option<serde_json::Value>, // NEW: arbitrary JSON metadata
    #[serde(default)]
    pub origin: Option<String>,            // NEW: mutation source tag
}
```

### BlockDto
```rust
pub struct BlockDto {
    pub id: String,
    pub content: String,
    pub block_type: BlockType,
    pub parent_id: Option<String>,
    pub child_ids: Vec<String>,
    pub collapsed: bool,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,  // NEW: exposed in responses
}
```

## Tests Verified

| Package | Result |
|---------|--------|
| floatty-server | 9/9 pass |
| floatty-core | 23/23 pass |

## Decisions Made

| Decision | Options Considered | Choice | Rationale |
|----------|-------------------|--------|-----------|
| Origin as Option<String> | String vs Option<String> | Option<String> | Allows omission (defaults to User), matches TS flexibility |
| Partial PATCH | Replace whole block vs merge fields | Merge fields | Enables metadata-only updates without overwriting content |
| Metadata type | Typed struct vs serde_json::Value | serde_json::Value | Flexibility for hooks to store arbitrary data |
| ts-rs annotation | derive TS for Value vs explicit type | Explicit `#[ts(type = "Record<string, unknown> | null")]` | serde_json::Value doesn't impl TS trait |

## Blockers Encountered

1. **ts-rs trait bound error**: `serde_json::Value` doesn't implement TS trait
   - Fixed with explicit type annotation: `#[ts(type = "Record<string, unknown> | null")]`

2. **Partial update logic**: UpdateBlockRequest now has optional fields
   - Fixed by reading existing content/metadata and merging with request

## What Origin Enables

With origin in API requests, agents can now:
```bash
# Agent writes with proper origin tagging
curl -X POST http://127.0.0.1:8765/api/v1/blocks \
  -H "Content-Type: application/json" \
  -d '{"content": "ai:: analyze this", "origin": "agent"}'

# Hook writes metadata without triggering other hooks
curl -X PATCH http://127.0.0.1:8765/api/v1/blocks/abc123 \
  -H "Content-Type: application/json" \
  -d '{"metadata": {"markers": ["ctx"]}, "origin": "hook"}'
```

## What's NOT Done Yet

- **Origin flow to Y.Doc transactions**: The origin parameter is accepted but not yet wired through to the Y.Doc transaction origin field. This requires YDocStore mutation methods (currently, TS handles all mutations via WebSocket sync).

- **Origin parsing/validation**: Currently stored as raw string. Future: parse to Origin enum and validate.

## Setup for Next Unit

Unit 1.1 (BlockChange Types) can now:
- Include origin in change events (once wired through)
- Include metadata in change events
- Distinguish Agent vs User vs Remote sources via API

The API surface is ready. The origin-to-Y.Doc-transaction wiring is deferred until we have Rust-side mutation methods in YDocStore, which may be Unit 0.4 or deferred further.

---

## Gap Note

During implementation, confirmed that origin wiring to Y.Doc transactions requires Rust-side mutation methods that don't exist yet. The current architecture has TypeScript performing all mutations, with Rust receiving sync updates.

This is acceptable for Phase 1 (Change Emitter) because:
- The Change Emitter can read origin from the API request context
- Hooks will filter based on the Change event's origin field
- Full Y.Doc transaction origin tagging is a future enhancement for true headless operation
