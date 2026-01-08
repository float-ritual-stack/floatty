# Floatty Code Review Remediation Task

> **Generated**: 2026-01-07
> **Source**: 6-agent parallel code review (CSS, SolidJS, xterm, Yjs, Tauri, Outliner)

You are a Senior Rust & TypeScript Systems Architect tasked with fixing issues identified in a parallel code review of Floatty, a local-first hybrid application combining a Roam-like block outliner (Yjs/CRDT-backed) with a tiling terminal emulator (xterm.js + tauri-plugin-pty).

## Tech Stack Context

- **Frontend**: SolidJS (fine-grained reactivity with signals/stores, NOT React)
- **Backend**: Tauri v2 (Rust) with plugin architecture
- **Terminal**: xterm.js with WebGL renderer and addons
- **CRDT**: Yjs for collaborative editing, synced via HTTP/WebSocket
- **Styling**: CSS variables for theming, no CSS-in-JS

## Your Mission

Address all issues below in priority order. For each fix:
1. Locate the exact code location
2. Understand the surrounding context and why the current code is problematic
3. Implement the fix following existing patterns in the codebase
4. Verify the fix doesn't introduce regressions
5. Document your changes with brief inline comments where the issue was non-obvious

---

## PHASE 1: Medium-Priority Fixes (⚠️ Fix Soon)

These issues cause silent data loss, visual bugs, or potential freeze conditions.

---

### Issue 1.1: `textContent` vs `innerText` - Multi-line Content Loss

**Severity**: ⚠️ Medium (Silent data loss in multi-line blocks)

**Problem**: In contentEditable elements, browsers render newlines as `<div>` or `<br>` elements. `textContent` ignores these element boundaries and concatenates text nodes directly, losing line breaks. `innerText` respects visual formatting and converts element breaks to `\n`.

**Affected Files & Locations**:

1. `src/components/BlockItem.tsx` - Shift+Tab handler (~line 384-410)
2. `src/hooks/useBlockInput.ts` - `remove_spaces` action (~line 376-410)

**Current Problematic Code Pattern**:
```typescript
// In BlockItem.tsx Shift+Tab handler:
const text = contentRef.textContent || '';
const pos = cursor.getOffset();
const lineStart = text.lastIndexOf('\n', pos - 1) + 1;
// ... manipulates text ...
contentRef.textContent = newText;

// In useBlockInput.ts:
const text = contentRef.textContent || '';
```

**Fix Instructions**:

1. Open `src/components/BlockItem.tsx`
2. Locate the `handleKeyDown` function's Tab/Shift+Tab handling (around line 380-420)
3. Find the Shift+Tab branch that removes leading spaces from lines
4. Change all READ operations from `textContent` to `innerText`:
   ```typescript
   // BEFORE
   const text = contentRef.textContent || '';

   // AFTER
   const text = contentRef.innerText || '';
   ```
