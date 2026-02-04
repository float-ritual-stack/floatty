---
paths:
  - "src/**/*.{ts,tsx}"
---

# Output Block Patterns

These patterns apply to blocks that replace contentEditable with display-only output (search results, daily views, future embedded views).

## 1. Output Blocks Are Keyboard Dead Zones By Default

**The problem**: When a block's contentEditable is hidden (via `<Show when={...}>` guard), `contentRef` stays `undefined`. The main focus routing effect guards on `contentRef` — so output blocks silently become unfocusable. Arrow keys skip right past them.

```typescript
// The content Show guard already hides contentEditable for output blocks:
<Show when={!isOutputBlock()}>
  <div ref={contentRef} contentEditable>...</div>
</Show>

// Main focus effect: contentRef is undefined → no-op
createEffect(() => {
  if (isFocused() && contentRef) { // ← false for output blocks
    contentRef.focus();
  }
});
```

**Fix**: Output blocks need a separate focusable wrapper + focus routing effect.

```typescript
let outputFocusRef: HTMLDivElement | undefined;

// Separate effect for output blocks
createEffect(() => {
  if (isFocused() && isOutputBlock() && outputFocusRef) {
    requestAnimationFrame(() => {
      outputFocusRef?.focus({ preventScroll: true });
    });
  }
});

// In JSX:
<Show when={isOutputBlock()}>
  <div ref={outputFocusRef} tabIndex={0} onKeyDown={handleOutputBlockKeyDown}>
    {/* output view components */}
  </div>
</Show>
```

**Why two effects don't conflict**: The main effect guards on `contentRef` (undefined for output blocks). The output effect guards on `isOutputBlock()` (false for regular blocks). Mutual exclusion via guards.

## 2. Embedded Views Must Be Display-Only (Single Focus Point)

**The trap**: Giving an embedded view its own `tabIndex` and `onKeyDown` creates a dual-focus problem. Both parent wrapper and child view handle keyboard events. `preventDefault()` does NOT stop propagation — events bubble from child to parent, both handlers fire.

```typescript
// ❌ BROKEN - dual focus, event bubbling
<div ref={outputFocusRef} tabIndex={0} onKeyDown={parentHandler}>
  <SearchResultsView
    tabIndex={0}           // ← Second focus target!
    onKeyDown={childHandler} // ← Both handlers fire via bubbling
  />
</div>

// Scenario: ArrowUp from first result
// 1. childHandler: sets idx=-1, calls onNavigateOut
// 2. Event bubbles to parentHandler
// 3. parentHandler: sees idx=-1, navigates to prev block
// Result: User flies past the output block entirely
```

```typescript
// ✅ CORRECT - single focus point, display-only child
<div ref={outputFocusRef} tabIndex={0} onKeyDown={handleOutputBlockKeyDown}>
  <SearchResultsView
    focusedIdx={searchFocusedIdx}  // ← Visual state only, no focus
  />
</div>

// ALL keyboard logic in handleOutputBlockKeyDown
// SearchResultsView just renders highlight based on focusedIdx prop
```

**Rule**: Embedded views (search results, tables-in-display-mode, future views) receive visual state via props. They never have `tabIndex`, `onKeyDown`, or `ref` forwarding. The parent block's wrapper owns focus and keyboard routing.

**Exception**: TableView uses `onNavigateOut` callback pattern because it HAS its own contentEditable cells. Tables genuinely need internal focus. Search results don't — they're a list you highlight and select.

## 3. Check `git show HEAD:file` Before Assuming Regression

When a behavior seems wrong (e.g., "contentEditable is hidden for output blocks"), check whether it was already that way before your changes:

```bash
# See the original guard
git show HEAD:src/components/BlockItem.tsx | grep -n "outputType"
```

This prevents wasted cycles "fixing" behavior that was intentional. In the search UX work, the content area was ALREADY hidden for output blocks — `!block()?.outputType?.startsWith('search-')` — the new `!isOutputBlock()` just cleaned up the same guard.
