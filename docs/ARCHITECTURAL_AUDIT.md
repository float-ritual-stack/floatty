# Floatty Architectural Audit

**Date**: 2026-02-05
**Auditor**: Claude Code
**Scope**: Core system boundaries, CRDT sync, REST-to-WS propagation, persistence, debugging infrastructure

---

## Executive Summary

Floatty is a Tauri v2 terminal emulator with an integrated block-based outliner backed by CRDT (Yjs/Yrs). The architecture follows a **three-layer model**:

1. **SolidJS Frontend** — Reactive UI, local Y.Doc, debounced sync
2. **Tauri Backend** — IPC bridge, subprocess management, ctx:: aggregation
3. **Headless Server** — Y.Doc authority, REST/WebSocket API, persistence

**Key Finding**: The system is well-architected with explicit race condition mitigations (FLO-152, FLO-269), but has a **non-atomic persist→broadcast window** that could cause silent update loss on server crash.

---

## 1. Core System Map

### Layer Boundaries

```
┌─────────────────────────────────────────────────────────────────┐
│  FRONTEND (SolidJS)                                             │
│  src/                                                           │
│  ├── App.tsx              — Bootstrap, HTTP client init         │
│  ├── hooks/                                                     │
│  │   ├── useBlockStore.ts — Y.Doc-backed block CRUD            │
│  │   ├── useSyncedYDoc.ts — Sync orchestration (1012 lines)    │
│  │   ├── useSyncHealth.ts — Drift detection (block count)      │
│  │   └── usePaneStore.ts  — Per-pane zoom/collapse/focus       │
│  ├── lib/                                                       │
│  │   ├── httpClient.ts    — REST bridge to server              │
│  │   └── encoding.ts      — Base64 codec                        │
│  └── components/           — Terminal, Outliner, BlockItem      │
└──────────────┬──────────────────────────────────────────────────┘
               │ invoke() for commands, HTTP for Y.Doc sync
               ▼
┌─────────────────────────────────────────────────────────────────┐
│  TAURI BACKEND (Rust)                                           │
│  src-tauri/src/                                                 │
│  ├── lib.rs               — App setup, logging, server spawn   │
│  ├── server.rs            — Subprocess lifecycle (PID mgmt)    │
│  ├── commands/            — Thin IPC adapters                   │
│  ├── services/            — Business logic (shell, ai, ctx)    │
│  ├── ctx_watcher.rs       — JSONL file watcher                 │
│  └── ctx_parser.rs        — Ollama-powered marker parsing      │
└──────────────┬──────────────────────────────────────────────────┘
               │ Spawns subprocess with env vars
               ▼
┌─────────────────────────────────────────────────────────────────┐
│  HEADLESS SERVER (floatty-server)                               │
│  src-tauri/floatty-server/src/                                  │
│  ├── main.rs              — Axum server, hook wiring           │
│  ├── api.rs               — REST endpoints (95KB)              │
│  ├── ws.rs                — WebSocket broadcaster              │
│  ├── auth.rs              — Bearer token middleware            │
│  └── backup.rs            — Hourly snapshot daemon             │
│                                                                 │
│  floatty-core/src/                                              │
│  ├── store.rs             — Yrs Y.Doc wrapper, CRUD ops        │
│  ├── persistence.rs       — SQLite append-only log             │
│  ├── hooks/               — Metadata extraction, search index  │
│  └── events.rs            — BlockChange event types            │
└─────────────────────────────────────────────────────────────────┘
```

### Communication Protocols

| Path | Protocol | Encoding |
|------|----------|----------|
| Frontend → Tauri | `invoke('cmd', args)` | JSON (Tauri IPC) |
| Frontend → Server | HTTP REST | Base64 Y.Doc updates in JSON |
| Server → Frontend | WebSocket | Base64 updates with txId |
| Tauri → Server | Subprocess env | `FLOATTY_PORT`, `FLOATTY_API_KEY`, `FLOATTY_DATA_DIR` |

---

## 2. CRDT Implementation (Yjs ↔ Yrs Bridge)

### Encoding/Decoding Flow

