# Floatty Headless Architecture Analysis

**Date**: 2026-01-03
**Scope**: Analysis of the new headless architecture (floatty-server + HTTP/WebSocket sync) and its impact on editing experience and synchronization.

---

## Executive Summary

The headless architecture successfully decouples the block store from Tauri IPC, enabling external editors and CLI tools to interact with floatty's outliner. However, several synchronization issues were identified that could cause:

1. **Redundant network traffic** (3x with 3 outliner panes)
2. **Potential data loss** during reconciliation failures
3. **Security vulnerability** in WebSocket endpoint
4. **Resource leaks** in terminal cleanup

---

## Architecture Overview

```
┌────────────────────────────────────────────────────────────────────┐
│                         Frontend (SolidJS)                         │
├────────────────────────────────────────────────────────────────────┤
│  Terminal.tsx                                                       │
│  └─ <Key each={allPaneInfo()}>                                     │
│      ├─ OutlinerPane ──► Outliner ──► useSyncedYDoc()              │
│      ├─ OutlinerPane ──► Outliner ──► useSyncedYDoc()  ← ISSUE #1  │
│      └─ OutlinerPane ──► Outliner ──► useSyncedYDoc()              │
├────────────────────────────────────────────────────────────────────┤
│  useSyncedYDoc.ts (Singleton Y.Doc + HTTP/WS sync)                 │
│  ├─ sharedDoc: Y.Doc (singleton)                                   │
│  ├─ sharedPendingUpdates[] → HTTP POST /api/v1/update              │
│  ├─ sharedWebSocket → ws://server/ws (no auth!) ← ISSUE #3         │
│  └─ localStorage backup → reconciliation ← ISSUE #2                │
└────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────────┐
│                     floatty-server (Rust/Axum)                     │
├────────────────────────────────────────────────────────────────────┤
│  HTTP API (with Bearer auth)     │   WebSocket (NO auth!)          │
│  ├─ GET  /api/v1/health          │   └─ /ws                        │
│  ├─ GET  /api/v1/state           │       └─ Broadcasts updates     │
│  ├─ GET  /api/v1/state-vector    │                                 │
│  └─ POST /api/v1/update          │                                 │
├────────────────────────────────────────────────────────────────────┤
│                        floatty-core                                 │
│  └─ YDocStore (SQLite persistence + Y.Doc state)                   │
└────────────────────────────────────────────────────────────────────┘
```

---

## Issue #1: Multiple Update Handlers (Critical)

### Location
- `src/hooks/useSyncedYDoc.ts:577-583` (inside `onMount`)

### Problem
Each `Outliner` component calls `useSyncedYDoc()`, which attaches its own update handler to the **singleton** `sharedDoc`. With 3 outliner panes open:

```typescript
// Each component mount runs this independently:
onMount(() => {
  const updateHandler = (update: Uint8Array, origin: unknown) => {
    if (origin === 'remote' || isApplyingRemote) return;
    queueUpdate(update);  // Called by ALL mounted handlers!
  };
  doc.on('update', updateHandler);  // doc is the singleton sharedDoc!
  // ...
});
```

### Impact
- **3 panes = 3 handlers = same update queued 3 times**
- 3x network traffic to floatty-server
- Incorrect `pendingCount` display (shows 3 instead of 1)
- Server processes redundant updates (idempotent but wasteful)

### Evidence
```
Terminal.tsx:577-616 - <Key> iterator renders multiple OutlinerPane components
OutlinerPane.tsx:116 - Each renders <Outliner paneId={...} />
Outliner.tsx:17 - Each Outliner calls useSyncedYDoc()
```

### Fix Strategy
Move the update handler to module level with reference counting:

```typescript
let handlerRefCount = 0;
let moduleUpdateHandler: ((update: Uint8Array, origin: unknown) => void) | null = null;

function attachHandler() {
  if (handlerRefCount === 0) {
    moduleUpdateHandler = (update, origin) => {
      if (origin === 'remote') return;
      queueUpdate(update);
    };
    sharedDoc.on('update', moduleUpdateHandler);
  }
  handlerRefCount++;
}

function detachHandler() {
  handlerRefCount--;
  if (handlerRefCount === 0 && moduleUpdateHandler) {
    sharedDoc.off('update', moduleUpdateHandler);
    moduleUpdateHandler = null;
  }
}
```

---

## Issue #2: Backup Cleared on Reconciliation Failure (Critical)

### Location
- `src/hooks/useSyncedYDoc.ts:521-533` (reconciliation catch block)

### Problem
When reconciling a localStorage backup on reconnect, if pushing local changes fails but loading server state succeeds, the backup is cleared. **Local changes that weren't successfully pushed are lost.**

