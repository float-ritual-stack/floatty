/**
 * blockContext.test.ts - Tests for discrete state builders and predicates
 */
import { describe, it, expect } from 'vitest';
import {
  determineCursorPosition,
  createTestBlockContext,
  canNavigateUp,
  canNavigateDown,
  shouldCreateBefore,
  shouldCreateFirstChild,
  isAtStructurePosition,
  canMergeWithPrevious,
} from './blockContext';

describe('determineCursorPosition', () => {
  it('returns start when offset is 0', () => {
    expect(determineCursorPosition(0, 10)).toBe('start');
    expect(determineCursorPosition(0, 0)).toBe('start');
  });

  it('returns end when offset equals or exceeds content length', () => {
    expect(determineCursorPosition(10, 10)).toBe('end');
    expect(determineCursorPosition(11, 10)).toBe('end');
    expect(determineCursorPosition(0, 0)).toBe('start'); // Empty is at start AND end, prefer start
  });

  it('returns middle for positions between start and end', () => {
    expect(determineCursorPosition(5, 10)).toBe('middle');
    expect(determineCursorPosition(1, 10)).toBe('middle');
    expect(determineCursorPosition(9, 10)).toBe('middle');
  });
});

describe('createTestBlockContext', () => {
  it('creates context with sensible defaults', () => {
    const ctx = createTestBlockContext();
    expect(ctx.blockId).toBe('test-block');
    expect(ctx.cursorAt).toBe('middle');
    expect(ctx.hasChildren).toBe(false);
  });

  it('allows overriding specific fields', () => {
    const ctx = createTestBlockContext({
      cursorAt: 'start',
      hasChildren: true,
      isCollapsed: true,
    });
    expect(ctx.cursorAt).toBe('start');
    expect(ctx.hasChildren).toBe(true);
    expect(ctx.isCollapsed).toBe(true);
    // Non-overridden fields retain defaults
    expect(ctx.blockId).toBe('test-block');
  });
});

describe('canNavigateUp', () => {
  it('returns true when cursor at start', () => {
    const ctx = createTestBlockContext({ cursorAt: 'start' });
    expect(canNavigateUp(ctx, false)).toBe(true);
  });

  it('returns false when cursor in middle without shift', () => {
    const ctx = createTestBlockContext({ cursorAt: 'middle' });
    expect(canNavigateUp(ctx, false)).toBe(false);
  });

  it('returns true when cursor in middle WITH shift (selection extension)', () => {
    const ctx = createTestBlockContext({ cursorAt: 'middle' });
    expect(canNavigateUp(ctx, true)).toBe(true);
  });

  it('returns true when cursor at end WITH shift', () => {
    const ctx = createTestBlockContext({ cursorAt: 'end' });
    expect(canNavigateUp(ctx, true)).toBe(true);
  });
});

describe('canNavigateDown', () => {
  it('returns true when cursor at end', () => {
    const ctx = createTestBlockContext({ cursorAt: 'end' });
    expect(canNavigateDown(ctx, false)).toBe(true);
  });

  it('returns false when cursor in middle without shift', () => {
    const ctx = createTestBlockContext({ cursorAt: 'middle' });
    expect(canNavigateDown(ctx, false)).toBe(false);
  });

  it('returns true when cursor at start WITH shift (selection extension)', () => {
    const ctx = createTestBlockContext({ cursorAt: 'start' });
    expect(canNavigateDown(ctx, true)).toBe(true);
  });
});

describe('shouldCreateBefore', () => {
  it('returns true when cursor at start with content', () => {
    const ctx = createTestBlockContext({
      cursorAt: 'start',
      isEmpty: false,
      content: 'hello',
    });
    expect(shouldCreateBefore(ctx)).toBe(true);
  });

  it('returns false when cursor not at start', () => {
    const ctx = createTestBlockContext({
      cursorAt: 'middle',
      isEmpty: false,
    });
    expect(shouldCreateBefore(ctx)).toBe(false);
  });

  it('returns false when block is empty', () => {
    const ctx = createTestBlockContext({
      cursorAt: 'start',
      isEmpty: true,
      content: '',
    });
    expect(shouldCreateBefore(ctx)).toBe(false);
  });
});

describe('shouldCreateFirstChild', () => {
  it('returns true when at end of expanded parent', () => {
    const ctx = createTestBlockContext({
      cursorAt: 'end',
      hasChildren: true,
      isCollapsed: false,
    });
    expect(shouldCreateFirstChild(ctx)).toBe(true);
  });

  it('returns false when not at end', () => {
    const ctx = createTestBlockContext({
      cursorAt: 'middle',
      hasChildren: true,
      isCollapsed: false,
    });
    expect(shouldCreateFirstChild(ctx)).toBe(false);
  });

  it('returns false when no children', () => {
    const ctx = createTestBlockContext({
      cursorAt: 'end',
      hasChildren: false,
    });
    expect(shouldCreateFirstChild(ctx)).toBe(false);
  });

  it('returns false when collapsed', () => {
    const ctx = createTestBlockContext({
      cursorAt: 'end',
      hasChildren: true,
      isCollapsed: true,
    });
    expect(shouldCreateFirstChild(ctx)).toBe(false);
  });
});

describe('isAtStructurePosition', () => {
  it('returns true when cursor at start', () => {
    const ctx = createTestBlockContext({ cursorAt: 'start' });
    expect(isAtStructurePosition(ctx)).toBe(true);
  });

  it('returns false when cursor not at start', () => {
    expect(isAtStructurePosition(createTestBlockContext({ cursorAt: 'middle' }))).toBe(false);
    expect(isAtStructurePosition(createTestBlockContext({ cursorAt: 'end' }))).toBe(false);
  });
});

describe('canMergeWithPrevious', () => {
  it('returns true at start, no selection, no children, has prev', () => {
    const ctx = createTestBlockContext({
      cursorAt: 'start',
      hasTextSelection: false,
      hasChildren: false,
      hasPrevBlock: true,
    });
    expect(canMergeWithPrevious(ctx)).toBe(true);
  });

  it('returns false when not at start', () => {
    const ctx = createTestBlockContext({
      cursorAt: 'middle',
      hasTextSelection: false,
      hasChildren: false,
      hasPrevBlock: true,
    });
    expect(canMergeWithPrevious(ctx)).toBe(false);
  });

  it('returns false when text is selected', () => {
    const ctx = createTestBlockContext({
      cursorAt: 'start',
      hasTextSelection: true,
      hasChildren: false,
      hasPrevBlock: true,
    });
    expect(canMergeWithPrevious(ctx)).toBe(false);
  });

  it('returns false when block has children', () => {
    const ctx = createTestBlockContext({
      cursorAt: 'start',
      hasTextSelection: false,
      hasChildren: true,
      hasPrevBlock: true,
    });
    expect(canMergeWithPrevious(ctx)).toBe(false);
  });

  it('returns false when no previous block', () => {
    const ctx = createTestBlockContext({
      cursorAt: 'start',
      hasTextSelection: false,
      hasChildren: false,
      hasPrevBlock: false,
    });
    expect(canMergeWithPrevious(ctx)).toBe(false);
  });
});
