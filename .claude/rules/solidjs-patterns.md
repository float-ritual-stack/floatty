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