```typescript
} catch (reconcileErr) {
  console.error('[useSyncedYDoc] Reconciliation failed...:', reconcileErr);
  const stateBytes = await httpClient.getState();
  if (stateBytes && stateBytes.length > 0) {
    isApplyingRemote = true;
    Y.applyUpdate(doc, stateBytes, 'remote');
    isApplyingRemote = false;
  }
  // Clear the failing backup to prevent retry loops...
  console.warn('[useSyncedYDoc] Clearing failed backup after server state fallback');
  clearBackup();  // ← LOCAL CHANGES LOST!
}
```

### Failure Sequence
1. User has local changes in backup (offline edits)
2. `httpClient.applyUpdate(localDiff)` fails (server rejects, network timeout)
3. Falls to catch block
4. Loads server state (which lacks local changes)
5. Clears backup → **data loss**

### Fix Strategy
Only clear backup when we confirm local changes were pushed:

```typescript
} catch (reconcileErr) {
  console.error('[useSyncedYDoc] Reconciliation failed:', reconcileErr);
  const stateBytes = await httpClient.getState();
  if (stateBytes && stateBytes.length > 0) {
    isApplyingRemote = true;
    Y.applyUpdate(doc, stateBytes, 'remote');
    isApplyingRemote = false;
  }
  // DON'T clear backup - preserve for next reconciliation attempt
  console.warn('[useSyncedYDoc] Backup preserved - will retry on next startup');
}
```

---

## Issue #3: Unauthenticated WebSocket (Security)

### Location
- `src-tauri/floatty-server/src/main.rs:76-78`
- `src-tauri/floatty-server/src/ws.rs:55-60`
- `src/hooks/useSyncedYDoc.ts:268-272`

### Problem
The HTTP API uses Bearer token authentication, but the WebSocket endpoint accepts **all connections without authentication**.

**Server (main.rs:76-78):**
```rust
// WebSocket route (auth via query param since WS can't use headers easily)
let ws_routes = Router::new()
    .route("/ws", get(ws::ws_handler))
    .with_state(Arc::clone(&broadcaster));
// NOTE: No auth middleware applied!
```

**Server (ws.rs:55-60):**
```rust
pub async fn ws_handler(
    ws: WebSocketUpgrade,
    State(broadcaster): State<Arc<WsBroadcaster>>,
) -> Response {
    // NOTE: No token validation!
    ws.on_upgrade(move |socket| handle_socket(socket, broadcaster))
}
```

**Client (useSyncedYDoc.ts:268-272):**
```typescript
const wsUrl = serverUrl.replace(/^http/, 'ws') + '/ws';
sharedWebSocket = new WebSocket(wsUrl);  // No auth token sent!
```

### Impact
Any local process can connect to `/ws` and receive all Y.Doc updates. While the server binds to localhost by default, this still allows:
- Other local apps to eavesdrop on document changes
- Potential local privilege escalation if sensitive data is in blocks

### Fix Strategy
Add query parameter authentication:

**Frontend:**
```typescript
const wsUrl = `${serverUrl.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(apiKey)}`;
```

**Backend (ws.rs):**
```rust
#[derive(Deserialize)]
pub struct WsQuery { token: Option<String> }

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    Query(query): Query<WsQuery>,
    State(broadcaster): State<Arc<WsBroadcaster>>,
    State(auth): State<ApiKeyAuth>,
) -> Response {
    match query.token {
        Some(ref token) if token == auth.key() => {
            ws.on_upgrade(move |socket| handle_socket(socket, broadcaster))
        }
        _ => StatusCode::UNAUTHORIZED.into_response(),
    }
}
```

---

## Issue #4: xterm.dispose() Failure Leaves Orphaned Map Entries

### Location
- `src/lib/terminalManager.ts:766`

### Problem
If `instance.term.dispose()` throws (rare but possible with corrupted WebGL state), the subsequent map cleanup is skipped:

```typescript
async dispose(id: string) {
  // ... PTY cleanup (has try-catch) ...

  // WebGL addon - wrapped in try-catch ✓
  if (instance.webglAddon) {
    try {
      instance.webglAddon.dispose();
    } catch (e) { /* logged */ }
  }

  instance.term.dispose();  // ← NOT wrapped - if throws, cleanup skipped!
  this.instances.delete(id);      // ← Never runs
  this.callbacks.delete(id);      // ← Never runs
  this.seenMarkers.delete(id);    // ← Never runs
  this.disposing.delete(id);      // ← Never runs
}
```

### Fix Strategy
Wrap term.dispose and ensure map cleanup always runs:

