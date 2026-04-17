/**
 * useBlockInput.test.ts - Phase 3 Verification
 *
 * Tests the PURE LOGIC of keyboard handling without DOM.
 * This is the payoff of the entire refactor - we can test complex
 * keyboard interactions by calling determineKeyAction directly.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { determineKeyAction, useBlockInput, type KeyboardAction, type BlockInputDependencies } from './useBlockInput';
import { registerHandlers } from '../lib/handlers';
import type { Block } from '../lib/blockTypes';
import { createMockBlockStore, createMockPaneStore } from '../context/WorkspaceContext';
import type { CursorState } from './useCursor';

// Type-safe assertion helper for discriminated unions
function expectAction<T extends KeyboardAction['type']>(
  result: KeyboardAction,
  type: T
): Extract<KeyboardAction, { type: T }> {
  expect(result.type).toBe(type);
  return result as Extract<KeyboardAction, { type: T }>;
}

// Helper: create minimal block for tests
function createBlock(overrides: Partial<Block> = {}): Block {
  return {
    id: 'test-block',
    content: 'test content',
    type: 'text',
    parentId: null,
    childIds: [],
    collapsed: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

// Helper: create deps object with defaults
function createDeps(overrides: Partial<{
  block: Block | undefined;
  isCollapsed: boolean;
  cursorAtStart: boolean;
  cursorAtEnd: boolean;
  cursorOffset: number;
  selectionCollapsed: boolean;
  zoomedRootId: string | null;
  content: string;
  findPrevId: () => string | null;
  findNextId: () => string | null;
  findFocusAfterDelete: () => string | null;
}> = {}) {
  return {
    block: createBlock(),
    isCollapsed: false,
    cursorAtStart: false,
    cursorAtEnd: false,
    cursorOffset: 5,
    selectionCollapsed: true,
    zoomedRootId: null,
    findPrevId: () => 'prev-block',
    findNextId: () => 'next-block',
    findFocusAfterDelete: () => 'focus-after-delete',
    content: 'test content',
    ...overrides,
  };
}

describe('determineKeyAction', () => {
  // Register handlers so registry.findHandler works for sh::, render::, etc.
  beforeAll(() => registerHandlers());

  describe('navigation', () => {
    it('navigates up when ArrowUp at cursor start', () => {
      const result = determineKeyAction('ArrowUp', false, null, createDeps({
        cursorAtStart: true,
      }));

      const action = expectAction(result, 'navigate_up');
      expect(action.prevId).toBe('prev-block');
    });

    it('does nothing for ArrowUp when cursor not at start', () => {
      const result = determineKeyAction('ArrowUp', false, null, createDeps({
        cursorAtStart: false,
      }));

      expect(result.type).toBe('none');
    });

    it('does nothing for ArrowUp when blank lines before cursor but not at content start', () => {
      // Content: "\n\na" with cursor at 'a' (offset 2)
      // isCursorAtContentStart correctly returns false — cursor is not at root-level start
      // Browser handles navigation through blank lines within the block
      const result = determineKeyAction('ArrowUp', false, null, createDeps({
        cursorAtStart: false,  // Structural check: not at content start
        cursorOffset: 2,       // After the two newlines
        content: '\n\na',      // Blank lines then content
      }));

      expect(result.type).toBe('none');
    });

    it('navigates up when cursor is at the FIRST blank line (structural start)', () => {
      // Cursor is at (div[0], 0) — the first blank line, which IS content start
      // isCursorAtContentStart returns true (no previous sibling of root child)
      const result = determineKeyAction('ArrowUp', false, null, createDeps({
        cursorAtStart: true,   // Structural check: at content start
        cursorOffset: 0,
        content: '\n\na',
      }));

      const action = expectAction(result, 'navigate_up');
      expect(action.prevId).toBe('prev-block');
    });

    it('navigates down when ArrowDown at cursor end', () => {
      const result = determineKeyAction('ArrowDown', false, null, createDeps({
        cursorAtEnd: true,
      }));

      const action = expectAction(result, 'navigate_down');
      expect(action.nextId).toBe('next-block');
    });

    // FLO-74 + FLO-145: Shift+Arrow selection extension (only at boundaries)
    describe('selection extension (FLO-74, FLO-145)', () => {
      it('Shift+ArrowUp at start navigates with selection action', () => {
        // FLO-145: Only navigate when at boundary
        const result = determineKeyAction('ArrowUp', true, null, createDeps({
          cursorAtStart: true,  // AT start - ok to navigate
        }));

        const action = expectAction(result, 'navigate_up_with_selection');
        expect(action.prevId).toBe('prev-block');
      });

      it('Shift+ArrowDown at end navigates with selection action', () => {
        // FLO-145: Only navigate when at boundary
        const result = determineKeyAction('ArrowDown', true, null, createDeps({
          cursorAtEnd: true,    // AT end - ok to navigate
        }));

        const action = expectAction(result, 'navigate_down_with_selection');
        expect(action.nextId).toBe('next-block');
      });

      it('Shift+ArrowUp mid-block still triggers block selection', () => {
        // Block selection always wins over text selection for Shift+Arrow
        const result = determineKeyAction('ArrowUp', true, null, createDeps({
          cursorAtStart: false,
          cursorOffset: 5,
        }));

        const action = expectAction(result, 'navigate_up_with_selection');
        expect(action.prevId).toBe('prev-block');
      });

      it('Shift+ArrowDown mid-block still triggers block selection', () => {
        // Block selection always wins over text selection for Shift+Arrow
        const result = determineKeyAction('ArrowDown', true, null, createDeps({
          cursorAtEnd: false,
          cursorOffset: 5,
        }));

        const action = expectAction(result, 'navigate_down_with_selection');
        expect(action.nextId).toBe('next-block');
      });

      it('Shift+ArrowDown at end with no next block returns none (FLO-92 trailing block is plain nav only)', () => {
        const result = determineKeyAction('ArrowDown', true, null, createDeps({
          cursorAtEnd: true,
          findNextId: () => null,  // No next block
        }));

        // Should return none, not create_trailing_block
        expect(result.type).toBe('none');
      });
    });

    it('creates trailing block when ArrowDown at end with no next block (FLO-92)', () => {
      const result = determineKeyAction('ArrowDown', false, null, createDeps({
        cursorAtEnd: true,
        findNextId: () => null, // No next block exists
      }));

      expect(result.type).toBe('create_trailing_block');
    });

    it('creates trailing block with correct parent context (FLO-92)', () => {
      const result = determineKeyAction('ArrowDown', false, null, createDeps({
        cursorAtEnd: true,
        findNextId: () => null,
        block: createBlock({ parentId: 'parent-123' }),
      }));

      const action = expectAction(result, 'create_trailing_block');
      expect(action.parentId).toBe('parent-123');
    });

    it('creates root-level trailing block when current block is root (FLO-92)', () => {
      const result = determineKeyAction('ArrowDown', false, null, createDeps({
        cursorAtEnd: true,
        findNextId: () => null,
        block: createBlock({ parentId: null }),
      }));

      const action = expectAction(result, 'create_trailing_block');
      expect(action.parentId).toBeNull();
    });

    it('creates trailing block INSIDE zoomed root when zoomed (FLO-92)', () => {
      // When zoomed into 'zoomed-root', ArrowDown at last visible child should
      // create a new block inside the zoomed root, NOT at tree level
      const result = determineKeyAction('ArrowDown', false, null, createDeps({
        cursorAtEnd: true,
        findNextId: () => null, // At last visible block in zoomed subtree
        zoomedRootId: 'zoomed-root',
        block: createBlock({ id: 'last-child', parentId: 'zoomed-root' }),
      }));

      const action = expectAction(result, 'create_trailing_block');
      // Should create inside zoomed root, not at block's parent level
      expect(action.parentId).toBe('zoomed-root');
    });

    it('creates trailing block inside zoomed root even for nested children (FLO-92)', () => {
      // Block is nested deeper than zoomed root - should still target zoomed root
      const result = determineKeyAction('ArrowDown', false, null, createDeps({
        cursorAtEnd: true,
        findNextId: () => null,
        zoomedRootId: 'zoomed-root',
        block: createBlock({ id: 'deep-child', parentId: 'middle-parent' }), // Not direct child
      }));

      const action = expectAction(result, 'create_trailing_block');
      // Should create inside zoomed root, not at block's immediate parent
      expect(action.parentId).toBe('zoomed-root');
    });

    // Blank line navigation tests (structural boundary detection)
    describe('blank line boundary detection', () => {
      it('does NOT navigate down when blank lines exist BELOW cursor in block', () => {
        // Cursor at "test" (offset 4) in "test\n\n\n" (length 7)
        // isCursorAtContentEnd returns false (blank line divs are siblings AFTER text)
        const result = determineKeyAction('ArrowDown', false, null, createDeps({
          cursorAtEnd: false,  // Structural check: not at content end
          cursorOffset: 4,
          content: 'test\n\n\n',
        }));
        expect(result.type).toBe('none');
      });

      it('navigates out from LAST blank line in block', () => {
        // Cursor at last blank line — no next sibling of root child
        // isCursorAtContentEnd returns true
        const result = determineKeyAction('ArrowDown', false, null, createDeps({
          cursorAtEnd: true,  // Structural check: at content end
          cursorOffset: 7,
          content: 'test\n\n\n',
        }));
        expectAction(result, 'navigate_down');
      });

      it('navigates out from end of content (no trailing newlines)', () => {
        const result = determineKeyAction('ArrowDown', false, null, createDeps({
          cursorAtEnd: true,
          cursorOffset: 12,
          content: 'test content',
        }));
        expectAction(result, 'navigate_down');
      });

      it('does NOT navigate up when blank lines exist ABOVE cursor in block', () => {
        // Cursor at "test" in "\n\n\ntest"
        // isCursorAtContentStart returns false (blank line divs before cursor)
        const result = determineKeyAction('ArrowUp', false, null, createDeps({
          cursorAtStart: false,
          cursorOffset: 3,
          content: '\n\n\ntest',
        }));
        expect(result.type).toBe('none');
      });

      it('navigates out from FIRST blank line in block', () => {
        // Cursor at first blank line — no previous sibling
        const result = determineKeyAction('ArrowUp', false, null, createDeps({
          cursorAtStart: true,  // Structural check: at content start
          cursorOffset: 0,
          content: '\n\n\ntest',
        }));
        expectAction(result, 'navigate_up');
      });
    });
  });

  describe('Enter key behavior', () => {
    it('creates block before when Enter at start of non-empty block', () => {
      const result = determineKeyAction('Enter', false, null, createDeps({
        cursorOffset: 0,
        cursorAtStart: true,
        block: createBlock({ content: 'some content' }),
        content: 'some content',
      }));

      expect(result.type).toBe('create_block_before');
    });

    it('creates first child when Enter at end of expanded parent', () => {
      const result = determineKeyAction('Enter', false, null, createDeps({
        cursorOffset: 12, // end of 'test content'
        cursorAtEnd: true,
        block: createBlock({ childIds: ['child-1'], content: 'test content' }),
        isCollapsed: false,
        content: 'test content',
      }));

      expect(result.type).toBe('create_block_inside');
    });

    it('splits block when Enter in middle', () => {
      const result = determineKeyAction('Enter', false, null, createDeps({
        cursorOffset: 5,
        block: createBlock({ content: 'test content' }),
        content: 'test content',
      }));

      const action = expectAction(result, 'split_block');
      expect(action.offset).toBe(5);
    });

    it('splits to first child for expanded parent with children', () => {
      const result = determineKeyAction('Enter', false, null, createDeps({
        cursorOffset: 5,
        block: createBlock({ content: 'test content', childIds: ['child-1'] }),
        isCollapsed: false,
        content: 'test content',
      }));

      const action = expectAction(result, 'split_to_child');
      expect(action.offset).toBe(5);
    });

    it('splits normally for collapsed parent', () => {
      const result = determineKeyAction('Enter', false, null, createDeps({
        cursorOffset: 5,
        block: createBlock({ content: 'test content', childIds: ['child-1'] }),
        isCollapsed: true,
        content: 'test content',
      }));

      expect(result.type).toBe('split_block');
    });

    // FLO-571: Shift+Enter on executable blocks at cursor start
    it('Shift+Enter at start of executable block creates block before', () => {
      const result = determineKeyAction('Enter', true, null, createDeps({
        cursorOffset: 0,
        cursorAtStart: true,
        block: createBlock({ content: 'sh:: echo hello' }),
        content: 'sh:: echo hello',
      }));

      expect(result.type).toBe('create_block_before');
    });

    it('Shift+Enter at non-zero offset on executable block returns none (browser default)', () => {
      const result = determineKeyAction('Enter', true, null, createDeps({
        cursorOffset: 5,
        block: createBlock({ content: 'sh:: echo hello' }),
        content: 'sh:: echo hello',
      }));

      expect(result.type).toBe('none');
    });

    it('Shift+Enter at start of non-executable block returns none (browser default)', () => {
      const result = determineKeyAction('Enter', true, null, createDeps({
        cursorOffset: 0,
        cursorAtStart: true,
        block: createBlock({ content: 'just regular text' }),
        content: 'just regular text',
      }));

      expect(result.type).toBe('none');
    });

    it('Shift+Enter at offset 0 with cursorAtStart false still creates block before', () => {
      // Logic uses cursorOffset === 0, not cursorAtStart — guard against regression
      const result = determineKeyAction('Enter', true, null, createDeps({
        cursorOffset: 0,
        cursorAtStart: false,
        block: createBlock({ content: 'sh:: echo hello' }),
        content: 'sh:: echo hello',
      }));

      expect(result.type).toBe('create_block_before');
    });
  });

  describe('Tab key behavior', () => {
    it('indents when Tab at cursor start', () => {
      const result = determineKeyAction('Tab', false, null, createDeps({
        cursorAtStart: true,
      }));

      expect(result.type).toBe('indent');
    });

    it('outdents when Shift+Tab at cursor start', () => {
      const result = determineKeyAction('Tab', true, null, createDeps({
        cursorAtStart: true,
      }));

      expect(result.type).toBe('outdent');
    });

    it('inserts spaces when Tab not at cursor start', () => {
      const result = determineKeyAction('Tab', false, null, createDeps({
        cursorAtStart: false,
      }));

      expect(result.type).toBe('insert_spaces');
    });

    it('removes spaces when Shift+Tab not at cursor start', () => {
      const result = determineKeyAction('Tab', true, null, createDeps({
        cursorAtStart: false,
      }));

      expect(result.type).toBe('remove_spaces');
    });
  });

  describe('Backspace at start', () => {
    it('merges with previous block when Backspace at start', () => {
      const result = determineKeyAction('Backspace', false, null, createDeps({
        cursorOffset: 0,
        selectionCollapsed: true,
        block: createBlock({ childIds: [] }),
      }));

      const action = expectAction(result, 'merge_with_previous');
      expect(action.prevId).toBe('prev-block');
    });

    it('does nothing when Backspace at start but block has COLLAPSED children (hidden)', () => {
      // When children are collapsed (hidden), protect from accidental merge
      const result = determineKeyAction('Backspace', false, null, createDeps({
        cursorOffset: 0,
        selectionCollapsed: true,
        isCollapsed: true,  // Children are hidden
        block: createBlock({ childIds: ['child-1'] }),
      }));

      expect(result.type).toBe('none');
    });

    it('allows merge when Backspace at start with EXPANDED children (visible)', () => {
      // When children are visible, user knows they exist - allow merge (lift children)
      const result = determineKeyAction('Backspace', false, null, createDeps({
        cursorOffset: 0,
        selectionCollapsed: true,
        isCollapsed: false,  // Children are visible
        block: createBlock({ childIds: ['child-1'] }),
      }));

      const action = expectAction(result, 'merge_with_previous');
      expect(action.prevId).toBe('prev-block');
    });

    it('does nothing when Backspace with text selected', () => {
      const result = determineKeyAction('Backspace', false, null, createDeps({
        cursorOffset: 0,
        selectionCollapsed: false, // Text is selected
      }));

      expect(result.type).toBe('none');
    });
  });

  describe('keybind actions', () => {
    it('zooms out when zoomOutBlock action and zoomed', () => {
      const result = determineKeyAction('Escape', false, 'zoomOutBlock', createDeps({
        zoomedRootId: 'some-block',
      }));

      expect(result.type).toBe('zoom_out');
    });

    it('does nothing for zoomOutBlock when not zoomed', () => {
      const result = determineKeyAction('Escape', false, 'zoomOutBlock', createDeps({
        zoomedRootId: null,
      }));

      expect(result.type).toBe('none');
    });

    it('zooms in for zoomInBlock action', () => {
      const result = determineKeyAction('Enter', false, 'zoomInBlock', createDeps());

      expect(result.type).toBe('zoom_in');
    });

    it('toggles collapse when collapseBlock action on parent', () => {
      const result = determineKeyAction('.', false, 'collapseBlock', createDeps({
        block: createBlock({ childIds: ['child-1'] }),
      }));

      expect(result.type).toBe('toggle_collapse');
    });

    it('deletes block for deleteBlock action using findFocusAfterDelete', () => {
      const result = determineKeyAction('Backspace', false, 'deleteBlock', createDeps());

      const action = expectAction(result, 'delete_block');
      // Should use findFocusAfterDelete (zoom-aware), not findPrevId
      expect(action.prevId).toBe('focus-after-delete');
    });
  });

  describe('edge cases', () => {
    it('returns none for undefined block', () => {
      const result = determineKeyAction('Enter', false, null, {
        ...createDeps(),
        block: undefined,
      });

      expect(result.type).toBe('none');
    });

    it('returns none for unhandled keys', () => {
      const result = determineKeyAction('a', false, null, createDeps());

      expect(result.type).toBe('none');
    });
  });

  // Shift+Arrow always triggers block selection (outliner semantics)
  describe('Shift+Arrow block selection (always active)', () => {
    it('Shift+ArrowDown mid-block triggers block selection', () => {
      const result = determineKeyAction('ArrowDown', true, null, createDeps({
        cursorAtEnd: false,
        cursorAtStart: false,
        cursorOffset: 5,
      }));

      const action = expectAction(result, 'navigate_down_with_selection');
      expect(action.nextId).toBe('next-block');
    });

    it('Shift+ArrowUp mid-block triggers block selection', () => {
      const result = determineKeyAction('ArrowUp', true, null, createDeps({
        cursorAtStart: false,
        cursorAtEnd: false,
        cursorOffset: 5,
      }));

      const action = expectAction(result, 'navigate_up_with_selection');
      expect(action.prevId).toBe('prev-block');
    });

    it('Shift+ArrowDown at block end SHOULD navigate with selection', () => {
      // User is at block end - Shift+Down should extend selection to next block
      const result = determineKeyAction('ArrowDown', true, null, createDeps({
        cursorAtEnd: true,     // AT end - ok to navigate
      }));

      const action = expectAction(result, 'navigate_down_with_selection');
      expect(action.nextId).toBe('next-block');
    });

    it('Shift+ArrowUp at block start SHOULD navigate with selection', () => {
      // User is at block start - Shift+Up should extend selection to prev block
      const result = determineKeyAction('ArrowUp', true, null, createDeps({
        cursorAtStart: true,   // AT start - ok to navigate
      }));

      const action = expectAction(result, 'navigate_up_with_selection');
      expect(action.prevId).toBe('prev-block');
    });

    it('Backspace with text selected should return none (let browser handle)', () => {
      // User has text selected (not at position 0, but selection exists)
      // Backspace should delete selected text, not trigger block merge
      const result = determineKeyAction('Backspace', false, null, createDeps({
        cursorOffset: 5,           // cursor at position 5
        selectionCollapsed: false, // but text IS selected
      }));

      // Should return none - browser will delete selected text
      expect(result.type).toBe('none');
    });
  });

  // FLO-646: Enter on freshly-typed executable block must dispatch to handler.
  // Pure-logic regression guard that determineKeyAction still returns
  // execute_block when the caller passes fresh content starting with a
  // registered prefix. The integration-level fix (flush + re-read before
  // this runs) is covered below in the useBlockInput handleKeyDown suite.
  describe('Enter on executable block (FLO-646 pure-logic guard)', () => {
    it('returns execute_block for sh:: content (handler match short-circuits)', () => {
      const result = determineKeyAction('Enter', false, null, createDeps({
        cursorOffset: 12,
        block: createBlock({ content: 'sh:: echo hi' }),
        content: 'sh:: echo hi',
      }));
      // Handler match wins over all fallthrough branches — this is the
      // behavior the FLO-646 flush exists to ensure the caller can reach.
      expect(result.type).toBe('execute_block');
    });

    it('returns execute_block even at cursor start (handler check runs first)', () => {
      const result = determineKeyAction('Enter', false, null, createDeps({
        cursorOffset: 0,
        cursorAtStart: true,
        block: createBlock({ content: 'sh:: echo hi' }),
        content: 'sh:: echo hi',
      }));
      expect(result.type).toBe('execute_block');
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// handleKeyDown integration — FLO-646 flush-before-decide
// ═══════════════════════════════════════════════════════════════
// The pure determineKeyAction suite above verifies what SHOULD happen when
// content is fresh. This suite verifies that handleKeyDown actually produces
// fresh content before calling determineKeyAction, by flushing pending DOM
// edits and re-reading the block from the store. See useContentSync.ts
// module header for the FLO-387 commit-boundary model this works with.

function createCursorMock(): CursorState {
  return {
    isAtStart: () => false,
    isAtEnd: () => false,
    getOffset: () => 0,
    setOffset: () => {},
    isSelectionCollapsed: () => true,
    snapshot: () => ({ offset: 12, atStart: false, atEnd: true, contentLength: 12 }),
    invalidate: () => {},
  };
}

function createMinimalDeps(
  getBlock: () => Block | undefined,
  flushContentUpdate: () => void,
): BlockInputDependencies {
  return {
    getBlockId: () => 'test-block',
    paneId: 'test-pane',
    getBlock,
    isCollapsed: () => false,
    blockStore: createMockBlockStore(),
    paneStore: createMockPaneStore(),
    cursor: createCursorMock(),
    findNextVisibleBlock: () => null,
    findPrevVisibleBlock: () => null,
    findFocusAfterDelete: () => null,
    onFocus: () => {},
    flushContentUpdate,
    getContentRef: () => undefined,
  };
}

describe('useBlockInput.handleKeyDown — FLO-646 flush-before-decide', () => {
  beforeAll(() => registerHandlers());

  it('flushes pending content and re-reads block before deciding on Enter', () => {
    // Simulate the FLO-646 scenario: user typed "sh:: echo hi" into the DOM
    // but FLO-387's blur-is-the-boundary model hasn't committed it to the
    // store yet. First getBlock() sees empty content; flush commits the
    // DOM → store; next getBlock() sees the executable prefix.
    let storeContent = '';
    const callLog: string[] = [];

    const getBlock = vi.fn((): Block => {
      callLog.push(`getBlock:${storeContent}`);
      return {
        id: 'test-block',
        content: storeContent,
        type: 'text',
        parentId: null,
        childIds: [],
        collapsed: false,
        createdAt: 0,
        updatedAt: 0,
      };
    });
    const flushContentUpdate = vi.fn(() => {
      callLog.push('flush');
      storeContent = 'sh:: echo hi';
    });

    const { handleKeyDown } = useBlockInput(
      createMinimalDeps(getBlock, flushContentUpdate),
    );

    handleKeyDown(new KeyboardEvent('keydown', { key: 'Enter' }));

    // Flush must run BEFORE the second getBlock that feeds determineKeyAction.
    // (The execute_block case runs a second defense-in-depth flush downstream;
    // we only care that the first flush happens before the decision.)
    expect(callLog[0]).toBe('getBlock:');        // initial snapshot — stale/empty
    expect(callLog[1]).toBe('flush');             // FLO-646 flush
    expect(callLog[2]).toBe('getBlock:sh:: echo hi'); // re-read — fresh
    expect(flushContentUpdate.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('flushes on Shift+Enter too (executable-block create_block_before path)', () => {
    // Shift+Enter on an executable block at cursor start creates a block
    // before (FLO-571). That decision also calls registry.findHandler(content),
    // so it has the same stale-read problem and needs the same flush.
    const getBlock = vi.fn((): Block => ({
      id: 'test-block',
      content: 'sh::',
      type: 'text',
      parentId: null,
      childIds: [],
      collapsed: false,
      createdAt: 0,
      updatedAt: 0,
    }));
    const flushContentUpdate = vi.fn();

    const { handleKeyDown } = useBlockInput(
      createMinimalDeps(getBlock, flushContentUpdate),
    );

    handleKeyDown(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true }));

    expect(flushContentUpdate).toHaveBeenCalledTimes(1);
  });

  it('does NOT flush on non-Enter keys (preserves FLO-387 perf)', () => {
    // The whole point of FLO-387 is no per-keystroke Y.Doc writes. The fix
    // must only flush for Enter, not for every key that passes through
    // handleKeyDown.
    const getBlock = vi.fn((): Block => ({
      id: 'test-block',
      content: 'some text',
      type: 'text',
      parentId: null,
      childIds: [],
      collapsed: false,
      createdAt: 0,
      updatedAt: 0,
    }));
    const flushContentUpdate = vi.fn();

    const { handleKeyDown } = useBlockInput(
      createMinimalDeps(getBlock, flushContentUpdate),
    );

    // A key that takes the 'none' path (Backspace without selection at
    // non-zero offset on a block with no prev sibling) — handleKeyDown runs
    // but no boundary was crossed.
    handleKeyDown(new KeyboardEvent('keydown', { key: 'ArrowRight' }));

    expect(flushContentUpdate).not.toHaveBeenCalled();
  });
});
