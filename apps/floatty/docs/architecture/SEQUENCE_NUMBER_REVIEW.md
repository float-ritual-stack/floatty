# Sequence Number Review Findings

**Date**: 2026-02-05
**Reviewer**: Claude Code
**Purpose**: Phase 1 review before implementing sequence numbers for sync layer

---

## SQLite Schema (current)

**File**: `src-tauri/floatty-core/src/persistence.rs`

### Table Structure

```sql
CREATE TABLE IF NOT EXISTS ydoc_updates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,  -- This IS the sequence number
    doc_key TEXT NOT NULL,
    update_data BLOB NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ydoc_doc_key ON ydoc_updates(doc_key, id);
```

### Key Observations

| Aspect | Current State | Implication |
|--------|---------------|-------------|
| **Sequence column** | `id INTEGER PRIMARY KEY AUTOINCREMENT` | Already exists! |
| **Returned on insert** | `append_update()` returns `()` | Need to return `last_insert_rowid()` |
| **Query by seq** | Not implemented | Need `get_updates_since(seq)` |
| **Multi-doc support** | `doc_key` column partitions updates | Seq is global across all docs |

### Compaction Behavior

**Critical finding**: Compaction **DESTROYS** sequence continuity.

```rust
// persistence.rs:197-218
pub fn compact(&self, doc_key: &str, snapshot: &[u8]) -> Result<(), PersistenceError> {
    let tx = conn.unchecked_transaction()?;

    // DELETE ALL existing updates for this doc
    tx.execute("DELETE FROM ydoc_updates WHERE doc_key = ?", [doc_key])?;

    // Insert snapshot as NEW row (gets fresh autoincrement ID)
    tx.execute(
        "INSERT INTO ydoc_updates (doc_key, update_data, created_at) VALUES (?, ?, ?)",
        params![doc_key, snapshot, now],
    )?;

    tx.commit()?;
}
```

**Example**:
- Before compaction: rows 1-150 exist
- After compaction: rows 1-150 deleted, row 151 created (single snapshot)
- Client asks for `since=50`: rows 50-150 don't exist!

**Decision needed**: How to handle compaction boundary?

---

## Broadcast Path (current)

**Files**: `src-tauri/floatty-server/src/api.rs`, `src-tauri/floatty-server/src/ws.rs`

### WS Message Shape

```rust
// ws.rs:19-28
#[derive(Clone, Serialize)]
pub struct BroadcastMessage {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tx_id: Option<String>,  // Echo prevention
    pub data: String,           // Base64-encoded Y.Doc update
    // NO SEQUENCE NUMBER
}
```

### Broadcast Mechanism

```rust
// ws.rs:37-65
pub struct WsBroadcaster {
    tx: broadcast::Sender<BroadcastMessage>,  // tokio::broadcast, capacity 256
}

impl WsBroadcaster {
    pub fn broadcast(&self, update: Vec<u8>, tx_id: Option<String>) {
        let msg = BroadcastMessage {
            tx_id,
            data: BASE64.encode(&update),
        };
        self.tx.send(msg);  // Fire and forget
    }
}
```

### Apply → Persist → Broadcast Flow

```rust
// api.rs:396-411
async fn apply_update(State(state): State<AppState>, Json(req): Json<UpdateRequest>) {
    let update_bytes = BASE64.decode(&req.update)?;

    // 1. store.apply_update() persists FIRST, then applies to memory
    state.store.apply_update(&update_bytes)?;

    // 2. Broadcast to WS clients (AFTER persist succeeds)
    state.broadcaster.broadcast(update_bytes, req.tx_id);

    Ok(StatusCode::OK)
}
```

**Key insight**: `apply_update()` returns `()`, not the assigned sequence number. We need to:
1. Make `persistence.append_update()` return `i64` (the rowid)
2. Pass that through `store.apply_update()`
3. Include in broadcast message

### Lag Handling

```rust
// ws.rs:100-104
Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
    tracing::warn!("WebSocket client lagged {} messages, catching up", n);
    continue;  // Messages are LOST, not replayed
}
```