```typescript
try {
  instance.term.dispose();
} catch (e) {
  console.warn(`[TerminalManager] xterm dispose failed for ${id}:`, e);
}

// Always clean up maps
this.instances.delete(id);
this.callbacks.delete(id);
this.seenMarkers.delete(id);
this.savedScrollPositions.delete(id);
this.disposing.delete(id);
```

---

## Issue #5: Sync Timer Continues After All Components Unmount

### Location
- `src/hooks/useSyncedYDoc.ts:586-591` (onCleanup)

### Problem
The cleanup logic deliberately doesn't clear `sharedSyncTimer` or WebSocket:

```typescript
onCleanup(() => {
  doc.off('update', updateHandler);
  // NOTE: Don't clear sharedSyncTimer - other components may still need it
  // NOTE: Don't destroy doc - it's shared across component lifecycles
});
```

When the last Outliner unmounts (all panes become terminals), the timer keeps running, calling `flushUpdates()` on an empty queue.

### Impact
Minor - just wasted CPU cycles per timer tick.

### Fix Strategy
Use reference counting (same as Issue #1 fix):

```typescript
let consumerCount = 0;

// In onMount:
consumerCount++;
if (consumerCount === 1) {
  connectWebSocket();
}

// In onCleanup:
consumerCount--;
if (consumerCount === 0) {
  if (sharedSyncTimer) {
    clearTimeout(sharedSyncTimer);
    sharedSyncTimer = null;
  }
  if (sharedWebSocket) {
    sharedWebSocket.close();
    sharedWebSocket = null;
  }
}
```

---

## Simplification Recommendations

### 1. Create SyncManager Class

Extract sync logic from `useSyncedYDoc.ts` into a dedicated class:

```typescript
// src/lib/syncManager.ts
export class SyncManager {
  private doc: Y.Doc;
  private httpClient: FloattyHttpClient;
  private webSocket: WebSocket | null = null;
  private pendingUpdates: Uint8Array[] = [];
  private consumerCount = 0;

  constructor(doc: Y.Doc, httpClient: FloattyHttpClient) { ... }

  register(): void { this.consumerCount++; ... }
  unregister(): void { this.consumerCount--; ... }
  queueUpdate(update: Uint8Array): void { ... }
  async reconcileBackup(): Promise<void> { ... }
  dispose(): void { ... }
}
```

**Benefits:**
- Single responsibility per class
- Easier to test sync logic in isolation
- Clear lifecycle (init → running → dispose)
- Fixes Issues #1 and #5 naturally

### 2. Consolidate Handler Management

Instead of each component attaching/detaching handlers:

```typescript
// Current: Each Outliner component
onMount(() => {
  doc.on('update', updateHandler);  // Problem: multiple handlers
});
onCleanup(() => {
  doc.off('update', updateHandler);
});

// Proposed: SyncManager handles it
const syncManager = getSyncManager();
onMount(() => syncManager.register());
onCleanup(() => syncManager.unregister());
```

### 3. Add Structured Logging

Replace inconsistent prefixes with structured logging:

```typescript
const log = createLogger('sync', { debug: import.meta.env.DEV });

log.debug('queueUpdate', { size: update.length, pending: pendingCount });
log.info('connected', { wsUrl });
log.error('reconciliation_failed', { error: err.message });
```

---

## Priority Matrix

| Issue | Severity | Effort | Priority |
|-------|----------|--------|----------|
| #1 Multiple handlers | High (3x traffic) | Low | P0 |
| #2 Backup data loss | Critical | Low | P0 |
| #3 WS auth | Medium | Medium | P1 |
| #4 xterm cleanup | Low | Trivial | P2 |
| #5 Timer cleanup | Trivial | Low | P3 |

---

## Testing Recommendations

### Issue #1 Verification
```bash
# Open 3 outliner panes
# Add console.log in queueUpdate to count calls
# Make one edit - should see exactly 1 log, not 3
# Check network tab - should see 1 HTTP POST, not 3
```

### Issue #2 Verification
```bash
# Simulate network failure during applyUpdate
# Verify backup is preserved after failed reconciliation
# Restart app and verify it attempts reconciliation again
```

### Issue #3 Verification
```bash
# Without fix:
websocat ws://localhost:8765/ws  # Should connect (bug)

# With fix:
websocat ws://localhost:8765/ws  # Should reject
websocat 'ws://localhost:8765/ws?token=<valid>'  # Should connect
```

---

## Conclusion

The headless architecture is well-designed for its intended purpose (enabling external editors). The identified issues are localized and can be fixed without major refactoring. The recommended SyncManager abstraction would consolidate the fixes and simplify future maintenance.
