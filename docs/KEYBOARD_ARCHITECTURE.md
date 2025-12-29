# Keyboard Architecture

This document describes floatty's outliner keyboard handling architecture, designed for testability and potential extraction as a reusable component.

## 5-Layer Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ Layer 1: UI Components                                          │
│ BlockItem.tsx, Outliner.tsx                                     │
│ - Capture DOM events (onKeyDown)                                │
│ - Build context from current state                              │
│ - Execute returned actions                                      │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Layer 2: Hook Orchestration                                     │
│ useBlockInput.ts                                                │
│ - Wire dependencies (cursor, store, pane)                       │
│ - Bridge pure logic to UI                                       │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Layer 3: Pure Logic (TESTABLE)                                  │
│ determineKeyAction()                                            │
│ - Input: key event + context object                             │
│ - Output: discriminated union action                            │
│ - NO side effects, NO DOM access                                │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Layer 4: State Abstraction                                      │
│ useCursor.ts, WorkspaceContext                                  │
│ - Cursor: isAtStart(), isAtEnd(), getOffset()                   │
│ - Stores: blockStore, paneStore                                 │
│ - Mockable interfaces for testing                               │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Layer 5: Centralized Config                                     │
│ keybinds.ts                                                     │
│ - getActionForEvent(): KeyboardEvent → ActionType | null        │
│ - Platform-aware ($mod = Cmd on macOS, Ctrl elsewhere)          │
│ - Single source of truth for key mappings                       │
└─────────────────────────────────────────────────────────────────┘
```

## Key Files

| File | Purpose | Testability |
|------|---------|-------------|
| `src/components/BlockItem.tsx` | Block-level keyboard handling | Component tests with mock stores |
| `src/components/Outliner.tsx` | Document-level selection/navigation | Component tests |
| `src/hooks/useBlockInput.ts` | Pure `determineKeyAction()` function | Unit tests, no DOM |
| `src/hooks/useCursor.ts` | DOM cursor abstraction | Mock via `createMockCursor()` |
| `src/lib/keybinds.ts` | Key mapping config | Unit tests |
| `src/context/WorkspaceContext.tsx` | DI for stores | `createMockBlockStore()` |

## State That Affects Keyboard Behavior

Keyboard actions depend on these discrete states:

### Cursor Position (Discrete)
```typescript
type CursorAt = 'start' | 'middle' | 'end';

// Derived from:
// - cursor.isAtStart() → 'start'
// - cursor.isAtEnd() → 'end'
// - otherwise → 'middle'
```

**Affects:**
- `ArrowUp` at start → navigate to previous block
- `ArrowDown` at end → navigate to next block
- `Enter` at start → create sibling before
- `Enter` at end → create sibling after (or first child if expanded)
- `Tab` at start → indent/outdent block
- `Tab` elsewhere → insert spaces
- `Backspace` at start → merge with previous block

### Block Tree Position
```typescript
interface TreePosition {
  depth: number;           // Nesting level (0 = root)
  hasChildren: boolean;    // Has child blocks
  isCollapsed: boolean;    // Children hidden
  isZoomedRoot: boolean;   // Currently zoomed into this subtree
}
```

**Affects:**
- `Enter` at end of parent → create first child vs sibling
- `Cmd+.` → toggle collapse (only if hasChildren)
- `Cmd+Enter` → zoom into subtree
- `Escape` → zoom out (only if zoomed)
- `Backspace` at start → prevent merge if hasChildren

### Selection State (FLO-74)
```typescript
interface SelectionState {
  selectedBlockIds: Set<string>;
  selectionAnchor: string | null;  // Range selection start point
}
```

**Affects:**
- `Shift+Arrow` → extend range selection (bypasses cursor check)
- `Cmd+A` → select all visible blocks
- `Cmd+C` → copy selected blocks as markdown
- `Delete/Backspace` on selection → bulk delete
- `Escape` → clear selection

### Block Type
```typescript
type BlockType = 'text' | 'h1' | 'h2' | 'h3' | 'bullet' | 'todo' | 'quote' | 'sh' | 'ai' | ...;
```

**Affects:**
- `Enter` on `sh::`/`ai::` block → execute command (not split)

## Event Flow: BlockItem KeyDown

```
KeyboardEvent
     │
     ▼
getActionForEvent(e)  ─────► Action matched? ──► Handle centralized action
     │                              │              (zoom, collapse, delete)
     │ null                         │
     ▼                              │
Key-specific handler                │
(ArrowUp, ArrowDown, Enter, etc.)   │
     │                              │
     ▼                              │
Check cursor/selection state ◄──────┘
     │
     ▼
Determine action (navigate, split, indent, etc.)
     │
     ▼
Execute via store methods
     │
     ▼
Update focus if needed (props.onFocus)
```

## Event Flow: Outliner KeyDown

Outliner handles document-level keyboard events that span multiple blocks:

```
KeyboardEvent
     │
     ▼
Check if selection exists
     │
     ├─► Escape + selection → clearSelection()
     │
     ├─► Cmd+A → selectAll()
     │
     ├─► Cmd+C + selection → copySelection() as markdown
     │
     └─► Delete/Backspace + selection (not editing) → deleteSelection()
```

## Testing Strategy

See [TESTING_PATTERNS.md](./TESTING_PATTERNS.md) for detailed testing patterns.

### Quick Summary

1. **Pure logic tests** (no DOM): Test `determineKeyAction()` directly
2. **Component tests**: Use `createMockBlockStore()` and `createMockCursor()`
3. **Integration tests**: Full keyboard flows with real stores

## Pain Points (Areas for Improvement)

1. **Selection logic split**: Multi-select state in Outliner, but selection-aware navigation in BlockItem
2. **Focus management races**: Double `requestAnimationFrame` needed for zoom+create
3. **Navigation helpers hidden**: `findNextVisibleBlock`/`findPrevVisibleBlock` in useBlockOperations
4. **Execute check duplication**: `findHandler()` called in both BlockItem and determineKeyAction

## Extraction Considerations

To make this outliner keyboard handling reusable (shadcn-style "copy the component"):

1. **Generic store interface**: Replace floatty-specific `blockStore` with minimal interface
2. **Callback props for execution**: `onExecute?`, `isExecutable?` instead of importing executor
3. **Configurable class names**: Props for styling customization
4. **Separate outliner keybinds**: Split app-level keys from outliner-specific keys

See Phase 4 of the refactor plan for implementation details.
