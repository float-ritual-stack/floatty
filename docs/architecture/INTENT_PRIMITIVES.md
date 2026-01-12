# Intent Primitives Architecture

**Created**: 2026-01-11 @ 08:05 AM
**Status**: Design exploration complete, implementation not started

---

## The Question

How do we expose floatty's capabilities to:
1. **Lua scripts** (user customization)
2. **External agents** (HTTP/MCP control)
3. **Frontend handlers** (:: prefixes)

...using a **single API vocabulary** so there's no special cases?

---

## Three Namespaces

| Namespace | Purpose | Primitives |
|-----------|---------|------------|
| `float.data` | Y.Doc/CRDT substrate | `get`, `query`, `mutate` |
| `float.view` | Viewport/attention | `navigate`, `layout`, `selection` |
| `float.sys` | Events/lifecycle | `on`, `dispatch` |

**Key insight**: Intent Primitives - caller says WHAT, core handles HOW.

---

## The Critical Primitive: `float.view.navigate`

The "Goldfish" command that crosses the hardest boundary (State → DOM).

**Intent**: "Show me block X"

**Mechanism** (what the primitive handles):
1. Locate block in Y.Doc
2. Calculate ancestors
3. Uncollapse path
4. Switch page/root if needed (zoom context)
5. scrollIntoView + flash + focus

### Why Frontend-Heavy Works

**Key finding**: Collapse state is **frontend-only** (paneStore), not Y.Doc.

This means the navigate primitive can be mostly frontend:
- No Rust Y.Doc mutation needed for navigation
- Frontend has `getAncestors()` in useBlockOperations
- Just need: `paneStore.setCollapsed(paneId, ancestorId, false)` for each ancestor

### Collapse State Architecture

**Dual-layer storage:**
- **Y.Doc (CRDT)**: `block.collapsed` - persisted default
- **paneStore (SolidJS)**: Per-pane override via `collapsed[paneId][blockId]`

**Lookup priority**: Pane override first, CRDT fallback.

---

## Design Decisions

### Multi-pane behavior

Existing pattern applies:
- **Regular click/navigate** → in current pane
- **Cmd+Click** → open in new split pane

```typescript
navigate(blockId, { split?: 'horizontal' | 'vertical' })
```

No "find-and-switch" - matches existing wikilink click behavior.

### Zoom context

If zoomed into subtree and target is OUTSIDE that zoom:
- **Auto-unzoom** - navigation should always succeed
- Find nearest common ancestor, or unzoom entirely if needed
- Follows principle: intent primitives handle complexity

---

## Implementation Sketch

### useNavigate hook

```typescript
export function useNavigate() {
  const paneStore = usePaneStore();
  const blockOps = useBlockOperations();

  const navigate = async (blockId: string, opts?: {
    highlight?: boolean;
    split?: 'horizontal' | 'vertical';
    paneId?: string;
  }) => {
    const targetPaneId = opts?.paneId ?? activePane();

    // 1. Validate block exists
    const block = blockStore.get(blockId);
    if (!block) return { success: false, error: 'block_not_found' };

    // 2. Handle zoom context (unzoom if target outside current zoom)
    const currentZoom = paneStore.getZoomedRootId(targetPaneId);
    if (currentZoom && !isDescendant(blockId, currentZoom)) {
      paneStore.setZoomedRootId(targetPaneId, null);
    }

    // 3. Uncollapse ancestors
    const ancestors = blockOps.getAncestors(blockId);
    for (const ancestorId of ancestors) {
      paneStore.setCollapsed(targetPaneId, ancestorId, false);
    }

    // 4. Wait for render, then scroll + focus + flash
    await nextFrame();
    const el = document.querySelector(`[data-block-id="${blockId}"]`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el?.querySelector('[contenteditable]')?.focus({ preventScroll: true });

    if (opts?.highlight) {
      el?.classList.add('block-flash');
      setTimeout(() => el?.classList.remove('block-flash'), 1000);
    }

    return { success: true };
  };

  return { navigate };
}
```

### Event Bridge

```typescript
// Desktop: Tauri event
listen('sys:intent:navigate', (event) => {
  navigate(event.payload.targetId, event.payload.options);
});

// Browser: WebSocket message
ws.on('navigate', (payload) => {
  navigate(payload.targetId, payload.options);
});
```

### HTTP Endpoint (floatty-server)

```rust
async fn navigate_handler(
    Json(payload): Json<NavigateRequest>,
    Extension(ws_broadcaster): Extension<WsBroadcaster>,
) -> impl IntoResponse {
    ws_broadcaster.send(WsMessage::Navigate(payload)).await;
    Json(json!({ "success": true }))
}
```

---

## What This Unlocks

Once `curl` can scroll your viewport:

1. **search:: results** - click handler calls `navigate(hit.id)`
2. **Agent control** - Claude says "scroll to that" → same primitive
3. **Lua scripts** - `float.view.navigate(id)` wraps same function
4. **Future handlers** - any :: can navigate without custom code

---

## Files Involved

**SolidJS (new)**:
- `src/hooks/useNavigate.ts` - core primitive

**SolidJS (modify)**:
- `src/components/Outliner.tsx` - expose via context/event
- `src/components/BlockItem.tsx` - flash animation class

**Rust (modify)**:
- `floatty-server/src/routes.rs` - navigate endpoint

**CSS**:
- `src/index.css` - `.block-flash` animation

---

## Verification

```bash
# Prove intent/mechanism separation
curl -X POST http://localhost:8765/api/v1/navigate \
  -H 'Content-Type: application/json' \
  -d '{"targetId": "block_xyz", "highlight": true}'
# → floatty viewport scrolls to that block and flashes it
```

---

## Related Docs

- Existing Lua API notes: `float.dispatch/bridges/floatty-notes/2026-01-08-pattern-harvest/`
- THE_BORING_TRUTH.md: Goldfish/Foreman pattern explanation
