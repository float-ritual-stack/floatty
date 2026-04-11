# Rich Output Handler Guide

How to add a new `prefix::` handler that renders rich output (search::, daily::, future kanban::, etc.)

## Mental Model

```
USER TYPES          HANDLER EXECUTES           BLOCKITEM RENDERS
─────────────       ────────────────           ─────────────────
search:: foo   →    sets outputType +     →    detects isOutputBlock()
                    output on block            renders view component
                                               focus/keyboard just works
```

The handler's job is to **populate data**. BlockItem's job is to **render and handle focus**. The view component is **display-only**.

## File Structure

```
src/lib/handlers/
  └── myfeature.ts          # Handler: parse content, execute, set output

src/components/views/
  └── MyFeatureView.tsx     # View: display-only, receives data + focusedIdx

src/components/
  └── BlockItem.tsx         # Integration: isOutputBlock(), Show condition

src/index.css               # Styles for the new view
```

## Step 1: Create the Handler

```typescript
// src/lib/handlers/myfeature.ts
import type { BlockHandler, HandlerActions } from './registry';

export interface MyFeatureData {
  items: Array<{ id: string; label: string }>;
  query?: string;
}

export const myfeatureHandler: BlockHandler = {
  prefixes: ['myfeature::'],

  async execute(
    blockId: string,
    content: string,
    actions: HandlerActions
  ): Promise<void> {
    const query = content.replace(/^myfeature::\s*/, '').trim();

    // Set pending state (shows spinner)
    actions.setOutput(blockId, {
      outputType: 'myfeature-results',
      outputStatus: 'running',
      output: null,
    });

    try {
      const results = await doMyFeatureThing(query);

      actions.setOutput(blockId, {
        outputType: 'myfeature-results',
        outputStatus: 'complete',
        output: results satisfies MyFeatureData,
      });
    } catch (err) {
      actions.setOutput(blockId, {
        outputType: 'myfeature-error',
        outputStatus: 'error',
        output: { error: String(err) },
      });
    }
  },
};
```

## Step 2: Register the Handler

```typescript
// src/lib/handlers/index.ts
import { myfeatureHandler } from './myfeature';
registry.register(myfeatureHandler);
```

## Step 3: Create the View Component (Display-Only)

```typescript
// src/components/views/MyFeatureView.tsx
import { For, Show, createEffect } from 'solid-js';

interface MyFeatureViewProps {
  data: MyFeatureData;
  paneId?: string;
  blockId?: string;
  focusedIdx?: () => number;  // Signal accessor, NOT a value
}

export function MyFeatureView(props: MyFeatureViewProps) {
  let listRef: HTMLDivElement | undefined;
  const getFocusedIdx = () => props.focusedIdx?.() ?? -1;

  // Scroll focused item into view
  createEffect(() => {
    const idx = getFocusedIdx();
    if (idx >= 0 && listRef) {
      const items = listRef.querySelectorAll('.myfeature-item');
      items[idx]?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    }
  });

  return (
    <div ref={listRef} role="listbox">
      <For each={props.data.items}>
        {(item, i) => (
          <div
            classList={{ 'myfeature-item-focused': getFocusedIdx() === i() }}
            role="option"
            aria-selected={getFocusedIdx() === i()}
          >
            {item.label}
          </div>
        )}
      </For>
    </div>
  );
}
```

**Critical rules**:
- NO `tabIndex` on the component or children
- NO `onKeyDown` handlers
- Receive `focusedIdx` as signal accessor, render visual state only
- Use ARIA attributes for accessibility

## Step 4: Integrate into BlockItem.tsx

### 4a. Update `isOutputBlock()`:

```typescript
const isOutputBlock = createMemo(() => {
  const ot = block()?.outputType;
  return ot?.startsWith('daily-') ||
         ot?.startsWith('search-') ||
         ot?.startsWith('myfeature-');  // ADD
});
```

### 4b. Add navigation state:

```typescript
const [myfeatureFocusedIdx, setMyfeatureFocusedIdx] = createSignal(-1);

// Reset on output type change
createEffect(() => {
  const ot = block()?.outputType;
  if (!ot?.startsWith('myfeature-')) {
    setMyfeatureFocusedIdx(-1);
  }
});
```

### 4c. Add keyboard handling in `handleOutputBlockKeyDown`:

```typescript
if (block()?.outputType === 'myfeature-results') {
  const data = block()?.output as MyFeatureData | undefined;
  const items = data?.items ?? [];
  const idx = myfeatureFocusedIdx();

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (idx === -1 && items.length > 0) {
      setMyfeatureFocusedIdx(0);  // Enter list from top
    } else if (idx < items.length - 1) {
      setMyfeatureFocusedIdx(idx + 1);
    } else {
      // At last item - exit to next block
      setMyfeatureFocusedIdx(-1);
      const next = findNextVisibleBlock(props.id, props.paneId);
      if (next) props.onFocus(next);
    }
    return;
  }
  // ... ArrowUp (symmetric), Enter (activate), Escape (deselect)
}
```

### 4d. Add the Show condition:

```tsx
<Show when={block()?.outputType?.startsWith('myfeature-')}>
  <div class="myfeature-output">
    <Show when={block()?.outputStatus === 'running'}>
      <div class="daily-running">
        <span class="daily-running-spinner">◐</span>
        <span>Loading...</span>
      </div>
    </Show>
    <Show when={block()?.outputType === 'myfeature-results' && block()?.outputStatus === 'complete'}>
      <MyFeatureView
        data={block()!.output as MyFeatureData}
        paneId={props.paneId}
        blockId={props.id}
        focusedIdx={myfeatureFocusedIdx}
      />
    </Show>
  </div>
</Show>
```

## Common Navigation Patterns

### Enter from top (ArrowDown into results)
```typescript
if (idx === -1 && items.length > 0) {
  setFocusedIdx(0);
  return;
}
```

### Enter from bottom (ArrowUp into results) - symmetric
```typescript
if (idx === -1 && items.length > 0) {
  setFocusedIdx(items.length - 1);
  return;
}
```

### Exit at boundary
```typescript
if (idx >= items.length - 1) {
  setFocusedIdx(-1);
  const next = findNextVisibleBlock(props.id, props.paneId);
  if (next) props.onFocus(next);
}
```

### Escape to deselect (show block border instead of item highlight)
```typescript
if (e.key === 'Escape') {
  e.preventDefault();
  setFocusedIdx(-1);
}
```

## Testing Checklist

- [ ] Handler registers and executes on prefix match
- [ ] Loading spinner shows during execution
- [ ] Results render when complete
- [ ] Error state renders on failure
- [ ] ArrowDown from block enters results (idx 0)
- [ ] ArrowUp from block enters results (idx last)
- [ ] ArrowDown at last result exits to next block
- [ ] ArrowUp at first result exits to prev block
- [ ] Enter activates focused item
- [ ] Escape clears focus (shows block border)
- [ ] Cmd+Arrow moves the block itself
- [ ] Tab/Shift+Tab indents/outdents block
- [ ] Backspace deletes block
- [ ] Focus ring shows on output block wrapper

## See Also

- [KEYBOARD_CONTROL_PATTERNS.md](KEYBOARD_CONTROL_PATTERNS.md) - The four keyboard patterns
- [INLINE_EXPANSION_PATTERNS.md](INLINE_EXPANSION_PATTERNS.md) - Per-item expandable state
- [MDX_LITE_VISION.md](MDX_LITE_VISION.md) - Future: children as component config
- [FLOATTY_HANDLER_REGISTRY.md](FLOATTY_HANDLER_REGISTRY.md) - Handler registry internals
