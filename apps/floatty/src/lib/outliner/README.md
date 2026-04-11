# Outliner Component

A reusable block-based outliner with keyboard-first navigation.

## Quick Start (shadcn-style)

Copy these files to your project:

```
src/lib/outliner/
├── types.ts              # Block, KeyboardAction types
├── blockContext.ts       # Discrete state for keyboard behavior
├── keybinds.ts          # Outliner-specific key mappings
├── determineKeyAction.ts # Pure keyboard logic
└── useCursor.ts         # Cursor abstraction for testing
```

Then implement your own:
- Block store (CRDT or whatever persistence you need)
- BlockItem component (render and wire up keybinds)
- Outliner component (document-level selection, navigation)

## Architecture

```
┌─────────────────────────────────────────┐
│ Your App                                │
├─────────────────────────────────────────┤
│ Outliner Component (selection, nav)     │
├─────────────────────────────────────────┤
│ BlockItem Component (per-block input)   │
├─────────────────────────────────────────┤
│ determineKeyAction() ← PURE LOGIC       │
├─────────────────────────────────────────┤
│ BlockContext (discrete state)           │
├─────────────────────────────────────────┤
│ Your Store (CRDT, Redux, etc.)          │
└─────────────────────────────────────────┘
```

## Key Concepts

### BlockContext (Discrete State)
Instead of querying cursor/DOM on demand, build a context object that captures discrete states:

```typescript
interface BlockContext {
  cursorAt: 'start' | 'middle' | 'end';  // Discrete, not offset
  hasChildren: boolean;
  isCollapsed: boolean;
  // ...
}
```

### KeyboardAction (Discriminated Union)
Keyboard handler returns an action type, not side effects:

```typescript
type KeyboardAction =
  | { type: 'navigate_up'; prevId: string | null }
  | { type: 'split_block'; offset: number }
  | { type: 'indent' }
  // ...
```

### Predicates
Readable helpers for keyboard logic:

```typescript
if (canNavigateUp(ctx, shiftKey)) { ... }
if (shouldCreateFirstChild(ctx)) { ... }
```

## Testing

The architecture enables testing without DOM:

```typescript
import { determineKeyAction } from './outliner/determineKeyAction';
import { createTestBlockContext } from './outliner/blockContext';

it('splits block when Enter in middle', () => {
  const ctx = createTestBlockContext({ cursorAt: 'middle' });
  const action = determineKeyAction('Enter', false, ctx);
  expect(action.type).toBe('split_block');
});
```

## Customization

### Custom Keybinds
Override the keybind config to add/remove shortcuts.

### Execution Callback
Instead of importing an executor, pass callbacks:

```typescript
<Outliner
  onExecute={(blockId, content) => /* your executor */}
  isExecutable={(content) => content.startsWith('sh::')}
/>
```

### Custom Classes
Style with your own class names:

```typescript
<Outliner
  classNames={{
    item: 'my-block-item',
    focused: 'my-focused',
    selected: 'my-selected',
  }}
/>
```