**With sequence numbers**: Client could detect gap (seq 50 → seq 53) and fetch missing via REST.

---

## Client Sync (current)

**Files**: `src/hooks/useSyncedYDoc.ts`, `src/hooks/useSyncHealth.ts`

### Reconnect Flow

```typescript
// useSyncedYDoc.ts:564-627
sharedWebSocket.onopen = () => {
  const isReconnect = wsHasConnectedOnce;
  wsHasConnectedOnce = true;

  if (isReconnect) {
    // RECONNECT: buffer messages, full state fetch, replay buffer
    wsReadyForMessages = false;
    wsMessageBuffer = [];

    // 1. Flush local pending
    await forceFlushOnReconnect();

    // 2. Fetch FULL STATE (not delta!)
    const serverState = await httpClient.getState();
    Y.applyUpdate(sharedDoc, serverState, 'reconnect-authority');

    // 3. Replay buffered WS messages
    wsReadyForMessages = true;
    for (const msg of wsMessageBuffer) {
      applyWsMessage(msg);
    }
  } else {
    // FIRST CONNECT: accept messages immediately (FLO-269)
    wsReadyForMessages = true;
  }
};
```

### Health Check Mechanism

```typescript
// useSyncHealth.ts:23-28
const POLL_INTERVAL = 30_000;      // 30 seconds
const MISMATCH_THRESHOLD = 2;      // 2 consecutive mismatches → resync

// Block count comparison (NOT hash - FLO-197/P4)
if (serverHealth.blockCount !== localBlockCount) {
  consecutiveMismatches++;
  if (consecutiveMismatches >= MISMATCH_THRESHOLD) {
    await triggerFullResync();  // Full state fetch
  }
}
```

### What Would Change for `lastSeenSeq`

```typescript
// Current WS message handling
function applyWsMessage(msg: { txId?: string; data: string }) {
  // Echo prevention
  if (msg.txId && recentTxIds.has(msg.txId)) return;

  const update = base64ToBytes(msg.data);
  Y.applyUpdate(sharedDoc, update, 'remote');
}

// With sequence numbers
let lastSeenSeq: number | null = null;

function applyWsMessage(msg: { seq: number; txId?: string; data: string }) {
  // Echo prevention
  if (msg.txId && recentTxIds.has(msg.txId)) return;

  // Gap detection
  if (lastSeenSeq !== null && msg.seq !== lastSeenSeq + 1) {
    console.warn(`[WS] Gap detected: ${lastSeenSeq} → ${msg.seq}`);
    // Fetch missing: GET /api/v1/updates?since={lastSeenSeq}
    await fetchMissingUpdates(lastSeenSeq, msg.seq);
  }

  lastSeenSeq = msg.seq;
  const update = base64ToBytes(msg.data);
  Y.applyUpdate(sharedDoc, update, 'remote');
}
```

---

## Existing REST Endpoints (relevant to sync)

**File**: `src-tauri/floatty-server/src/api.rs`

| Endpoint | Method | Returns | Notes |
|----------|--------|---------|-------|
| `/api/v1/state` | GET | Full Y.Doc (base64) | For initial load/full resync |
| `/api/v1/state-vector` | GET | State vector (base64) | For CRDT reconciliation |
| `/api/v1/state/hash` | GET | `{hash, blockCount, timestamp}` | For health check |
| `/api/v1/update` | POST | `200 OK` | Apply update |
| `/api/v1/restore` | POST | `{blockCount, rootCount}` | Destructive full replace |

**Missing**: No "get updates since X" endpoint.

---

## Compaction Details

**File**: `src-tauri/floatty-core/src/store.rs`

### Thresholds

```rust
const COMPACT_THRESHOLD: i64 = 100;       // Compact when > 100 updates
const COMPACT_CHECK_INTERVAL: i64 = 10;   // Only check every 10 updates
```

### Compaction Flow

1. Every 10 updates, check count
2. If count > 100:
   - Encode full Y.Doc state as single update
   - DELETE all rows for doc_key
   - INSERT single snapshot row (gets new autoincrement ID)

