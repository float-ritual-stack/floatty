---
paths:
  - "src/**/*.{ts,tsx}"
---

# SolidJS Mental Models (CRITICAL)

These patterns apply to all SolidJS components in floatty.

## 1. `<For>` Uses Object Reference as Identity

**The trap**: SolidJS `<For>` tracks items by **object reference**, not by a `key` prop like React.

```typescript
// ❌ BROKEN - creates new objects on each memo run
<For each={items().map(x => ({ ...x, extra: computed }))}>
  {(item) => <Heavy id={item.id} />}
</For>
// SolidJS sees new objects → unmounts old, mounts new → xterm dies

// ✅ CORRECT - use <Key> for explicit identity
import { Key } from '@solid-primitives/keyed';
<Key each={items()} by={(item) => item.id}>
  {(item) => <Heavy id={item().id} />}  // Note: item is a signal accessor
</Key>
```

**Rule**: For heavy components (terminals, canvas, editors), always use `<Key>` from `@solid-primitives/keyed`.

## 2. Don't Destructure Props

Props in SolidJS are **getters on a proxy**. Destructuring breaks reactivity.

```typescript
// ❌ BROKEN - reads props.value once at component creation
function Bad({ value }: Props) {
  return <div>{value}</div>;  // Never updates
}

// ✅ CORRECT - access through props object
function Good(props: Props) {
  return <div>{props.value}</div>;  // Reactive
}
```

## 3. Store Proxies Are Not Plain Objects

SolidJS store values are **proxies**. Don't put them directly into new data structures.

```typescript
// ❌ BROKEN - creates circular reference via proxy
const newSplit = {
  children: [activePane, newPane]  // activePane is a store proxy!
};

// ✅ CORRECT - clone the data
const newSplit = {
  children: [
    { type: 'leaf', id: activePane.id, cwd: activePane.cwd },
    { type: 'leaf', id: newPaneId, cwd: newPane.cwd }
  ]
};
```

## 4. CSS Display vs `<Show>` for Heavy Components

`<Show>` **unmounts** components when condition is false. For heavy components that should survive visibility changes:

```typescript
// ❌ AVOID - unmounts terminal when not visible
<Show when={isVisible()}>
  <TerminalPane />
</Show>

// ✅ PREFER - keeps terminal alive, just hidden
<div style={{ display: isVisible() ? 'block' : 'none' }}>
  <TerminalPane />
</div>
```

## 5. Ref Cleanup Timing

Don't clear refs in `onCleanup` for components that might flicker during re-renders:

```typescript
// ❌ RISKY - parent loses handle during layout changes
onCleanup(() => props.ref?.(null));

// ✅ SAFER - explicit disposal via handler, not lifecycle
// Disposal happens in handleClosePane, not component unmount
```

## 6. Stale Closures When Props Change (CRITICAL)

**The trap**: Unlike React, SolidJS doesn't remount components when props change - it updates props on the **same instance**. Closures created at mount time capture values, not reactive accessors.

**When this bites you**: Component receives changing props (like `<BlockItem id={zoomedRootId()!}>` where zoom target changes), but event handlers still use the OLD prop value.

```typescript
// ❌ BROKEN - blockId captured once when hook called
const { handleKeyDown } = useBlockInput({
  blockId: props.id,  // Evaluated once at mount
  ...
});
// When props.id changes later, handleKeyDown still has old value!

// ✅ CORRECT - getter reads fresh each invocation
const { handleKeyDown } = useBlockInput({
  getBlockId: () => props.id,  // Evaluated each time called
  ...
});

// In the hook:
const handleKeyDown = (e: KeyboardEvent) => {
  const blockId = deps.getBlockId();  // Fresh read from current props
  // ...
};
```

**Why React doesn't have this**: React remounts the component when key props change, creating fresh closures. SolidJS keeps the same instance, so closures stay stale.

**Rule**: When passing props to hooks that create event handlers, use getter functions instead of values for any prop that might change during component lifetime.

**Symptoms of this bug**:
- Event handler uses wrong/stale data
- Works after HMR (which recreates component)
- "Impossible" state where component shows X but handler acts on Y

**Real example**: Nested zoom navigation. After zooming parent → child, keyboard handler still used parent's block ID because `blockId: props.id` was captured at mount.

## 7. Effect Dependency Leaks Through Function Calls (CRITICAL)

**The trap**: `createEffect` tracks ALL reactive reads during execution, including reads inside called functions. If your effect calls a function that reads from a store, you just created a dependency on that store.

**When this bites you**: Effect should run on signal A change, but also runs on unrelated signal B change because an internal function reads B.

