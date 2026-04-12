# Feature: Pinned Panes & Preview Navigation (FLO-137)

> **STATUS: ASPIRATIONAL SPEC — NOT IMPLEMENTED** — No `pinnedPaneIds` in `useLayoutStore.ts`
> or `usePaneStore.ts`. No Cmd+Shift+P handler. No pin indicators. This spec describes planned
> behavior only. Related: FLO-136 (simpler ephemeral panes) was reverted — see
> [`docs/archive/FLO-136-EPHEMERAL-PANES-POSTMORTEM.md`](archive/FLO-136-EPHEMERAL-PANES-POSTMORTEM.md).

## Overview

Implement a "pinned pane" system for the outliner that changes how wikilink navigation works. When a pane is **pinned**, clicking links in it opens content in a reusable "preview" pane rather than navigating in place. This enables a "home base" workflow where users can browse linked content without losing their current position.

**This supersedes the simpler ephemeral pane system (FLO-136) with a richer mental model.**

## Mental Model

**Three pane states:**

| State | Description | Link click behavior |
|-------|-------------|---------------------|
| NORMAL | Default state | Navigates in place |
| PINNED | User's "home base" | Opens target in preview pane |
| PREVIEW | Reusable temporary pane | Navigates in place; typing converts to PINNED |

**Preview slots:**
- Two preview slots exist: one horizontal (right), one vertical (below)
- At most one preview pane per direction at any time
- When clicking from a pinned pane, the appropriate preview slot is reused/created

**Key insight:** The STATE of the SOURCE pane determines behavior, not modifier keys.

## User Flows

### Flow 1: Setting up a home base
```
1. User opens outliner (pane is NORMAL)
2. Navigates to their daily note
3. Zooms into a specific section (Cmd+Enter)
4. Pins the pane (Cmd+Shift+P, or Cmd+Shift+Enter to zoom+pin)
5. Pane is now PINNED - shows pin indicator
```

### Flow 2: Browsing from home base
```
1. User is in PINNED daily note
2. Clicks [[Project X]] → preview pane opens to the right showing Project X
3. Clicks [[Meeting Notes]] → same preview pane updates to show Meeting Notes
4. Cmd+Clicks [[Reference Doc]] → vertical preview opens below showing Reference Doc
5. User still sees their daily note on the left, undisturbed
```

### Flow 3: Promoting a preview to pinned
```
1. User clicks [[Project X]] from pinned pane → preview opens
2. User starts typing in the preview pane
3. Preview automatically becomes PINNED
4. Next click from original pinned pane creates a NEW preview
```

### Flow 4: Nested pinned panes
```
1. Daily note is PINNED (left)
2. Click [[Project X]] → preview opens (right)
3. Type in Project X → it becomes PINNED
4. Now both panes are pinned
5. Click link in either → opens in preview (reuses slot or creates new)
```

## Interaction Specification

### From a PINNED pane:
| Action | Result |
|--------|--------|
| Click wikilink | Open/navigate horizontal preview |
| Cmd+Click wikilink | Open/navigate vertical preview |

### From a NORMAL pane:
| Action | Result |
|--------|--------|
| Click wikilink | Navigate in place (current behavior) |
| Cmd+Click wikilink | Create new permanent split, horizontal (current behavior) |
| Cmd+Shift+Click wikilink | Create new permanent split, vertical (current behavior) |

### From a PREVIEW pane:
| Action | Result |
|--------|--------|
| Click wikilink | Navigate in place (stays preview) |
| Type / Enter / Space | Pane becomes PINNED, preview slot cleared |

### Pin management:
| Action | Result |
|--------|--------|
| Cmd+Shift+P | Toggle pin state on current pane |
| Cmd+Shift+Enter | Zoom into block AND pin (combo action) |

## Visual Design

**PINNED pane:**
- Pin icon (📌 or filled circle ●) displayed in breadcrumb area
- Normal solid border

**PREVIEW pane:**
- Dashed border to indicate temporary/replaceable status
- No pin icon
- Slightly reduced opacity (0.92) - reuse existing `.pane-ephemeral` styling

