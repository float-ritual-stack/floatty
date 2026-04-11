# Keyboard Reference

This document describes floatty's outliner keyboard handling architecture.

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

### Cursor Position (Discrete)
```typescript
type CursorAt = 'start' | 'middle' | 'end';
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

### Selection State
```typescript
interface SelectionState {
  selectedBlockIds: Set<string>;
  selectionAnchor: string | null;  // Range selection start point
}
```

**Affects:**
- `Shift+Arrow` → extend range selection
- `Cmd+A` → progressive selection (see below)
- `Cmd+C` → copy selected blocks as markdown
- `Delete/Backspace` on selection → bulk delete
- `Escape` → clear selection

### Block Type
```typescript
type BlockType = 'text' | 'h1' | 'h2' | 'h3' | 'bullet' | 'todo' | 'quote' | 'sh' | 'ai' | ...;
```

**Affects:**
- `Enter` on `sh::`/`ai::` block → execute command (not split)

---

## Key Bindings

### Block-Level (BlockItem.tsx)

| Key | At Start | At Middle | At End |
|-----|----------|-----------|--------|
| `ArrowUp` | Exit to prev block | Move within block | Move within block |
| `ArrowDown` | Move within block | Move within block | Exit to next block |
| `Enter` | Create sibling before | Split block | Create sibling/child after |
| `Tab` | Indent block | Insert 2 spaces | Insert 2 spaces |
| `Shift+Tab` | Outdent block | Outdent block | Outdent block |
| `Backspace` | Merge with prev (if no children) | Delete char | Delete char |

### Document-Level (Outliner.tsx)

| Key | Action |
|-----|--------|
| `Cmd+.` | Toggle collapse focused block |
| `Cmd+Enter` | Zoom into subtree |
| `Cmd+[` | Go back in navigation history (restores zoom AND focus) |
| `Cmd+]` | Go forward in navigation history |
| `Escape` | Zoom out / clear selection |
| `Cmd+A` | Progressive select (expand on repeat) |
| `Cmd+E` | Progressive expand (depth +1 on repeat) |
| `Cmd+Shift+E` | Progressive collapse |
| `Cmd+C` | Copy selection as markdown |
| `Cmd+Shift+M` | Export outline to clipboard |
| `Cmd+Backspace` | Delete block + subtree |

### Progressive Cmd+A Sequence

| Presses | Scope |
|---------|-------|
| 1 | Focused block only |
| 2 | Siblings + all descendants |
| 3 | Parent scope + all descendants |
| 4+ | Continue climbing tree |
| 10 | Select all |

### Progressive Expand/Collapse (Cmd+E)

| Sequence | Action |
|----------|--------|
| `Cmd+E` | Expand to depth 1 |
| `Cmd+E, E` | Expand to depth 2 |
| `Cmd+E, E, E` | Expand to depth 3 |
| `Cmd+E, E, E, E` | Expand all |
| `Cmd+Shift+E` | Collapse at depth 1 |
| `Cmd+Shift+E, E, E, E` | Collapse all |

---

## Cursor Detection

Use `cursor.isAtStart()` not `cursor.getOffset() === 0`.

The `isAtStart()` method uses `isCursorAtContentStart()` which properly handles:
- Empty text nodes
- Leading `<br>` elements
- Other contentEditable edge cases

```typescript
function isCursorAtContentStart(element: HTMLElement): boolean {
  const selection = window.getSelection();
  if (!selection || !selection.isCollapsed) return false;
  if (selection.anchorOffset !== 0) return false;

  // Handle empty blocks, BR nodes, etc.
  const firstChild = element.firstChild;
  if (!firstChild) return true;
  if (firstChild.nodeName === 'BR') return true;

  return selection.anchorNode === firstChild ||
         selection.anchorNode === element;
}
```

---

## Testing Strategy

See [TESTING_PATTERNS.md](./TESTING_PATTERNS.md) for detailed patterns.

### Quick Summary

1. **Pure logic tests** (no DOM): Test `determineKeyAction()` directly
2. **Component tests**: Use `createMockBlockStore()` and `createMockCursor()`
3. **Integration tests**: Full keyboard flows with real stores

---

## Related

- [TESTING_PATTERNS.md](./TESTING_PATTERNS.md) - Test patterns
- CLAUDE.md `.claude/rules/solidjs-patterns.md` - SolidJS gotchas