```typescript
// ❌ BROKEN - effect runs on EVERY block content change
createEffect(() => {
  const zoomTarget = zoomedRootId();  // Intended dependency
  if (zoomTarget) {
    collapse.expandToDepth(zoomTarget, 2);  // ← reads block store internally!
  }
});
// expandToDepth walks tree, reads block.childIds → effect depends on block store
// User types → store update → effect re-runs → resets collapse state

// ✅ CORRECT - use on() to explicitly declare dependencies
import { on } from 'solid-js';

createEffect(on(zoomedRootId, (zoomTarget, prevTarget) => {
  if (zoomTarget && zoomTarget !== prevTarget) {
    collapse.expandToDepth(zoomTarget, 2);  // Store reads ignored
  }
}));
```

**Why `on()` works**: It tells SolidJS "only track this specific signal, ignore everything else accessed during execution."

**Rule**: When an effect should only respond to specific signals but calls functions that read other reactive state, wrap with `on()`.

**Symptoms of this bug**:
- Effect runs far more often than expected
- State resets unexpectedly when editing unrelated data
- Y.Doc content updates trigger unrelated UI effects

**Real example**: Auto-expand on zoom. Effect ran `expandToDepth` which read block store → effect became dependent on block content → every keystroke reset collapse state.

## 8. Scoped Async Actions (Prevent Deadlocks)

**The trap**: A single global `busy()` signal disables ALL buttons, including ones needed to unblock the current operation.

```typescript
// ❌ BROKEN - global busy creates deadlock
const [busy, setBusy] = createSignal(false);

async function longTask() {
  setBusy(true);
  // ... task needs user to click "Confirm" button
  // But Confirm is disabled because busy() is true!
}

// ✅ CORRECT - scoped pending state per action
const [saving, setSaving] = createSignal(false);
const [confirming, setConfirming] = createSignal(false);

async function save() {
  if (saving()) return;  // Prevent double-click
  setSaving(true);
  try { await doSave(); }
  finally { setSaving(false); }
}
```

**Rule**: Each async action gets its own pending signal. Never share a global `busy()` across unrelated operations.

## 9. Signal Snapshots Before Await

**The trap**: Reading a signal after `await` may get a different value than before - the user or another action may have changed it.

```typescript
// ❌ RISKY - signal may change during await
async function handlePermission() {
  await someAsyncWork();
  const request = activePermission();  // May be different now!
  respond(request.id);
}

// ✅ CORRECT - snapshot values before await
async function handlePermission() {
  const request = activePermission();
  if (!request) return;
  const requestId = request.id;  // Capture BEFORE await

  await someAsyncWork();
  respond(requestId);  // Uses stable value
}
```

**Rule**: If you need stable signal values across an async boundary, snapshot them into local variables before the first `await`.

## 10. Pointer Events on Window (Drag Operations)

**The trap**: Drag operations that might leave the original element need window-level listeners. Using element-level listeners loses tracking if pointer leaves the element bounds.

**When this bites you**: User drags column resize handle quickly, pointer exits element, drag stops unexpectedly.

```typescript
// ❌ BROKEN - loses tracking when pointer leaves element
const handlePointerDown = (e: PointerEvent) => {
  const el = e.currentTarget as HTMLElement;
  el.addEventListener('pointermove', handlePointerMove);
  el.addEventListener('pointerup', handlePointerUp);
  // ↑ If pointer leaves el during drag, pointermove stops firing
};

// ✅ CORRECT - use window listeners for cross-element tracking
const handlePointerDown = (e: PointerEvent) => {
  // Capture pointer to track across element boundaries
  (e.target as HTMLElement).setPointerCapture(e.pointerId);

  const handlePointerMove = (e: PointerEvent) => {
    // Fired even if pointer is outside original element
    updateDragState(e.clientX, e.clientY);
  };

  const handlePointerUp = () => {
    window.removeEventListener('pointermove', handlePointerMove);
    window.removeEventListener('pointerup', handlePointerUp);
  };

  // Attach to window, not element
  window.addEventListener('pointermove', handlePointerMove);
  window.addEventListener('pointerup', handlePointerUp);
};
```

**Additional patterns**:

```typescript
// Capture pointer for guaranteed tracking
(e.target as HTMLElement).setPointerCapture(e.pointerId);

// Update cursor feedback during drag
document.body.style.cursor = 'col-resize';  // During drag
document.body.style.cursor = '';  // On pointerup

// Prevent touch scroll while dragging
touch-action: none;  // CSS on element
```

**Rule**: For any drag/interactive operation that extends beyond element bounds (resize handles, sliders, drag-to-select), use window-level listeners with `setPointerCapture()`.

**Real example**: FLO-58 column resizing. Handles are thin targets, user drags quickly, pointer exits handle. Window listeners keep tracking. `setPointerCapture()` ensures `pointerup` fires even if released far from element.

**See also**: [[../docs/learnings/2026-01-30-flo-58-table-improvements.md|FLO-58 Table Improvements]] - practical implementation of this pattern in `BlockDisplay.tsx`