**NORMAL pane:**
- No special indicators (default appearance)

## Implementation Approach

### Relationship to FLO-136 (Ephemeral Panes)

FLO-136 added:
- `ephemeral?: boolean` on PaneLeaf
- `ephemeralPaneIds` tracking on TabLayout
- Opt+Click for ephemeral splits
- Auto-pin on typing and timeout
- Visual styling (`.pane-ephemeral`)

**Reuse from FLO-136:**
- The `ephemeral` flag becomes the PREVIEW state
- The visual styling (dashed border, opacity)
- The pin-on-typing logic
- The auto-pin timeout (optional, may remove)

**New in FLO-137:**
- PINNED state (new concept - the SOURCE pane that spawns previews)
- State-based routing (pinned pane clicks → preview navigation)
- Cmd+Shift+P keyboard shortcut
- Pin indicator in breadcrumb
- Cmd+Shift+Enter (zoom + pin combo)

### State tracking

Extend the existing layout store or create a separate module:

```ts
// Option A: Add to useLayoutStore.ts (simpler, state co-located)
interface TabLayout {
  tabId: string;
  root: LayoutNode;
  activePaneId: string;
  ephemeralPaneIds?: { horizontal?: string; vertical?: string };  // existing
  pinnedPaneIds?: Set<string>;  // NEW: panes in PINNED state
}

// Option B: Separate module (cleaner separation)
// src/lib/paneStateTracker.ts
type PaneState = 'normal' | 'pinned' | 'preview';

export function getPaneState(paneId: string): PaneState;
export function setPinned(paneId: string, pinned: boolean): void;
export function isPreview(paneId: string): boolean;
// ... preview slot management (reuse ephemeralPaneIds logic)
```

### Files to modify

1. **src/hooks/useLayoutStore.ts**
   - Add `pinnedPaneIds` tracking to TabLayout (or Set)
   - Add `setPinned(tabId, paneId, pinned)` action
   - Add `isPinned(tabId, paneId)` getter
   - Modify existing ephemeral logic to work with new mental model

2. **src/components/BlockItem.tsx**
   - Modify `handleWikilinkClick`:
     - Check if current pane is PINNED → route to preview pane logic
     - Check if current pane is PREVIEW → navigate in place
     - Check if current pane is NORMAL → existing behavior
   - Remove Opt+Click ephemeral logic (replaced by pinned pane model)

3. **src/hooks/useBacklinkNavigation.ts**
   - Add function `openInPreview(target, paneId, direction)`
   - Reuse existing `navigateToPage` with preview slot management

4. **src/components/Outliner.tsx**
   - Add keyboard handler for Cmd+Shift+P (toggle pin)
   - Add keyboard handler for Cmd+Shift+Enter (zoom + pin)
   - Pass pin state to Breadcrumb

5. **src/components/Breadcrumb.tsx**
   - Display pin indicator when pane is pinned
   - Optional: make indicator clickable to toggle

6. **src/components/OutlinerPane.tsx**
   - Pass pane state (pinned/preview/normal) down for styling
   - Existing pin-on-typing logic should continue working

7. **src/index.css**
   - Reuse `.pane-ephemeral` for PREVIEW state
   - Add `.pin-indicator` styling

### Key logic: handleWikilinkClick (updated)

```ts
const handleWikilinkClick = (target: string, e: MouseEvent) => {
  const paneState = getPaneState(props.paneId);  // 'normal' | 'pinned' | 'preview'

  if (paneState === 'pinned') {
    // PINNED pane: open in preview, don't navigate this pane
    const direction = e.metaKey ? 'vertical' : 'horizontal';
    openInPreview(target, props.paneId, direction);
    return;
  }

  // NORMAL or PREVIEW pane: navigate in place or create permanent split
  const modKey = isMac ? e.metaKey : e.ctrlKey;

  if (modKey) {
    // Cmd+Click from NORMAL → permanent split (existing behavior)
    const splitDirection = e.shiftKey ? 'vertical' : 'horizontal';
    navigateToPage(target, props.paneId, splitDirection);
  } else {
    // Plain click → navigate in place
    navigateToPage(target, props.paneId, 'none');
  }
};
```

