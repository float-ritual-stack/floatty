# Serde API Patterns (Rust ↔ TypeScript)

Prevent snake_case/camelCase confusion in floatty's Rust ↔ TypeScript API boundary.

## The Contract

| Side | Casing | Example |
|------|--------|---------|
| TypeScript types | camelCase | `parentId`, `blockContent` |
| Rust structs | snake_case internally, **camelCase on wire** | `#[serde(rename_all = "camelCase")]` |
| JSON payloads | camelCase | `{ "parentId": "abc", "blockContent": "..." }` |

## Required Serde Attributes

### All API Structs

```rust
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]  // Wire format
pub struct MyRequest {
    parent_id: String,  // Becomes "parentId" in JSON
}
```

### Mutation Request Structs (CRITICAL)

```rust
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]  // ← REQUIRED
pub struct CreateBlockRequest {
    parent_id: String,
    content: String,
}
```

**Why `deny_unknown_fields`**: Without it, serde silently drops unknown fields. Sending `{ "parent_id": "abc" }` (snake_case) would be accepted but `parent_id` would be `None`/default—no error, just silent data loss.

## Error You'll See

With `deny_unknown_fields`, sending wrong casing:

```json
{ "parent_id": "abc" }  // Wrong: snake_case
```

Returns:

```
400 Bad Request: unknown field `parent_id`, expected `parentId`
```

This is the desired behavior—fail fast, not silent corruption.

## TypeScript Side

Always use camelCase in TypeScript:

```typescript
// ✅ Correct
const request = { parentId: blockId, content: text };

// ❌ Wrong - will be rejected with deny_unknown_fields
const request = { parent_id: blockId, content: text };
```

## When to Use `deny_unknown_fields`

| Request Type | Use `deny_unknown_fields`? |
|--------------|---------------------------|
| Mutations (POST/PUT/PATCH) | **YES** - data integrity |
| Query params (GET) | Optional - stricter is better |
| Response structs | No - responses are outbound |

## Field Naming: `id` vs `blockId`

| Context | Rust field | Wire field | Why |
|---------|-----------|-----------|-----|
| Block CRUD response | `id` | `id` | Primary key of the resource you requested |
| Search hit, backlink ref | `block_id` | `blockId` | Foreign key referencing a block |

**Grepability**: `blockId` is precise in jq/grep. `id` matches everything. Agents parsing search results benefit from the distinct name.

**SQL analogy**: `blocks.id` vs `search_hits.block_id`. The search hit is a different entity that contains a reference to a block.

**Rule**: When a struct IS the block, use `id`. When a struct REFERENCES a block from another context, use `block_id`/`blockId`.

## See Also

- `src-tauri/floatty-server/src/api.rs` - API request structs
- PR #119 - Discovery of this pattern during e2e testing
