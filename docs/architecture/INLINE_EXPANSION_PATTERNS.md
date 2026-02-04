# Inline Expansion Patterns

When items within an output or picker view have their own expandable sub-structure that isn't a separate block.

## The Problem

Search results show a breadcrumb trail. Users want to peek at siblings without navigating away. But the breadcrumb tree isn't a real block — it's inline display within the search result item.

## Solution: Per-Item State Signals

Each item manages its own expansion state. Focus stays on the parent output block.

```typescript
function SearchResultItem(props: { hit: SearchHit; ... }) {
  // Per-item expansion state
  const [expanded, setExpanded] = createSignal(false);
  const [peekIndices, setPeekIndices] = createSignal<Set<number>>(new Set());

  // Memoize expensive computations
  const crumbs = createMemo(() => getBreadcrumbs(props.hit.blockId));
  const ctx = createMemo(() => expanded() ? getSurroundingContext(props.hit.blockId) : null);

  // ...render with expansion state
}
```

## Key Principles

### 1. State Lives in the Item, Not the Parent

The parent (SearchResultsView) doesn't track which items are expanded. Each item manages itself.

```typescript
// ❌ WRONG - parent tracks all expansion state
const [expandedItems, setExpandedItems] = createSignal<Set<string>>(new Set());

// ✅ CORRECT - each item has its own signal
function SearchResultItem() {
  const [expanded, setExpanded] = createSignal(false);
}
```

**Why**: Simpler mental model, better performance (only expanded item recomputes), easier to add new expansion features.

### 2. Clicks Navigate or Toggle, Never Both

Breadcrumb segments navigate. Separator glyphs toggle expansion. Don't overload.

```typescript
// Segment click → navigate
<span class="breadcrumb-segment" onClick={() => navigateToBlock(crumb.blockId)}>
  {crumb.label}
</span>

// Separator click → toggle peek
<span class="breadcrumb-sep" onClick={() => togglePeek(idx)}>
  {isOpen ? '▾' : '▸'}
</span>
```

### 3. Pure Recursive Builders for Complex Trees

When expansion creates nested structure, use pure recursive functions:

```typescript
function buildBreadcrumbRows(
  crumbs: Crumb[],
  openPeeks: Set<number>,
  fromIdx: number,
  depth: number,
): BreadcrumbRow[] {
  if (fromIdx >= crumbs.length) return [];

  // Find next open peek
  const nextPeek = findNextOpenPeek(openPeeks, fromIdx);

  if (nextPeek === -1) {
    // No more peeks - emit remaining as trail
    return [{ type: 'trail', crumbs: crumbs.slice(fromIdx), depth }];
  }

  const rows: BreadcrumbRow[] = [];

  // Trail up to peek point
  rows.push({ type: 'trail', crumbs: crumbs.slice(fromIdx, nextPeek), depth });

  // Children at peek point
  const children = getAncestorChildren(crumbs[nextPeek - 1].blockId);
  for (const child of children) {
    if (child.isOnPath) {
      rows.push(...buildBreadcrumbRows(crumbs, openPeeks, nextPeek, depth + 1));
    } else {
      rows.push({ type: 'child', id: child.id, content: child.content, depth: depth + 1 });
    }
  }

  return rows;
}
```

**Benefits**:
- Testable (pure function)
- Supports multiple concurrent open peeks
- Depth accumulates naturally via recursion

### 4. Memoize Expensive Computations

Walking the block tree is expensive. Memoize based on the inputs that actually change:

```typescript
// Only recomputes when blockId changes
const crumbs = createMemo(() => getBreadcrumbs(props.hit.blockId));

// Only computes when expanded AND not already cached
const ctx = createMemo(() => expanded() ? getSurroundingContext(props.hit.blockId) : null);

// Recomputes when crumbs OR peekIndices change
const rows = createMemo(() => buildBreadcrumbRows(crumbs(), peekIndices(), 0, 0));
```

### 5. Keyboard Nav Stays at Item Level

Even with inline tree expansion, keyboard navigation (focusedIdx) operates at the search result level, not within the tree.

```
focusedIdx=0  →  [Result 1 with expanded breadcrumb tree]
                    project ▸ work ▾
                      ├ logs
                      ├ notes  ← clicking navigates, but arrow keys don't reach here
                      └ scratch
                 "the actual hit content..."

focusedIdx=1  →  [Result 2]
```

**Why**: Keyboard nav within a tree inside an item would require a second layer of focus state. Keep it simple — clicks handle tree interaction.

## Row Type Pattern

When inline expansion creates multiple visual rows, define explicit types:

```typescript
type BreadcrumbRow =
  | { type: 'trail'; depth: number; crumbs: Crumb[] }
  | { type: 'child'; depth: number; id: string; content: string };
```

Then render with type discrimination:

```tsx
<For each={breadcrumbRows()}>
  {(row) => {
    if (row.type === 'trail') {
      return <TrailRow crumbs={row.crumbs} depth={row.depth} />;
    }
    return <ChildRow id={row.id} content={row.content} depth={row.depth} />;
  }}
</For>
```

## Visual Depth via CSS

Use depth to drive indentation:

```tsx
<div style={{ 'padding-left': `${row.depth * 12}px` }}>
```

## See Also

- [KEYBOARD_CONTROL_PATTERNS.md](KEYBOARD_CONTROL_PATTERNS.md) - How inline trees fit the keyboard model
- [RICH_OUTPUT_HANDLER_GUIDE.md](RICH_OUTPUT_HANDLER_GUIDE.md) - Output blocks that might need inline expansion
