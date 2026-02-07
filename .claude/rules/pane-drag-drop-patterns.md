# Pane Drag-Drop & Resize Overlay Patterns

These patterns apply to pane rearrangement (drag-drop) and resize handle positioning in floatty.

## Key Files

When reading or modifying ANY of these files, review this rule:

| File | Responsibility |
|------|---------------|
| `src/components/Terminal.tsx` | `computePaneDropZones()`, `finishPaneDrag()`, drop zone rendering |
| `src/lib/layoutTypes.ts` | Pure tree transforms: `moveLeafToTarget()`, `moveLeafToRoot()` |
| `src/hooks/useLayoutStore.ts` | Store methods: `movePane()`, `movePaneToRoot()` |
| `src/components/ResizeOverlay.tsx` | Overlay handle positioning and drag logic |
| `src/components/PaneLayout.tsx` | Layout tree rendering, spacer divs, `data-split-id` attributes |

## 1. Drop Zone Priority: Prepend Ordering

Outer (full-layout-edge) zones are **prepended** to the zones array so `zones.find()` checks them first. Per-pane zones come after.

```typescript
// Outer zones win at the 20px edge strip, per-pane zones take over past that
return [...outerZones, ...perPaneZones];
```

**Why first-match-wins works**: Outer zones are narrow (20px) strips along the layout root edge. Per-pane zones cover the full pane area. At the edge, both overlap — prepend ensures the outer zone wins where it matters.

**Future concern**: If adding top/bottom outer zones, the priority logic needs more thought than "first match wins." Overlapping corners would need explicit priority rules. For left/right only, prepend is correct.

## 2. Synthetic Pane IDs (`__outer_` Prefix)

Outer drop zones use synthetic target IDs (`__outer_left`, `__outer_right`) that don't correspond to real pane IDs. The drag handler routes based on prefix:

```typescript
if (target.targetPaneId.startsWith('__outer_')) {
  const position = target.targetPaneId === '__outer_left' ? 'left' : 'right';
  layoutStore.movePaneToRoot(tabId, sourcePaneId, position);
} else {
  layoutStore.movePane(tabId, sourcePaneId, target.targetPaneId, target.position);
}
```

**Convention**: Any future synthetic zone targets should use `__` prefix to distinguish from real pane UUIDs.

## 3. Zones Computed Once at Drag Start (Stale Geometry)

Drop zones are computed once in `computePaneDropZones()` at drag start, not continuously during drag. This means zone rects are stale if the layout changes mid-drag.

- **Per-pane zones**: Potentially stale if window resizes during drag (unlikely but possible)
- **Outer zones**: Less affected — layout root doesn't move during a pane drag
- **Current approach**: Acceptable tradeoff. Recomputing on every pointermove would be expensive.

## 4. ResizeOverlay: Position vs Size Changes

`ResizeObserver` fires on **size** changes only, NOT position changes. After pane drag-drop rearrangement, a split container can move without resizing — leaving overlay handles at stale coordinates.

**Fix**: Watch the layout tree root reference for structural changes:

```typescript
createEffect(on(
  () => layoutStore.layouts[props.tabId]?.root,
  () => {
    splitContainerCache = null;          // Invalidate cached DOM reference
    requestAnimationFrame(syncPosition); // Re-measure from fresh DOM
  },
  { defer: true }  // Skip initial mount (handled by onMount)
));
```

**Why this works**: SolidJS fine-grained reactivity only triggers when the root reference actually changes (structural mutations create new root objects via `replaceNode`). Ratio-only changes through `setRatio` also create new root objects, but the existing `draggingSplitId` effect already handles positioning during resize drags.

**Cache invalidation**: `splitContainerCache = null` is critical — after drag-drop, the cached `HTMLElement` reference may point to a DOM node that moved or was replaced. Fresh `querySelector` ensures correct measurement.

## 5. Pure Tree Transforms: Clone Pattern

`moveLeafToRoot()` and `moveLeafToTarget()` are pure functions operating on plain objects (not store proxies). The store methods clone first:

```typescript
// Store proxy → plain object → pure transform → store update
const rootClone = JSON.parse(JSON.stringify(layout.root)) as LayoutNode;
const newRoot = moveLeafToRoot(rootClone, sourcePaneId, position);
```

Inside the pure functions, `{ ...sourceNode }` spread is sufficient for `PaneLeaf` because it's a flat object (no nested references). `PaneSplit` with `children` arrays would need deep clone — but the functions construct new splits from scratch, they don't spread existing ones.

## 6. Outer Zones Only When 2+ Panes

Outer zones are only added when `collectPaneIds(layout.root).length >= 2`. With a single pane (source IS root), there's nowhere to move — `moveLeafToRoot` correctly returns null for this case, but skipping zone creation avoids confusing visual feedback.