```
Frontend Y.Doc (Yjs)
    │
    │ Y.encodeStateAsUpdate(doc) → Uint8Array
    │ bytesToBase64(bytes) → string
    ▼
HTTP Request: { "update": "<base64>", "tx_id": "..." }
    │
    │ BASE64.decode(&req.update) → Vec<u8>
    │ Update::decode_v1(&bytes) → yrs::Update
    ▼
Server Y.Doc (Yrs)
    │
    │ txn.apply_update(update) — CRDT merge (idempotent)
    │ txn.encode_update_v1() → Vec<u8>
    │ BASE64.encode(&bytes) → String
    ▼
WebSocket Broadcast: { "txId": "...", "data": "<base64>" }
    │
    │ base64ToBytes(msg.data) → Uint8Array
    │ Y.applyUpdate(doc, bytes, 'remote')
    ▼
Frontend Y.Doc (Yjs) — UI updates reactively
```

### State Vector Exchange

**Purpose**: Efficient reconciliation without full state transfer.

```typescript
// Client computes what server is missing
const serverSV = await httpClient.getStateVector();        // ~100 bytes
const localDiff = Y.diffUpdate(localState, serverSV);      // Only missing ops
await httpClient.applyUpdate(localDiff);                   // Push diff only
```

**Key Endpoints**:
- `GET /api/v1/state-vector` — Server's state vector (what it has)
- `GET /api/v1/state` — Full Y.Doc state (for initial load/recovery)
- `POST /api/v1/update` — Apply delta (CRDT merge)

### Echo Prevention

```typescript
// Frontend generates txId before sending
const txId = `${Date.now()}-${counter++}`;
recentTxIds.add(txId);
await httpClient.applyUpdate(update, txId);

// On WebSocket receive
if (msg.txId && recentTxIds.has(msg.txId)) {
  // This is our own update echoed back — skip
  return;
}
```

---

## 3. Ghost Writer Path (REST → WebSocket Propagation)

### Propagation Mechanism

```
REST Client (e.g., CLI agent, external tool)
    │
    │ POST /api/v1/update { update: "<base64>", tx_id: "..." }
    ▼
api.rs:apply_update()
    │
    ├─ 1. Decode base64 → bytes
    ├─ 2. store.apply_update(bytes)
    │      ├─ Persist to SQLite FIRST
    │      └─ Apply to in-memory Y.Doc
    ├─ 3. broadcaster.broadcast(bytes, tx_id)
    │      └─ tokio::broadcast::channel (256 slots)
    └─ 4. Return HTTP 200
    │
    ▼
WebSocket Handler (ws.rs)
    │
    │ rx.recv().await — Each connected client has subscriber
    │ sender.send(Message::Text(json)) — Forward to client
    ▼
Frontend WebSocket Client
    │
    │ base64ToBytes(msg.data)
    │ Y.applyUpdate(doc, bytes, 'remote')
    ▼
UI updates via SolidJS reactivity
```

### Race Conditions & Mitigations

| Issue | Severity | Code Location | Mitigation |
|-------|----------|---------------|------------|
| **Persist → Broadcast window** | Medium | `api.rs` (apply_update) | Sequence tracking + periodic block count resync |
| **WS client lagging** | Medium | `ws.rs` (handle_socket) | FLO-152: 256-message buffer, warn on lag |
| **Reconnect message ordering** | Medium | `useSyncedYDoc.ts` (connectWebSocket) | FLO-152: Buffer messages during resync |
| **First connect redundant fetch** | Low | `useSyncedYDoc.ts` (onopen handler) | FLO-269: Skip fetch on first connect |
| **Missed gaps during disconnect** | Low | `useSyncedYDoc.ts` (gap detection) | Sequence numbers + incremental reconnect |

### Silent No-Op Risk

**Scenario**: REST client sends update, but WS client already has that state (e.g., from previous sync). The `applyUpdate()` is a CRDT no-op — **no observeDeep fires, no UI change**.

**Detection**: Primary detection via sequence numbers (gaps detected immediately). Fallback: `useSyncHealth.ts` polls block count every 120s. If server block count differs from local for 2 consecutive checks, triggers full resync.

---

## 4. State Persistence

### Storage Architecture

```
{FLOATTY_DATA_DIR}/
├── ctx_markers.db        ← SQLite (WAL mode)
│   └── ydoc_updates      ← Append-only Y.Doc delta log
├── backups/              ← Hourly .ydoc snapshots
│   ├── floatty-2026-02-05-120000.ydoc
│   └── floatty-2026-02-05-110000.ydoc
└── search_index/         ← Tantivy full-text index
```

### Persistence Flow

```
Update received
    │
    ├─ 1. Validate (decode check)
    ├─ 2. PERSIST: INSERT INTO ydoc_updates (BEFORE memory apply)
    ├─ 3. Apply to in-memory Y.Doc
    ├─ 4. Emit BlockChange events to hooks
    └─ 5. Maybe compact (every 100 updates → single snapshot)
```

