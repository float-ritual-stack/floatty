# API Improvement Requirements

> Captured during autonomous gardening trial (2026-01-08). Friction points where better API would enable smoother agent operations.

## Current Limitations

### 1. No Bulk Operations

**Pain**: Each block mutation requires separate HTTP call. Creating a briefing with 5 items = 5 requests.

**Want**:
```
POST /api/v1/blocks/batch
{
  "operations": [
    { "op": "create", "content": "...", "parentId": "..." },
    { "op": "create", "content": "...", "parentId": "..." }
  ]
}
```

**Priority**: High (major throughput improvement for agents)

---

### 2. No Search Endpoint

**Pain**: Must fetch all 6,790 blocks and filter client-side to find blocks by content pattern.

**Want**:
```
GET /api/v1/blocks/search?q=ctx::2026-01-07&type=text
```

**Priority**: High (essential for intelligent gardening)

---

### 3. ~~No Atomic Move~~ SHIPPED (PR #135, FLO-283)

`PATCH /api/v1/blocks/:id` now supports reparenting and repositioning in a single call. See [Block Positioning API](#block-positioning-api) below.

---

### 4. No Collapse/State API

**Pain**: Can't programmatically collapse blocks to hide long outputs.

**Want**:
```
PATCH /api/v1/blocks/:id
{ "collapsed": true }
```

**Status**: May already work? Need to test. The GET response includes `collapsed` field.

**Priority**: Low (nice-to-have for gardening)

---

### 5. No Tree Operations

**Pain**: Getting children requires separate call per block, or parsing the full dump.

**Want**:
```
GET /api/v1/blocks/:id/tree?depth=2  # Returns block + 2 levels of descendants
```

**Priority**: Medium (reduces round-trips for exploration)

---

### 6. ~~No Ordering Control on Create~~ SHIPPED (PR #135, FLO-283)

`POST /api/v1/blocks` now accepts `afterId` and `atIndex`. See [Block Positioning API](#block-positioning-api) below.

---

## Current API (Working)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/v1/health` | GET | Health check |
| `/api/v1/state` | GET | Full Y.Doc state |
| `/api/v1/blocks` | GET | All blocks |
| `/api/v1/blocks/:id` | GET | Single block |
| `/api/v1/blocks` | POST | Create block |
| `/api/v1/blocks/:id` | PATCH | Update block |
| `/api/v1/blocks/:id` | DELETE | Delete block |

---

## Block Positioning API (PR #135, FLO-283)

Positional insertion on create and repositioning on update. Both endpoints use the same two fields.

### Fields

| Field | Type | On | Description |
|-------|------|-----|-------------|
| `afterId` | `string` | POST, PATCH | Insert/move after this sibling block UUID |
| `atIndex` | `number` | POST, PATCH | Insert/move to this index in parent's childIds (0 = prepend) |

**Mutually exclusive** — specifying both returns 422.

### Create with Position

```bash
# Append to parent (default — no positional params)
POST /api/v1/blocks
{ "content": "New block", "parentId": "<parent-uuid>" }

# Insert after a specific sibling
POST /api/v1/blocks
{ "content": "After sibling", "parentId": "<parent-uuid>", "afterId": "<sibling-uuid>" }

# Prepend as first child
POST /api/v1/blocks
{ "content": "First child", "parentId": "<parent-uuid>", "atIndex": 0 }

# Insert at specific index (clamped to childIds length)
POST /api/v1/blocks
{ "content": "At position 3", "parentId": "<parent-uuid>", "atIndex": 3 }
```

### Reposition Existing Block

```bash
# Move within same parent (reorder)
PATCH /api/v1/blocks/<block-uuid>
{ "afterId": "<sibling-uuid>" }

# Prepend within same parent
PATCH /api/v1/blocks/<block-uuid>
{ "atIndex": 0 }

# Reparent + position in one call
PATCH /api/v1/blocks/<block-uuid>
{ "parentId": "<new-parent-uuid>", "afterId": "<sibling-uuid>" }

# Move to root
PATCH /api/v1/blocks/<block-uuid>
{ "parentId": null }
```

### parentId Semantics (PATCH only)

The `parentId` field on PATCH has three-state semantics:

| JSON | Meaning |
|------|---------|
| field absent | Don't change parent |
| `"parentId": null` | Move to root |
| `"parentId": "<uuid>"` | Move under that parent |

### Validation

- `afterId` must be a valid block UUID that shares the target parent
- `afterId` cannot reference the block being moved (422)
- `afterId` block in a different parent without `parentId` reparent = 422
- `atIndex` beyond childIds length is clamped (no error)
- Both `afterId` and `atIndex` together = 422

### Example: Sort Children Alphabetically

```python
# Fetch parent, get childIds, fetch titles, sort, reposition
sorted_ids = sorted(children, key=lambda c: c["title"].lower())
for i, block_id in enumerate(sorted_ids):
    if i == 0:
        patch(block_id, {"parentId": parent_id, "atIndex": 0})
    else:
        patch(block_id, {"parentId": parent_id, "afterId": sorted_ids[i-1]})
```

---

## Notes

- Auth can be disabled via `auth_enabled = false` in `~/.floatty/config.toml`
- Server runs on port 8765 by default
- CRDT sync via WebSocket at `/ws`
