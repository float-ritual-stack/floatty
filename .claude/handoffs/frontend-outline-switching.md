# Handoff: Frontend Outline Switching (PR #5)

## Resume Point

Backend multi-outline complete (PRs #212-#216 merged). Branch `feat/multi-outline-frontend` created from main. No code changes yet.

## Architecture Summary

### What needs to change

The frontend is single-outline. Everything is singletons:
- `httpClient.ts`: `HttpClient` class uses `this.url + '/api/v1/...'` — no outline prefix
- `useSyncedYDoc.ts`: singleton Y.Doc (`sharedDoc`), singleton WS, module-level state
- `WorkspaceContext.tsx`: provides singleton block store
- WS URL: `serverUrl.replace(/^http/, 'ws') + '/ws'` (line 1132 of useSyncedYDoc.ts)

### Approach: Single-doc switching

App connects to one outline at a time. Switching = disconnect, clear, reconnect.

### Step-by-step

**Step 1: Add outline-aware URL routing to HttpClient**

`src/lib/httpClient.ts` — `HttpClient` class needs `outlineName` field:
- Default outline: URLs stay as `/api/v1/blocks`, `/api/v1/state`, etc.
- Non-default: URLs become `/api/v1/outlines/{name}/blocks`, `/api/v1/outlines/{name}/state`, etc.
- Add `setOutline(name: string)` method that updates the URL prefix
- Export `currentOutline` signal for reactivity

Affected methods: `getState()`, `getStateVector()`, `applyUpdate()`, `getStateHash()`, `exportJSON()`, `getUpdatesSince()`
- `isHealthy()` stays at `/api/v1/health` (no per-outline health endpoint)

**Step 2: Outline-aware WebSocket**

`src/hooks/useSyncedYDoc.ts` line 1132:
```typescript
// Current:
const wsUrl = serverUrl.replace(/^http/, 'ws') + '/ws';
// Change to:
const outline = getCurrentOutline();
const wsUrl = serverUrl.replace(/^http/, 'ws') + '/ws' + (outline !== 'default' ? `?outline=${outline}` : '');
```

**Step 3: switchOutline() function**

In `useSyncedYDoc.ts`, export `switchOutline(name: string)`:
1. Close WS (`sharedWebSocket?.close()`)
2. Clear Y.Doc observers, destroy doc, create fresh
3. Reset: `seqTracker`, `pendingUpdates`, `syncStatus`, `wsRetryCount`
4. Update httpClient outline prefix
5. Call `triggerFullResync()` — fetches new outline's state
6. Reconnect WS with new `?outline=` param
7. Reset pane state (zoom, focus, collapse, history)

**Step 4: Command bar integration**

`src/hooks/useCommandBar.ts`: Add command `{ type: 'command', id: 'switch-outline', label: 'Switch Outline' }`

`src/components/CommandBar.tsx`: Handle 'switch-outline':
- Fetch `GET /api/v1/outlines` for list
- Show outline names as selectable items
- On select: call `switchOutline(name)`

**Step 5: Persist current outline**

In workspace persistence, save `outlineName`. On restart, restore.

## Key Files

| File | Lines | What to change |
|------|-------|---------------|
| `src/lib/httpClient.ts` | 101-253 | Add outline prefix to all API URLs |
| `src/hooks/useSyncedYDoc.ts` | 1125-1136 | WS URL with outline param |
| `src/hooks/useSyncedYDoc.ts` | module level | `switchOutline()` function |
| `src/hooks/useCommandBar.ts` | 41-55 | Add switch command |
| `src/components/CommandBar.tsx` | handler | Outline picker UI |
| `src/hooks/usePaneStore.ts` | - | Reset on switch |
| `src/context/WorkspaceContext.tsx` | - | Expose currentOutline |

## Backend Endpoints (already working)

| Default URL | Per-outline URL |
|-------------|----------------|
| `/api/v1/blocks` | `/api/v1/outlines/:name/blocks` |
| `/api/v1/blocks/:id` | `/api/v1/outlines/:name/blocks/:id` |
| `/api/v1/state` | `/api/v1/outlines/:name/state` |
| `/api/v1/state-vector` | `/api/v1/outlines/:name/state-vector` |
| `/api/v1/update` | `/api/v1/outlines/:name/update` |
| `/api/v1/state/hash` | `/api/v1/outlines/:name/state/hash` |
| `/api/v1/search` | `/api/v1/outlines/:name/search` |
| `/ws` | `/ws?outline={name}` |

## Current Bug: setState/reconcile not resetting store

### What's happening
- `switchOutline()` runs, Y.Doc loads correct data (verified: 6 blocks for switch-test)
- `blockStore.resetForOutlineSwitch()` calls `setState(reconcile({...}))`
- Logs show state AFTER reconcile is unchanged: `isInit: true, blocks: 293`
- UI shows old outline blocks

### What we've ruled out
- NOT a data issue — Y.Doc has correct blocks after switch
- NOT a handler context issue — switched to CustomEvent dispatch in App.tsx
- NOT a module identity issue — debug marker proves same store reference

### What we haven't ruled out
- **HMR interaction**: `import.meta.hot.data` preserves old store across reloads (line 2120 of useBlockStore.ts). May be creating stale closure chains.
- **Production behavior**: Haven't tested with `npm run tauri build`. Bug might be dev-only.
- **createRoot scope**: Store created via `createRoot(createBlockStore)`. Might need to destroy and recreate the root.

### Next steps (for fresh session)
1. **Test production build first** — if it works, it's HMR-only and we just need HMR cleanup
2. **If still broken**: nuclear option — destroy createRoot, recreate store, swap exported reference
3. **Sequence issue**: `triggerFullResync` log says `Bidirectional resync complete` but `initFromYDoc` may not be running because Outliner components re-mount and call `useSyncedYDoc` which re-inits from the doc — race between reset and re-init

## NOT in scope

- Multi-pane-multi-outline (each pane viewing different outline) — future
- Creating outlines from frontend — use API directly for now
- Outline deletion from frontend — use API directly
