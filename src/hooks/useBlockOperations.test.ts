import { describe, it, expect } from 'vitest';
import { determineFocusAfterDelete } from './useBlockOperations';

describe('determineFocusAfterDelete', () => {
  it('prioritizes previous sibling over parent', () => {
    const target = determineFocusAfterDelete({
      blockId: 'b',
      parentId: 'parent',
      siblings: ['a', 'b', 'c'],
      zoomedRootId: null,
    });

    expect(target).toBe('a');
  });

  it('falls back to next sibling when no previous sibling exists', () => {
    const target = determineFocusAfterDelete({
      blockId: 'a',
      parentId: 'parent',
      siblings: ['a', 'b', 'c'],
      zoomedRootId: null,
    });

    expect(target).toBe('b');
  });

  it('falls back to parent when no siblings remain', () => {
    const target = determineFocusAfterDelete({
      blockId: 'only-child',
      parentId: 'parent',
      siblings: ['only-child'],
      zoomedRootId: null,
    });

    expect(target).toBe('parent');
  });

  it('uses zoomed root fallback when deleting a lone root in zoomed mode', () => {
    const target = determineFocusAfterDelete({
      blockId: 'child',
      parentId: null,
      siblings: ['child'],
      zoomedRootId: 'zoom-root',
    });

    expect(target).toBe('zoom-root');
  });

  it('returns null when there is no valid focus target', () => {
    const target = determineFocusAfterDelete({
      blockId: 'only-root',
      parentId: null,
      siblings: ['only-root'],
      zoomedRootId: null,
    });

    expect(target).toBeNull();
  });
});
