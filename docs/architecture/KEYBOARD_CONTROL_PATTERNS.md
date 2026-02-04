# Keyboard Control Patterns

Floatty has four distinct patterns for how blocks handle keyboard input. Understanding which pattern applies is critical for implementing new block types.

## Pattern Overview

| Pattern | Focus Owner | Editable? | Sub-Navigation? | Example |
|---------|-------------|-----------|-----------------|---------|
| **Regular** | contentEditable | Yes | No | Text, code blocks |
| **Output** | outputFocusRef wrapper | No | Yes (focusedIdx) | search::, daily:: |
| **Picker** | Component ref | Yes | Yes (focusedCell) | Tables, future kanban |
| **Inline Tree** | Parent output block | No | Yes (per-item Set) | Breadcrumb peek |

## Pattern 1: Regular Blocks

Standard blocks use contentEditable for text input. Focus is managed by the main focus routing effect in BlockItem.

```typescript
// Focus routing for regular blocks
createEffect(() => {
  if (isFocused() && contentRef && !isOutputBlock()) {
    requestAnimationFrame(() => contentRef?.focus());
  }
});
```

**Keyboard flow**: Browser handles text input → useBlockInput handles structural keys (Enter, Backspace, Tab, arrows at boundaries).

## Pattern 2: Output Blocks

Output blocks replace contentEditable with display-only views. They need a separate focusable wrapper because `contentRef` is undefined.

```typescript
// Detect output blocks
const isOutputBlock = createMemo(() => {
  const ot = block()?.outputType;
  return ot?.startsWith('daily-') || ot?.startsWith('search-');
});

// Separate focus routing
createEffect(() => {
  if (isFocused() && isOutputBlock() && outputFocusRef) {
    requestAnimationFrame(() => outputFocusRef?.focus({ preventScroll: true }));
  }
});
```

**Key rule**: View components are display-only. They receive `focusedIdx` as a prop, never have `tabIndex` or `onKeyDown`. All keyboard logic lives in `handleOutputBlockKeyDown`.

```tsx
// Single focus point
<div ref={outputFocusRef} tabIndex={0} onKeyDown={handleOutputBlockKeyDown}>
  <SearchResultsView focusedIdx={searchFocusedIdx} />  {/* display-only */}
</div>
```

**Navigation**: Arrow keys navigate within results (updating focusedIdx signal). At boundaries, exit to adjacent blocks.

## Pattern 3: Picker Blocks

Picker blocks have their own editable internal structure (like table cells). They take full keyboard control and use `onNavigateOut` callback to return control to the outliner.

```typescript
// Table takes focus
<div ref={tableRef} tabIndex={0} onKeyDown={handleTableKeyDown}>
  {/* cells with their own contentEditable */}
</div>

// At boundary, hand back to outliner
const handleTableKeyDown = (e: KeyboardEvent) => {
  if (e.key === 'ArrowUp' && atFirstRow()) {
    props.onNavigateOut?.('up');
  }
};
```

**Key difference from Output**: Picker blocks have internal contentEditable elements (cells). Output blocks don't — they're pure display.

## Pattern 4: Inline Tree (Per-Item Expansion)

When items within an output block have their own expandable sub-structure, use per-item state signals.

```typescript
// Each SearchResultItem has its own expansion state
const [peekIndices, setPeekIndices] = createSignal<Set<number>>(new Set());
```

**Key insight**: Focus stays on the parent output block's wrapper. The inline tree is visual-only — clicking nodes triggers navigation, but keyboard nav stays at the result-item level (focusedIdx), not within the tree.

## Adding a New Block Type: Decision Tree

```
Does it replace contentEditable entirely?
├─ No → Pattern 1 (Regular)
└─ Yes → Does it have editable internal elements?
         ├─ Yes → Pattern 3 (Picker) - use onNavigateOut
         └─ No → Pattern 2 (Output) - use focusedIdx
                 └─ Do items have expandable sub-structure?
                    ├─ Yes → Also Pattern 4 (Inline Tree)
                    └─ No → Pure Output block
```

## Focus Refocus After DOM Changes

SolidJS moves DOM nodes but browser drops focus. After any operation that rearranges DOM (move, indent, delete), refocus explicitly:

```typescript
const refocusAfterMove = () => {
  requestAnimationFrame(() => outputFocusRef?.focus({ preventScroll: true }));
};

if (modKey && e.key === 'ArrowUp') {
  e.preventDefault();
  store.moveBlockUp(props.id);
  refocusAfterMove();
}
```

## See Also

- [RICH_OUTPUT_HANDLER_GUIDE.md](RICH_OUTPUT_HANDLER_GUIDE.md) - How to implement new output handlers
- [output-block-patterns.md](../../.claude/rules/output-block-patterns.md) - Detailed rules for output blocks
- [solidjs-patterns.md](../../.claude/rules/solidjs-patterns.md) - SolidJS-specific patterns (signals, effects)
