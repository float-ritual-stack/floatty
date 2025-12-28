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

      expect(result.type).toBe('navigate_up');
      expect((result as any).prevId).toBe('prev-block');
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

      expect(result.type).toBe('navigate_down');
      expect((result as any).nextId).toBe('next-block');
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

      expect(result.type).toBe('split_block');
      expect((result as any).offset).toBe(5);
    });

    it('splits to first child for expanded parent with children', () => {
      const result = determineKeyAction('Enter', false, null, createDeps({
        cursorOffset: 5,
        block: createBlock({ content: 'test content', childIds: ['child-1'] }),
        isCollapsed: false,
        content: 'test content',
      }));

      expect(result.type).toBe('split_to_child');
      expect((result as any).offset).toBe(5);
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
  });

  describe('Backspace at start', () => {
    it('merges with previous block when Backspace at start', () => {
      const result = determineKeyAction('Backspace', false, null, createDeps({
        cursorOffset: 0,
        selectionCollapsed: true,
        block: createBlock({ childIds: [] }),
      }));

      expect(result.type).toBe('merge_with_previous');
      expect((result as any).prevId).toBe('prev-block');
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

    it('deletes block for deleteBlock action', () => {
      const result = determineKeyAction('Backspace', false, 'deleteBlock', createDeps());

      expect(result.type).toBe('delete_block');
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
});
