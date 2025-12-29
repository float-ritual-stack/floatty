# Testing Patterns for Keyboard Behavior

This document describes how to test floatty's outliner keyboard handling effectively.

## Philosophy

**Store-first testability**: Test pure logic without fighting DOM/contentEditable quirks.

The architecture supports three levels of testing:

| Level | What | Dependencies | Speed |
|-------|------|--------------|-------|
| Unit | `determineKeyAction()` | None | Fast |
| Component | BlockItem, Outliner | Mock stores/cursor | Medium |
| Integration | Full keyboard flows | Real stores, jsdom | Slower |

## Level 1: Pure Logic Tests (Recommended)

Test `determineKeyAction()` directly - no DOM, no stores, just input/output.

### Location
`src/hooks/useBlockInput.test.ts`

### Pattern
```typescript
import { describe, it, expect } from 'vitest';
import { determineKeyAction } from './useBlockInput';

describe('determineKeyAction', () => {
  const baseContext = {
    block: {
      id: 'test',
      content: 'hello world',
      type: 'text',
      parentId: null,
      childIds: [],
      collapsed: false,
    },
    cursorOffset: 5,
    cursorAtStart: false,
    cursorAtEnd: false,
    hasTextSelection: false,
    isZoomed: false,
    isCollapsed: false,
    hasChildren: false,
  };

  it('splits block when Enter pressed in middle', () => {
    const result = determineKeyAction('Enter', false, null, baseContext);

    expect(result).toEqual({
      type: 'split_block',
      offset: 5,
    });
  });

  it('creates sibling before when Enter at start', () => {
    const result = determineKeyAction('Enter', false, null, {
      ...baseContext,
      cursorOffset: 0,
      cursorAtStart: true,
    });

    expect(result).toEqual({
      type: 'create_before',
    });
  });
});
```

### Key Test Cases

**Navigation:**
- `ArrowUp` at start → `navigate_up`
- `ArrowUp` in middle → `null` (let browser handle)
- `ArrowDown` at end → `navigate_down`
- `Shift+ArrowDown` anywhere → `navigate_down_with_selection` (bypasses cursor check)

**Block Creation:**
- `Enter` at start (with content) → `create_before`
- `Enter` at end → `create_after` or `create_first_child` (if expanded parent)
- `Enter` in middle → `split_block`

**Structure:**
- `Tab` at start → `indent`
- `Shift+Tab` at start → `outdent`
- `Tab` in middle → `insert_spaces`

**Execution:**
- `Enter` on `sh::` block → `execute`
- `Enter` on text block → normal behavior

## Level 2: Component Tests

Test components with mock dependencies.

### Mock Factories

```typescript
// From src/context/WorkspaceContext.tsx
import { createMockBlockStore } from '../context/WorkspaceContext';
import { createMockCursor } from '../hooks/useCursor';

const mockStore = createMockBlockStore({
  blocks: {
    'block-1': { id: 'block-1', content: 'Hello', ... },
    'block-2': { id: 'block-2', content: 'World', ... },
  },
  rootIds: ['block-1', 'block-2'],
});

const mockCursor = createMockCursor({
  isAtStart: () => true,
  isAtEnd: () => false,
  getOffset: () => 0,
});
```

### Pattern
```typescript
import { render, fireEvent } from '@solidjs/testing-library';
import { WorkspaceProvider, createMockBlockStore } from '../context/WorkspaceContext';
import { BlockItem } from './BlockItem';

describe('BlockItem', () => {
  it('calls store.indentBlock when Tab at start', async () => {
    const mockIndent = vi.fn();
    const mockStore = createMockBlockStore({
      blocks: { 'test': createBlock({ id: 'test', content: 'Hello' }) },
      rootIds: ['test'],
      indentBlock: mockIndent,
    });

    const { getByRole } = render(() => (
      <WorkspaceProvider blockStore={mockStore}>
        <BlockItem id="test" paneId="pane" depth={0} onFocus={() => {}} />
      </WorkspaceProvider>
    ));

    const block = getByRole('option');
    fireEvent.keyDown(block, { key: 'Tab' });

    expect(mockIndent).toHaveBeenCalledWith('test');
  });
});
```

### Cursor Mocking

The `useCursor` hook accepts a ref callback that can be mocked:

