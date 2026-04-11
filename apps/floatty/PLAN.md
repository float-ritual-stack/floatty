# Cross-Pane Drag-and-Drop Fix — Root Cause Analysis

**Status:** Planning Phase  
**Issue:** flo-xxx — Cross-pane DND regression  
**Labels:** bug, regression, dnd, panes

---

## Context

Cross-pane drag-and-drop (DND) is broken. While intra-pane DND works, dragging blocks between split panes fails because drop targets are not recognized once the cursor enters the target pane's space.

### Key Observation: Ghost Highlighting
Dragging a block within Pane A causes highlights to trigger in Pane B (if they share outline segments), but the cursor itself entering Pane B loses drop-zone recognition.

---

## Root Cause Identified

**The `pane-inactive-overlay` is blocking pointer events during drag operations.**

In `OutlinerPane.tsx` (line 165), an overlay is rendered when `!props.isActive`:

```tsx
{!props.isActive && (
  <div
    class="pane-inactive-overlay"
    onMouseDown={() => props.onPaneClick?.()}
  />
)}
```

This overlay:
- Is positioned absolutely with `inset: 0` (covers entire pane)
- Has `z-index: 20` (sits above block content)
- Has NO `pointer-events: none` during drag operations
- Only handles `onMouseDown` (not pointer events)

During DND, when `document.elementFromPoint(x, y)` is called in `useBlockDrag.ts` (line 177), it hits this overlay instead of the blocks underneath. The overlay is NOT inert during DND — it consumes the pointer events.

---

## Additional Suspected Issues

### 1. Pane Link Overlay (`pane-link-scrim`)
- `PaneLinkOverlay.tsx` has `z-index: 2000`
- Even when not visible (no active overlay), need to verify it doesn't create invisible DOM elements

### 2. Dim Overlays
- CSS for unfocused panes (`unfocused_pane_opacity`) doesn't use `pointer-events: none`
- Combined with the inactive overlay, this creates multiple blocking layers

### 3. `elementFromPoint` Shadow DOM/iframe Considerations
- The `IframePaneView` may also need review for DND behavior when zoomed

---

## Files to Modify

| File | Purpose |
|------|---------|
| `src/components/OutlinerPane.tsx` | Fix inactive overlay pointer-events during DND |
| `src/hooks/useBlockDrag.ts` | Verify event handling works with overlay |
| `src/components/PaneLinkOverlay.tsx` | Ensure overlay doesn't block when inactive |
| `src/index.css` | Add `pointer-events: none` during drag or fix overlay styling |

---

## Proposed Fix Strategy

### Option A: CSS-Only (Preferred)
Add CSS rule that disables pointer events on the inactive overlay during drag:

```css
body.block-dragging .pane-inactive-overlay {
  pointer-events: none !important;
}
```

### Option B: Conditional Rendering
Don't render the overlay at all during active drag (requires DND state awareness):

```tsx
{!props.isActive && !isDraggingGlobally && (
  <div class="pane-inactive-overlay" ... />
)}
```

### Option C: Pointer Event Passthrough
Change the overlay to use `pointer-events: none` by default and only enable on specific conditions.

---

## Verification Strategy

1. **Manual Testing:**
   - Split pane horizontally
   - Drag block from Pane A to Pane B
   - Verify drop target highlighting appears in Pane B
   - Verify drop completes successfully
   - Verify pane activation still works (clicking inactive pane)

2. **Existing Test:**
   - `useBlockDrag.test.tsx` has a cross-pane test — verify it passes

3. **Regression Prevention:**
   - Add test that simulates DND across panes with overlay present

---

## Questions for User

1. **Fix Priority:** Option A (CSS-only) is minimal and safe. Any objection to this approach?

2. **Pane Link Overlay:** Should I verify the `PaneLinkOverlay` doesn't also cause issues when it's not active but in the DOM?

3. **Test Coverage:** The existing test mocks `elementFromPoint`. Should I add an integration test that actually tests the DOM overlay interaction?

4. **Iframe Panes:** Do we need to verify DND works when one of the panes is showing an iframe view (zoomed URL block)?

---

## Appendix: Technical Details

### DND Flow
1. `drag.onHandlePointerDown()` → sets `body.block-dragging` class
2. `pointermove` handler → `scheduleResolve()` → `resolveDrop(x, y)`
3. `resolveDrop()` → `document.elementFromPoint(x, y)` → finds blocking overlay
4. `elementFromPoint` returns overlay div → no `[data-block-id]` found → returns null

### Overlay Stack (z-index order)
- `pane-link-scrim`: z-index 2000 (when active)
- `pane-inactive-overlay`: z-index 20 (when pane inactive)
- `outliner-container`: no z-index (normal flow)
- `block-item`: z-index 1-10 (varies by state)