5. For WRITE operations, keep `textContent` (it's faster and we immediately sync to store anyway):
   ```typescript
   contentRef.textContent = newText;
   store.updateBlockContent(props.id, newText);
   ```

6. Open `src/hooks/useBlockInput.ts`
7. Locate the `remove_spaces` case in the action handler (around line 376)
8. Apply the same fix:
   ```typescript
   case 'remove_spaces': {
     e.preventDefault();
     const contentRef = deps.getContentRef();
     if (contentRef) {
       const text = contentRef.innerText || '';  // CHANGED from textContent
       // ... rest of logic
     }
   }
   ```

**Verification**:
1. Create a block with multiple lines (press Shift+Enter or paste multi-line text)
2. Position cursor in middle of a line that has leading spaces
3. Press Shift+Tab
4. Verify: Line breaks are preserved, only leading spaces on current line are removed
5. Check the store content matches the visual display

---

### Issue 1.2: `--font-mono` CSS Variable Undefined

**Severity**: ⚠️ Medium (Visual inconsistency - DailyView and StatusBar render in system font)

**Problem**: Components reference `var(--font-mono)` but this CSS variable is never defined in `:root`. The browser falls back to the initial value (likely system default), causing inconsistent typography.

**Affected Files**:
- `src/index.css` (missing variable definition)
- Components using `--font-mono`: StatusBar, DailyView, potentially others

**Required Fix**:

1. Open `src/index.css`
2. Locate the `:root` block (typically at the top of the file)
3. Add the missing variable:

```css
:root {
  /* ... existing variables ... */

  /* Typography - Monospace font stack */
  --font-mono: "JetBrains Mono", "Fira Code", "Cascadia Code", ui-monospace,
               SFMono-Regular, Menlo, Monaco, "Courier New", monospace;
}
```

4. Search the codebase for other `var(--font-` references to ensure all are defined:
```bash
grep -r "var(--font-" src/ --include="*.css" --include="*.tsx"
```

5. If you find `--font-sans` or similar, add those too:
```css
:root {
  --font-mono: "JetBrains Mono", "Fira Code", ui-monospace, monospace;
  --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
```

**Verification**:
1. Run the application
2. Check DailyView component - text should render in JetBrains Mono
3. Check StatusBar - shortcuts and labels should use monospace font
4. Use browser DevTools → Computed Styles to verify `font-family` resolves correctly

---

### Issue 1.3: ResizeOverlay Missing `setDragging(false)` Cleanup

**Severity**: ⚠️ Medium (Potential permanent freeze of terminal fit() operations)

**Problem**: In `ResizeOverlay.tsx`, the `onCleanup` handler sets local `isDragging = false` but doesn't call `terminalManager.setDragging(false)`. If a component unmounts mid-drag (e.g., closing a split while dragging), the terminal manager's global `isDragging` flag stays `true` forever, suppressing all future `fit()` calls.

**Affected File**: `src/components/ResizeOverlay.tsx` (~line 117-136)

**Current Problematic Code**:
```typescript
onCleanup(() => {
  // ... observer cleanup ...

  // ALWAYS remove resizing class - even if isDragging seems false
  document.body.classList.remove('resizing');
  if (isDragging) {
    isDragging = false;
    layoutStore.setDraggingSplitId(null);
  }
  // MISSING: terminalManager.setDragging(false)
});
```

**Required Fix**:

1. Open `src/components/ResizeOverlay.tsx`
2. Locate the `onCleanup` callback in the `ResizeHitArea` component (around line 117)
3. Add the missing cleanup call:

```typescript
onCleanup(() => {
  // Clean up retry timeout if still pending
  if (retryTimeoutId) {
    clearTimeout(retryTimeoutId);
    retryTimeoutId = null;
  }

  observer.disconnect();

  // CRITICAL: Clean up window listeners if unmount happens mid-drag
  if (activePointerMoveListener) {
    window.removeEventListener('pointermove', activePointerMoveListener);
    activePointerMoveListener = null;
  }
  if (activePointerUpListener) {
    window.removeEventListener('pointerup', activePointerUpListener);
    window.removeEventListener('pointercancel', activePointerUpListener);
    activePointerUpListener = null;
  }

  // ALWAYS remove resizing class
  document.body.classList.remove('resizing');

  if (isDragging) {
    isDragging = false;
    layoutStore.setDraggingSplitId(null);

    // FIX: Also reset terminal manager drag state to unblock fit() calls
    terminalManager.setDragging(false);
  }
});
```

4. Verify the import exists at the top of the file:
```typescript
import { terminalManager } from '../lib/terminalManager';
```

**Verification**:
1. Split a terminal pane horizontally
2. Start dragging the resize handle
3. While still dragging, press Cmd+W to close the pane
4. Open a new terminal pane and resize the window
5. Verify: Terminal content reflows correctly (fit() is working)

---

### Issue 1.4: `deleteBlock` Zoom Boundary Violation

**Severity**: ⚠️ Medium (Navigation can escape zoom view after delete)

**Problem**: In `useBlockInput.ts`, the `deleteBlock` action uses `findPrevId()` to determine focus after deletion. This function doesn't respect zoom boundaries - it can return a block ID outside the current zoomed subtree, causing the user's focus to "escape" the zoom view unexpectedly.

The correct function to use is `findFocusAfterDelete()` which respects zoom boundaries.

**Affected File**: `src/hooks/useBlockInput.ts` (~line 124)

**Current Problematic Code**:
```typescript
case 'deleteBlock':
  return { type: 'delete_block', prevId: deps.findPrevId() };
```

**Required Fix**:

1. Open `src/hooks/useBlockInput.ts`
2. Locate the `determineKeyAction` function and find the `deleteBlock` case (~line 124)
3. The fix requires access to `findFocusAfterDelete` which needs both blockId and paneId

**Option A - If deps already has findFocusAfterDelete**:
```typescript
case 'deleteBlock':
  return {
    type: 'delete_block',
    prevId: deps.findFocusAfterDelete?.(deps.blockId, deps.paneId) ?? deps.findPrevId()
  };
```

**Option B - Update the interface** (if findFocusAfterDelete isn't available):

First, check `BlockInputDependencies` interface. If `findFocusAfterDelete` is missing, add it:

```typescript
export interface BlockInputDependencies {
  // ... existing fields ...

  // Navigation
  findNextVisibleBlock: (id: string, paneId: string) => string | null;
  findPrevVisibleBlock: (id: string, paneId: string) => string | null;
  findFocusAfterDelete: (id: string, paneId: string) => string | null;  // ADD THIS

  // ...
}
```

Then update `determineKeyAction`:
```typescript
case 'deleteBlock': {
  // Use findFocusAfterDelete which respects zoom boundaries
  const focusTarget = deps.findFocusAfterDelete
    ? deps.findFocusAfterDelete(deps.blockId, deps.paneId)
    : deps.findPrevId();
  return { type: 'delete_block', prevId: focusTarget };
}
```

4. Update the caller in `BlockItem.tsx` to pass `findFocusAfterDelete` if needed

**Verification**:
1. Create a page with nested blocks: A → B → C → D
2. Zoom into block B (Cmd+Enter)
3. Focus block D and delete it (Cmd+Backspace)
4. Verify: Focus moves to C (inside zoom), NOT to A (outside zoom)
5. Delete C
6. Verify: Focus moves to B (the zoomed root) or its first child

---

### Issue 1.5: `.md-code` Padding May Cause Cursor Drift

**Severity**: ⚠️ Low-Medium (Cursor position may not match visual position in formatted text)

**Problem**: The overlay architecture renders formatted text (BlockDisplay) on top of the editable layer. If `.md-code` spans have padding/margin, the visual width differs from the underlying text, causing cursor position to drift from where the user clicks.

**Affected File**: `src/index.css` (~line 716-720)

**Current Code** (search for `.md-code` or `.block-display`):
```css
.block-display .md-code {
  padding: 0 2px;
  margin: 0 1px;
  /* ... */
}
```

**Potential Fixes** (choose based on analysis):

**Option A - Remove padding entirely**:
```css
.block-display .md-code {
  /* Remove horizontal padding to prevent cursor drift */
  padding: 0;
  margin: 0;
  background-color: var(--color-bg-light);
  border-radius: 3px;
}
```

**Option B - Use box-shadow instead of padding** (visual separation without width change):
```css
.block-display .md-code {
  padding: 0;
  margin: 0;
  background-color: var(--color-bg-light);
  /* Use box-shadow for visual padding that doesn't affect layout */
  box-shadow: -2px 0 0 var(--color-bg-light), 2px 0 0 var(--color-bg-light);
}
```

**Verification**:
1. Create a block with inline code: `some text with `code` in the middle`
2. Click directly on the `c` in `code`
3. Verify: Cursor appears exactly where you clicked
4. Type characters and verify cursor moves predictably
5. Test with multiple code spans: `one` and `two` and `three`

---

## PHASE 2: Refactoring Tasks (🛠 When Convenient)

These improve code quality but don't fix bugs.

---

### Issue 2.1: Double-rAF Pattern Inconsistency

**Problem**: The codebase uses `requestAnimationFrame(() => requestAnimationFrame(() => ...))` in many places to wait for SolidJS reactivity + DOM updates to settle. This pattern should be extracted to a utility for consistency and clarity.

**Affected Locations** (8+ places):
- `BlockItem.tsx` - multiple focus operations
- `useBlockInput.ts` - focus after operations
- `Outliner.tsx` - undo/redo focus restoration
- `TerminalPane.tsx` - visibility effects
- Others

**Create Utility** - `src/lib/domUtils.ts`:
```typescript
/**
 * Execute callback after SolidJS reactivity and DOM updates settle.
 *
 * Uses double-rAF pattern:
 * - First rAF: Waits for current JS execution + SolidJS batch to flush
 * - Second rAF: Waits for browser layout/paint
 *
 * Common use: Focus element after Y.Doc update triggers SolidJS re-render
 *
 * @param callback - Function to execute after DOM settles
 * @returns Cleanup function to cancel pending callback
 */
export function afterDOMSettle(callback: () => void): () => void {
  let cancelled = false;
  let rafId1: number | undefined;
  let rafId2: number | undefined;

  rafId1 = requestAnimationFrame(() => {
    if (cancelled) return;
    rafId2 = requestAnimationFrame(() => {
      if (cancelled) return;
      callback();
    });
  });

  return () => {
    cancelled = true;
    if (rafId1 !== undefined) cancelAnimationFrame(rafId1);
    if (rafId2 !== undefined) cancelAnimationFrame(rafId2);
  };
}

/**
 * Focus an element after DOM settles, with mount guard.
 *
 * @param getElement - Function returning the element (or undefined if unmounted)
 * @param isMounted - Ref to mounted state (prevents focus after cleanup)
 */
export function focusAfterSettle(
  getElement: () => HTMLElement | undefined,
  isMounted?: { current: boolean }
): () => void {
  return afterDOMSettle(() => {
    if (isMounted && !isMounted.current) return;
    getElement()?.focus();
  });
}
```

**Migration Strategy**:
1. Create `src/lib/domUtils.ts` with utilities
2. Migrate one file at a time, starting with `BlockItem.tsx`
3. Use search to find all `requestAnimationFrame.*requestAnimationFrame` patterns
4. Replace each with the appropriate utility

---

### Issue 2.2: Hardcoded Colors in Outliner Clear Button

**Problem**: The "Clear" button in Outliner.tsx uses inline hardcoded colors instead of CSS variables.

**Affected File**: `src/components/Outliner.tsx`

**Current Code**:
```tsx
<button
  style={{
    color: confirmClear() ? '#ef4444' : '#888',
    "border-color": confirmClear() ? '#ef4444' : '#555',
    background: confirmClear() ? 'rgba(239, 68, 68, 0.1)' : 'transparent'
  }}
>
```

**Fixed Code**:
```tsx
<button
  class="outliner-clear-button"
  classList={{ 'outliner-clear-confirm': confirmClear() }}
>
  {confirmClear() ? 'Confirm?' : 'Clear'}
</button>
```

**Add to CSS** (`src/index.css`):
```css
.outliner-clear-button {
  font-size: 10px;
  padding: 2px 6px;
  border: 1px solid var(--color-border);
  color: var(--color-fg-muted);
  background: transparent;
  cursor: pointer;
  border-radius: 3px;
  transition: all 0.15s ease;
}

.outliner-clear-button:hover {
  border-color: var(--color-fg-muted);
}

.outliner-clear-button.outliner-clear-confirm {
  color: var(--color-error);
  border-color: var(--color-error);
  background: color-mix(in srgb, var(--color-error) 10%, transparent);
}
```

---

### Issue 2.3: Duplicate Base64 Utilities

**Problem**: `base64ToBytes` and `bytesToBase64` are defined identically in two files:
- `src/hooks/useSyncedYDoc.ts`
- `src/lib/httpClient.ts`

**Solution**: Extract to shared module.

1. Create `src/lib/encoding.ts`:
```typescript
/**
 * Base64 encoding utilities for binary IPC
 */

/**
 * Decode Base64 string to Uint8Array
 */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Encode Uint8Array to Base64 string
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
```

2. Update `src/hooks/useSyncedYDoc.ts`:
```typescript
// Remove local definitions, add import:
import { base64ToBytes, bytesToBase64 } from '../lib/encoding';

// Keep the exports for consumers:
export { base64ToBytes, bytesToBase64 } from '../lib/encoding';
```

3. Update `src/lib/httpClient.ts`:
```typescript
// Remove local definitions, add import:
import { base64ToBytes, bytesToBase64 } from './encoding';
```

---

### Issue 2.4: Type-Safe Invoke Wrapper Not Universally Used

**Problem**: `src/lib/tauriTypes.ts` provides a type-safe `invoke` wrapper, but some files still use the raw `@tauri-apps/api/core` import.

**Files to Migrate** (search for `from '@tauri-apps/api/core'`):
- Check each file that imports `invoke` from `@tauri-apps/api/core`
- If the command is defined in `TauriCommands`, switch to the typed wrapper

**Migration Pattern**:
```typescript
// BEFORE
import { invoke } from '@tauri-apps/api/core';
const result = await invoke<string>('some_command', { arg: value });

// AFTER
import { invoke } from '../lib/tauriTypes';
const result = await invoke('some_command', { arg: value });
// Type safety! If 'some_command' isn't in TauriCommands, TypeScript errors
```

---

### Issue 2.5: Dead `.terminal-pane` CSS Selector

**Problem**: CSS defines `.terminal-pane` but the component uses `.terminal-pane-positioned`.

**Action**:
1. Search CSS files for `.terminal-pane` (without `-positioned`)
2. Verify no components use this class
3. If confirmed dead, remove the rules

```bash
# Find potential dead selectors
grep -r "\.terminal-pane[^-]" src/ --include="*.css"
grep -r "terminal-pane['\"]" src/ --include="*.tsx"
```

---

## PHASE 3: Verification Checklist

After completing all fixes, verify:

### Functional Tests
- [ ] Multi-line blocks: Create, edit, Shift+Tab indent - line breaks preserved
- [ ] DailyView renders in monospace font
- [ ] StatusBar renders in monospace font
- [ ] Resize handle: drag, close pane mid-drag, terminals still resize correctly
- [ ] Zoomed view: delete block, focus stays within zoom
- [ ] Inline code: cursor position matches click location

### Visual Tests
- [ ] No hardcoded colors visible (use DevTools color picker to verify variables)
- [ ] Consistent typography across app

### Code Quality
- [ ] No duplicate `base64ToBytes`/`bytesToBase64` definitions
- [ ] All new `invoke()` calls use typed wrapper where possible
- [ ] No dead CSS selectors for `.terminal-pane`

---

## Execution Order

Recommended order to minimize conflicts:

1. **Issue 1.2** (CSS variable) - Standalone, no dependencies
2. **Issue 2.3** (Base64 utils) - Creates shared module others might use
3. **Issue 1.1** (textContent fix) - Core functionality
4. **Issue 1.3** (ResizeOverlay cleanup) - Critical path
5. **Issue 1.4** (deleteBlock zoom) - Behavioral fix
6. **Issue 1.5** (md-code padding) - Visual polish
7. **Issue 2.1** (Double-rAF utility) - Refactor, touch many files
8. **Issue 2.2** (Hardcoded colors) - Style cleanup
9. **Issue 2.4** (Type-safe invoke) - Gradual migration
10. **Issue 2.5** (Dead CSS) - Cleanup

---

## Notes for the Agent

1. **Test after each fix** - Don't batch all changes then test
2. **Preserve existing patterns** - Match surrounding code style
3. **Comment non-obvious fixes** - Especially the textContent→innerText change
4. **Don't over-engineer** - The refactoring tasks are optional; prioritize bug fixes
5. **Ask if unclear** - Some fixes have multiple valid approaches