```typescript
// In test setup, inject mock cursor behavior
vi.mock('../hooks/useCursor', () => ({
  useCursor: () => createMockCursor({
    isAtStart: () => true,
    isAtEnd: () => false,
    getOffset: () => 0,
    setOffset: vi.fn(),
    isSelectionCollapsed: () => true,
  }),
}));
```

## Level 3: Integration Tests

Test full keyboard flows with real stores.

### When to Use
- Testing multi-step operations (create block + focus + type)
- Testing store mutations
- Testing cross-component communication

### Pattern
```typescript
describe('keyboard integration', () => {
  it('Enter creates new block and focuses it', async () => {
    const { container } = render(() => (
      <YDocProvider>
        <WorkspaceProvider>
          <Outliner paneId="test" />
        </WorkspaceProvider>
      </YDocProvider>
    ));

    const block = container.querySelector('.block-edit');

    // Type content
    fireEvent.input(block, { target: { innerText: 'Hello' } });

    // Press Enter at end
    fireEvent.keyDown(block, { key: 'Enter' });

    // Wait for new block to mount and focus
    await waitFor(() => {
      const blocks = container.querySelectorAll('.block-edit');
      expect(blocks).toHaveLength(2);
      expect(document.activeElement).toBe(blocks[1]);
    });
  });
});
```

## Testing Multi-Select (FLO-74)

Multi-select introduced new keyboard behaviors that need testing:

### Unit Tests (determineKeyAction)
```typescript
describe('selection extension', () => {
  it('Shift+ArrowDown navigates regardless of cursor position', () => {
    const result = determineKeyAction('ArrowDown', true, null, {
      ...baseContext,
      cursorAtEnd: false,  // NOT at end - would block plain ArrowDown
    });

    expect(result.type).toBe('navigate_down_with_selection');
  });

  it('Shift+ArrowUp navigates regardless of cursor position', () => {
    const result = determineKeyAction('ArrowUp', true, null, {
      ...baseContext,
      cursorAtStart: false,  // NOT at start - would block plain ArrowUp
    });

    expect(result.type).toBe('navigate_up_with_selection');
  });
});
```

### Component Tests (Outliner)
```typescript
describe('Outliner keyboard handler', () => {
  it('Escape clears selection', () => {
    // Render with pre-selected blocks
    // Fire Escape
    // Assert selection cleared
  });

  it('Cmd+A selects all visible blocks', () => {
    // Render with blocks
    // Fire Cmd+A
    // Assert all visible blocks selected
  });

  it('Delete on selection bulk deletes', () => {
    // Render with selected blocks
    // Fire Delete (not in contentEditable)
    // Assert blocks deleted
  });
});
```

## Common Pitfalls

### 1. Cursor Position vs DOM State
The cursor abstraction (`useCursor`) hides DOM complexity. In tests, mock the abstraction, don't manipulate DOM selection.

```typescript
// ❌ Wrong - fighting the DOM
const range = document.createRange();
range.setStart(block.firstChild, 0);
window.getSelection()?.removeAllRanges();
window.getSelection()?.addRange(range);

// ✅ Right - mock the abstraction
const mockCursor = createMockCursor({ isAtStart: () => true });
```

### 2. Async Focus Changes
Focus changes often require `requestAnimationFrame`. Use `waitFor` in integration tests.

```typescript
await waitFor(() => {
  expect(document.activeElement).toBe(expectedBlock);
});
```

### 3. Event Propagation
Some events (`Tab`) need `preventDefault()` testing:

```typescript
const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true });
const preventDefaultSpy = vi.spyOn(event, 'preventDefault');

fireEvent(block, event);

expect(preventDefaultSpy).toHaveBeenCalled();
```

### 4. Platform Detection
Keybinds use `$mod` (Cmd on macOS, Ctrl elsewhere). Mock `navigator.platform` in tests:

```typescript
vi.stubGlobal('navigator', { platform: 'MacIntel' });
```

## Test File Locations

| File | Tests |
|------|-------|
| `src/hooks/useBlockInput.test.ts` | Pure logic, determineKeyAction |
| `src/components/BlockItem.test.tsx` | Block keyboard handling |
| `src/components/Outliner.test.tsx` | Document-level selection |
| `src/lib/keybinds.test.ts` | Key mapping |
| `src/lib/markdownExport.test.ts` | Selection export |

## Running Tests

```bash
npm run test          # Run all tests
npm run test:watch    # Watch mode for TDD
npm test -- --grep "determineKeyAction"  # Filter by pattern
```