**Key Design**: Persist-first ensures crash recovery. If DB write fails, memory stays unchanged.

### Startup Reconstruction

```rust
let updates = persistence.get_updates(doc_key)?;  // Read all (oldest first)
for update_bytes in updates {
    let u = Update::decode_v1(&update_bytes)?;
    txn.apply_update(u)?;  // Replay to reconstruct state
}
```

### Backup Daemon

- **Interval**: Hourly (configurable)
- **Retention**: 24 hourly, 7 daily, 4 weekly
- **Format**: Raw Y.Doc state (`.ydoc` binary)
- **Recovery**: `POST /api/v1/restore` (destructive full replacement)

---

## 5. Debugging Artifacts

### Sync Health Check (`useSyncHealth.ts`)

**Why block count, not hash**: Y.Doc encoding includes client IDs and tombstones. Same content → different hashes. Block count is deterministic.

**Note**: With sequence number tracking, most sync issues are detected immediately via gap detection. This poll runs at reduced frequency (120s) as a safety net.

```typescript
// Poll every 120s (safety net — gaps now caught via seq)
const serverHealth = await httpClient.getStateHash();
const localBlockCount = doc.getMap('blocks').size;

if (serverHealth.blockCount !== localBlockCount) {
  consecutiveMismatches++;
  if (consecutiveMismatches >= 2) {
    await triggerFullResync();
  }
}
```

### Key Logging Points

| Location | Log | Purpose |
|----------|-----|---------|
| `useSyncedYDoc.ts` | `[useSyncedYDoc] Attached singleton update handler` | Handler lifecycle |
| `useSyncedYDoc.ts` | `[WS] First connection — accepting messages immediately` | FLO-269 fix |
| `useSyncedYDoc.ts` | `[WS] Gap detected: X → Y` | Sequence gap detection |
| `useSyncHealth.ts` | `[SyncHealth] Block count mismatch detected` | Drift detection |
| `ws.rs` | `Broadcast {} bytes (seq={}) to {} client(s)` | Server-side broadcast |
| `useBlockStore.ts` | `[BlockStore] Root IDs updated` | Y.Doc observer |

### State Validation (`FLO-247`)

```typescript
// validateSyncedState() warns on suspicious conditions:
// - Zero blocks but backup exists (server wipe?)
// - Very few blocks (< 10) — test data?
// - Orphaned blocks (no root IDs)
// - Excessive root IDs (> 20)
```

### Missing Infrastructure

- No explicit "tripwire" logging found
- No cross-request correlation IDs
- Performance metrics not tracked in observeDeep
- Hash comparison removed intentionally (FLO-197/P4)

---

## Risk Summary

### High Priority

1. **Persist→Broadcast Non-Atomicity**
   *Risk*: Server crash between SQLite write and WS broadcast → update persisted but not propagated.
   *Impact*: WS clients miss update until next resync (30s poll).
   *Recommendation*: Accept as tolerable (CRDT recovers on resync) or implement WAL-based broadcast replay.

### Medium Priority

2. **WS Message Loss on Lag**
   *Risk*: Slow client exceeds 256-message buffer → messages dropped.
   *Impact*: Client drifts, recovers on next health check.
   *Recommendation*: Monitor `WebSocket client lagged` warnings in production.

3. **Restore Overwrites Everything**
   *Risk*: `POST /api/v1/restore` is destructive, no confirmation.
   *Impact*: All clients sync to restored state, potential data loss.
   *Recommendation*: Require explicit confirmation header or backup before restore.

### Low Priority

4. **Metadata Extraction Async**
   *Risk*: Hooks run after broadcast → clients see update before metadata extracted.
   *Impact*: Brief UI inconsistency (search index lag).
   *Recommendation*: Acceptable UX tradeoff for responsiveness.

---

## File Reference Quick Links

| Component | Primary File |
|-----------|--------------|
| Sync orchestration | `src/hooks/useSyncedYDoc.ts` |
| Block store | `src/hooks/useBlockStore.ts` |
| HTTP client | `src/lib/httpClient.ts` |
| Health check | `src/hooks/useSyncHealth.ts` |
| Server API | `src-tauri/floatty-server/src/api.rs` |
| WebSocket | `src-tauri/floatty-server/src/ws.rs` |
| Y.Doc store | `src-tauri/floatty-core/src/store.rs` |
| Persistence | `src-tauri/floatty-core/src/persistence.rs` |
| Backup daemon | `src-tauri/floatty-server/src/backup.rs` |

---

*Report generated for senior collaborator technical briefing.*
