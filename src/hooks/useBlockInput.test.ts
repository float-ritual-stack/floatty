/**
 * useBlockInput.test.ts - Phase 3 Verification
 *
 * Tests the PURE LOGIC of keyboard handling without DOM.
 * This is the payoff of the entire refactor - we can test complex
 * keyboard interactions by calling determineKeyAction directly.
 */
import { describe, it, expect } from 'vitest';
import { determineKeyAction, type KeyboardAction } from './useBlockInput';
import type { Block } from '../lib/blockTypes';

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

      it('Shift+ArrowUp NOT at start returns none (browser handles text selection)', () => {
        // FLO-145: Browser should handle mid-block text selection
        const result = determineKeyAction('ArrowUp', true, null, createDeps({
          cursorAtStart: false,  // NOT at start
          cursorOffset: 5,
        }));

        expect(result.type).toBe('none');
      });

      it('Shift+ArrowDown NOT at end returns none (browser handles text selection)', () => {
        // FLO-145: Browser should handle mid-block text selection
        const result = determineKeyAction('ArrowDown', true, null, createDeps({
          cursorAtEnd: false,    // NOT at end
          cursorOffset: 5,
        }));

        expect(result.type).toBe('none');
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

    it('does nothing when Backspace at start but block has children', () => {
      const result = determineKeyAction('Backspace', false, null, createDeps({
        cursorOffset: 0,
        selectionCollapsed: true,
        block: createBlock({ childIds: ['child-1'] }),
      }));

      expect(result.type).toBe('none');
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

  // FLO-145: Text selection should NOT bleed across block boundaries
  describe('text selection boundary bugs (FLO-145)', () => {
    it('Shift+ArrowDown should NOT navigate when cursor is NOT at block end', () => {
      // User is mid-block, using Shift+Down to extend text selection
      // Should allow browser to handle text selection, NOT navigate to next block
      const result = determineKeyAction('ArrowDown', true, null, createDeps({
        cursorAtEnd: false,    // NOT at end - extending text selection within block
        cursorAtStart: false,
        cursorOffset: 5,       // mid-block
      }));

      // Should return 'none' to let browser handle text selection
      expect(result.type).toBe('none');
    });

    it('Shift+ArrowUp should NOT navigate when cursor is NOT at block start', () => {
      // User is mid-block, using Shift+Up to extend text selection
      // Should allow browser to handle text selection, NOT navigate to prev block
      const result = determineKeyAction('ArrowUp', true, null, createDeps({
        cursorAtStart: false,  // NOT at start - extending text selection within block
        cursorAtEnd: false,
        cursorOffset: 5,       // mid-block
      }));

      // Should return 'none' to let browser handle text selection
      expect(result.type).toBe('none');
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
});