### No Compaction Marker

Currently no tracking of "compacted through seq N". After compaction:
- Old sequence numbers are gone
- New snapshot has arbitrary high sequence number
- No way to tell client "you're too far behind"

---

## Gaps / Decisions Needed

### Decision 1: Rowid vs Separate Seq Column

**Option A**: Use existing `id` (rowid) as sequence
- Pro: Already exists, no schema change
- Con: Global across all doc_keys, gaps after DELETE

**Option B**: Add explicit `seq` column per doc_key
- Pro: Clean per-document sequences
- Con: Schema migration, more complexity

**Recommendation**: Use rowid. It's already auto-increment, ordered, and queryable. The "global across docs" isn't a problem since we only have one doc_key in practice.

### Decision 2: Compaction Boundary Behavior

When client asks for `GET /api/v1/updates?since=50` but compaction squashed 1-100 into row 101:

**Option A**: Return 410 Gone with `{"compacted_through": 100}`
- Client falls back to full state fetch
- Simple, correct

**Option B**: Return the compacted snapshot as "update 101"
- Client applies it (idempotent)
- Doesn't require separate error handling

**Recommendation**: Option A. Clear contract: if you're behind compaction, do full sync.

### Decision 3: Tracking `compacted_through_seq`

Need to persist the highest sequence number that was compacted.

```sql
-- Add to schema_meta table
INSERT INTO schema_meta (key, value) VALUES ('compacted_through_seq', '100');
```

**Or** query for the minimum seq after compaction completes (the snapshot row).

### Decision 4: `append_update` Return Value

Currently returns `()`. Need to return the assigned sequence number.

```rust
pub fn append_update(&self, doc_key: &str, update: &[u8]) -> Result<i64, PersistenceError> {
    // ... INSERT ...
    Ok(conn.last_insert_rowid())
}
```

This ripples through:
- `YDocStore::apply_update()`
- `api.rs::apply_update()`
- `WsBroadcaster::broadcast()`

### Decision 5: Client Persistence of `lastSeenSeq`

**Option A**: Memory only (reset on page refresh)
- Simple
- First page load always does full state fetch anyway

**Option B**: Persist to IndexedDB
- Survives page refresh
- Enables faster reconnect (delta only)

**Recommendation**: Start with memory only. Full state on initial load is fine. Sequence benefits are for WS gap detection during session.

---

## Implementation Order (Proposed)

1. **Schema**: Make `append_update()` return `i64`
2. **Compaction marker**: Track `compacted_through_seq` in `schema_meta`
3. **Query**: Add `get_updates_since(doc_key, seq)` to persistence layer
4. **REST endpoint**: `GET /api/v1/updates?since=N`
5. **WS message**: Add `seq` field to `BroadcastMessage`
6. **Client**: Track `lastSeenSeq`, detect gaps, fetch missing
7. **Health check**: Consider adjusting interval (60s?) since gaps are caught faster

---

## Files to Modify

| File | Changes |
|------|---------|
| `floatty-core/src/persistence.rs` | Return seq from `append_update()`, add `get_updates_since()`, track compaction marker |
| `floatty-core/src/store.rs` | Pass seq through `apply_update()` return |
| `floatty-server/src/api.rs` | New `GET /updates` endpoint, include seq in response |
| `floatty-server/src/ws.rs` | Add `seq` field to `BroadcastMessage` |
| `src/hooks/useSyncedYDoc.ts` | Track `lastSeenSeq`, gap detection logic |
| `src/hooks/useSyncHealth.ts` | Adjust interval (optional) |
| `src/lib/httpClient.ts` | Add `getUpdatesSince(seq)` method |

---

## Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| Compaction breaks old clients | Low | Old clients ignore unknown fields, fall back to full sync |
| Sequence gaps from compaction | Medium | 410 response with `compacted_through` |
| Race between persist and broadcast | Medium | Sequence comes FROM persist (which happens first) |
| Large gaps overwhelming client | Low | Limit response size, fall back to full sync if gap > 100 |

---

*Ready for Phase 2 implementation after decisions are confirmed.*
