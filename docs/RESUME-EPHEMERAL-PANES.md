# Floatty: Resume Ephemeral Pane Feature (Post-Revert)

> **Created**: 2026-01-06 @ 09:00 PM
> **Context**: Reverted PRs #63-65, tagged v0.2.4. Issues #67-70 created for backlog.
> **HARD BOUNDARY**: No floatty fiddling for 10+ hours. Rangle work takes priority.

## Root Cause (Confirmed)

The `handleBlur` direction was changed to sync DOM→store instead of store→DOM. Text expanders inject via paste, which triggers blur, which then overwrote the expansion with stale store content.

**Working behavior**: Store is source of truth. On blur, reset DOM to match store (catches any drift).

## Critical: Do Not Touch

These functions in `BlockItem.tsx` are fragile. Text expanders depend on exact current behavior:

```typescript
// handleBlur syncs STORE → DOM (not the reverse!)
const handleBlur = () => {
  if (contentRef.innerText !== currentBlock.content) {
    contentRef.innerText = currentBlock.content;  // ← THIS DIRECTION
  }
};

// handlePaste: else branch falls through to browser default
// Do NOT add e.preventDefault() or manual text insertion
} else {
  // Browser does default plain text paste
}

// handleInput: reads innerText, updates store. No debouncing.
```

## Safe to Re-Add (Incrementally)

### 1. Ephemeral Pane Styling (Issue #67)

Move styling from placeholder layer to overlay layer:

**OutlinerPane.tsx** - Add `ephemeral?: boolean` prop and classList
**Terminal.tsx** - Pass `ephemeral={info().ephemeral}`
**index.css** - Style `.terminal-pane-positioned.pane-ephemeral`

### 2. Pin on Type (Issue #67)

Remove 5-second timer. `handleInput` already calls `pinPane()`:
```typescript
const tabId = findTabIdByPaneId(props.paneId);
if (tabId) layoutStore.pinPane(tabId, props.paneId);
```

### 3. Hydration: Clear Ephemeral Flags (Issue #67)

In `hydrateLayouts()`, walk tree and set `ephemeral: false` on all leaves.

### 4. ResizeOverlay Hardening (Issue #70)

- Add `pointercancel` listener
- Clean up retry timeout on unmount
- Always remove `resizing` class in cleanup

### 5. CSS Containment (Issue #68)

**CAUTION**: May interfere with two-layer overlay. Test carefully:
- `contain: layout style` is probably safe
- `contain: paint` may break display layer updates

## Do NOT Re-Add

- Any changes to `handleBlur` direction
- Any `e.preventDefault()` in paste handler's else branch
- Any debouncing/skipping in `handleInput`

## Test Checklist (Every Commit)

1. [ ] `!ctx` at line start → expands
2. [ ] `!ctx` in multi-line block → expands
3. [ ] Cmd+V plain text → works
4. [ ] Cmd+V rich text → works
5. [ ] Typing in ephemeral pane → pins
6. [ ] App restart with ephemeral → becomes permanent

## Observed Post-Revert (v0.2.4)

**Text still vanishing intermittently** (reported 2026-01-07 @ 03:47 AM):
- Blocks randomly show blank content
- Collapse/expand parent forces re-render → text reappears
- Happening "fairly often" during normal use

**Hypothesis**: Display layer `createMemo` for inline tokens has a stale dependency or missing reactive trigger. The collapse/expand workaround confirms the data exists in store - it's a rendering/reactivity issue.

**Investigation path**:
1. Check `BlockDisplay.tsx` - is `props.content` reactive or captured once?
2. Check if Y.Doc observer properly triggers SolidJS signals
3. Look for `untrack()` or other reactivity-breaking patterns

## Related Issues

- #67 - FLO-136: Ephemeral panes (clean reimplementation)
- #68 - CSS containment performance
- #69 - Window title dev/release indicator
- #70 - UI state hygiene

## Summary

Ephemeral panes are architecturally sound. They got tangled with handleBlur regression. Re-apply incrementally, testing text expanders after each commit. Do not touch input/blur/paste handlers.