### Key logic: openInPreview

```ts
function openInPreview(
  pageName: string,
  sourcePaneId: string,
  direction: 'horizontal' | 'vertical'
): NavigationResult {
  const tabId = findTabIdByPaneId(sourcePaneId);
  if (!tabId) return { success: false, error: 'No tab found' };

  const existingPreviewId = layoutStore.getEphemeralPaneId(tabId, direction);

  if (existingPreviewId && paneExists(tabId, existingPreviewId)) {
    // Preview slot exists - navigate it to new page
    paneStore.setZoomedRoot(existingPreviewId, findOrCreatePage(pageName));
    layoutStore.setActivePaneId(tabId, existingPreviewId);
    return { success: true, targetPaneId: existingPreviewId };
  } else {
    // Create new preview pane
    const newPaneId = layoutStore.splitPane(tabId, direction, 'outliner', true);  // ephemeral=true
    if (newPaneId) {
      paneStore.setZoomedRoot(newPaneId, findOrCreatePage(pageName));
      return { success: true, targetPaneId: newPaneId };
    }
    return { success: false, error: 'Split failed' };
  }
}
```

## Edge Cases

1. **Preview pane closed manually** (Cmd+Shift+W)
   - Already handled: closePane clears ephemeralPaneIds tracking
   - Next click from pinned pane creates fresh preview

2. **Preview pane becomes pinned** (user types)
   - Clear it from ephemeralPaneIds (existing pinPane logic)
   - It's now a regular pinned pane
   - Next click from any pinned pane creates new preview

3. **All panes are pinned**
   - Each can spawn its own preview
   - Preview slots are per-tab, shared across all pinned panes

4. **Tab switching**
   - Pin state per-pane, survives tab switches
   - Each tab has its own preview slots

5. **App restart**
   - Pin state is session-only (not persisted in layouts)
   - All panes come back as NORMAL
   - User re-pins their home base as needed

6. **Zooming in pinned pane**
   - Zoom works normally (Cmd+Enter)
   - Pane stays pinned
   - Escape to zoom out also stays pinned

## Testing Checklist

- [ ] Click in NORMAL pane → navigates in place
- [ ] Cmd+Shift+P in NORMAL pane → pane becomes PINNED, shows indicator
- [ ] Click in PINNED pane → horizontal preview opens
- [ ] Cmd+Click in PINNED pane → vertical preview opens
- [ ] Click another link in PINNED pane → same preview updates (not new pane)
- [ ] Type in PREVIEW pane → becomes PINNED, shows indicator
- [ ] After preview pins, click from original pinned → new preview created
- [ ] Close preview manually → next click creates fresh preview
- [ ] Cmd+Shift+Enter → zooms and pins in one action
- [ ] Cmd+Shift+P on PINNED pane → unpins it (becomes NORMAL)
- [ ] Click in PREVIEW pane → navigates in place, stays preview
- [ ] Visual: PINNED shows pin icon, PREVIEW shows dashed border, NORMAL has no indicator

## Non-Goals (Out of Scope)

- Persisting pin state across app restart
- Multiple preview slots per direction
- Drag-to-pin or other advanced pin gestures
- Terminal pane pinning (outliner only for now)
- Opt+Click gestures (removed in favor of source-pane-state model)

## Migration from FLO-136

FLO-136 (ephemeral panes) is scaffolding for this feature:
- Keep: ephemeral flag, ephemeralPaneIds tracking, visual styling, pin-on-type
- Modify: wikilink click handler routing
- Remove: Opt+Click modifier detection (replaced by pinned-pane-state routing)
- Add: PINNED state tracking, keyboard shortcuts, breadcrumb indicator

---

*This feature creates a workflow similar to "peek" in VS Code or "preview tabs" but adapted for an outliner context where spatial layout and persistent reference documents matter.*
