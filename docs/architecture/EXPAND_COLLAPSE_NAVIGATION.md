# Expand/Collapse + Navigation Architecture

**Created**: 2026-03-19
**Track**: `.float/work/collapse-nav/`

Read this before touching expand/collapse or navigation routing.

## One Policy, Not Five

All expansion triggers route through `computeExpansion()` in `src/lib/expansionPolicy.ts`.

```
User action → computeExpansion({ trigger, targetId, blockStore }) → ExpansionAction[]
Caller applies → paneStore.setCollapsed(paneId, action.blockId, action.collapsed)
```

`computeExpansion` is a pure function. It returns actions; the caller applies them. This keeps it testable and side-effect-free.

### Trigger Rules

| Trigger | Behavior |
|---------|----------|
| **toggle** (triangle click) | Expand target. If >=10 children with descendants → auto-collapse children |
| **zoom** (Cmd+Enter, wikilink) | Expand target + depth 2. If subtree > 500 nodes → depth 1 only, collapse children with descendants |
| **navigate** (search, backlink) | Expand ancestor chain (capped at 10 levels) |
| **keybind** (Cmd+E N) | Bidirectional expand/collapse to depth N. If > 500 nodes → cap at depth 1 |
| **startup/split** | `applyCollapseDepth` in Outliner.tsx — unchanged |

### Constants

| Name | Value | Location |
|------|-------|----------|
| `SMART_EXPAND_THRESHOLD` | 10 | `expansionPolicy.ts` |
| `EXPANSION_SIZE_CAP` | 500 | `expansionPolicy.ts` |
| `child_render_limit` | 0 (no limit) | `config.toml` → `BlockItem.tsx` (0 = render all children) |

### countDescendantsToDepth Bail Semantics

```typescript
countDescendantsToDepth(blockId, maxDepth, blockStore, bailAt?) → number | 'over_cap'
```

Over cap = fall back to depth 1. No ambiguity.

## One Funnel, Not Three

All navigation routes through `src/lib/navigation.ts`.

```
User action → lib/navigation.ts → resolveLink (pane linking) → navigateToPageImpl → zoomTo → scroll+highlight
```

### Pane Link Resolution

Pane link resolution (`paneLinkStore.resolveLink()`) happens at each **caller's call site**, NOT inside the funnel. Each navigation path resolves before entering `navigateToBlock`/`navigateToPage`:

```typescript
// Caller resolves, then passes resolved paneId to funnel
const targetPane = resolveSameTabLink(props.paneId);
navigateToPage(pageName, { paneId: targetPane, highlight: true });
```

This prevents double-resolution (callers that already resolved) and stale-pane navigation (FM #7 from cowboy session). Split navigation skips resolution since it creates a new pane.

### Navigation Path Inventory

All correct (route through `lib/navigation.ts`):
- Wikilink click (BlockItem.tsx)
- Blockref click (BlockItem.tsx)
- search:: result click (SearchResultsView.tsx)
- filter:: result click (FilterBlockDisplay.tsx)
- pick:: selection (pick.ts)
- chirp:: navigate (navigation.ts → handleChirpNavigate)
- Terminal wikilink (terminalManager.ts)
- Sidebar door chirp (SidebarDoorContainer.tsx)
- Deep link (App.tsx)
- LinkedReferences click
- Cmd+Enter on wikilink
- ⌘K Today command

## Key Files

| File | Role |
|------|------|
| `src/lib/expansionPolicy.ts` | Unified expansion logic (pure function) |
| `src/lib/navigation.ts` | Navigation funnel (pane linking, zoom, scroll) |
| `src/hooks/usePaneStore.ts` | Collapse state storage, `toggleCollapsed` delegates to policy |
| `src/hooks/useTreeCollapse.ts` | `expandToDepth` (with size cap), `expandAncestors` (capped at 10 levels) |
| `src/hooks/useLayoutStore.ts` | Layout tree management, `findTabIdByPaneId` |
| `src/components/Outliner.tsx` | Zoom auto-expand effect (uses policy), startup collapse |
| `src/components/BlockItem.tsx` | Triangle click, config-driven child render limit |
| `src/hooks/useBacklinkNavigation.ts` | Page finding, backlinks. `navigateToPage` internal to funnel |

## View State Only

The expansion policy manages per-pane collapse state (`usePaneStore`). It NEVER modifies Y.Doc `block.collapsed`. That's persisted CRDT state — the expansion policy is view-layer only.

## Anti-Patterns

1. **Don't create a new expand system** — route through `expansionPolicy.ts`
2. **Don't bypass `lib/navigation.ts`** — all navigation goes through the funnel
3. **Don't add debouncing to expansion** — the fix is "expand less" (policy caps), not "expand slower"
4. **Don't modify Y.Doc `block.collapsed`** from expansion policy
5. **Always use `on()` wrapper** when calling expansion functions from SolidJS effects (dependency leak prevention)
