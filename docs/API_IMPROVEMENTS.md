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

### 3. No Atomic Move

**Pain**: Moving a block requires delete + create, which loses block history/ID.

**Want**:
```
PATCH /api/v1/blocks/:id/move
{ "newParentId": "...", "afterId": "..." }
```

**Priority**: Medium (preserves identity, cleaner operations)

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

### 6. No Ordering Control on Create

**Pain**: New blocks append to end of childIds. Can't insert at specific position.

**Want**:
```
POST /api/v1/blocks
{ "content": "...", "parentId": "...", "afterId": "..." }
```

**Priority**: Medium (important for organized insertion)

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

## Notes

- Auth can be disabled via `auth_enabled = false` in `~/.floatty/config.toml`
- Server runs on port 8765 by default
- CRDT sync via WebSocket at `/ws`
