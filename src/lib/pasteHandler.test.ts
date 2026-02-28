/**
 * Tests for smart paste handler (FLO-62, FLO-128, FLO-322)
 */

import { describe, it, expect, vi } from 'vitest';
import { handleStructuredPaste, type PasteActions } from './pasteHandler';
import type { BatchBlockOp } from '../hooks/useBlockStore';

function createMockActions(): PasteActions & { blocks: Map<string, { content: string; parentId: string | null; childIds: string[] }> } {
  const blocks = new Map<string, { content: string; parentId: string | null; childIds: string[] }>();
  let idCounter = 0;

  // Initialize with a root block
  blocks.set('root', { content: '', parentId: null, childIds: [] });

  const createBlocksFromOps = (parentId: string | null, ops: BatchBlockOp[]): string[] => {
    const ids: string[] = [];
    for (const op of ops) {
      const newId = `block-${++idCounter}`;
      blocks.set(newId, { content: op.content, parentId, childIds: [] });
      ids.push(newId);
      if (parentId) {
        const parent = blocks.get(parentId);
        if (parent) parent.childIds.push(newId);
      }
      if (op.children && op.children.length > 0) {
        createBlocksFromOps(newId, op.children);
      }
    }
    return ids;
  };

  return {
    blocks,
    getBlock: (id) => blocks.get(id),
    updateBlockContent: vi.fn((id, content) => {
      const block = blocks.get(id);
      if (block) block.content = content;
    }),
    batchCreateBlocksAfter: vi.fn((_afterId: string, ops: BatchBlockOp[]) => {
      // Siblings: parentId matches the afterId block's parent
      const afterBlock = blocks.get(_afterId);
      return createBlocksFromOps(afterBlock?.parentId ?? null, ops);
    }),
    batchCreateBlocksInside: vi.fn((parentId: string, ops: BatchBlockOp[]) => {
      return createBlocksFromOps(parentId, ops);
    }),
  };
}

describe('handleStructuredPaste', () => {
  describe('returns not handled for non-structured content', () => {
    it('returns handled=false for empty text', () => {
      const actions = createMockActions();
      const result = handleStructuredPaste('root', '', actions);
      expect(result.handled).toBe(false);
    });

    it('returns handled=false for single line text', () => {
      const actions = createMockActions();
      const result = handleStructuredPaste('root', 'just a line of text', actions);
      expect(result.handled).toBe(false);
    });

    it('returns handled=false for multiple lines without structure', () => {
      const actions = createMockActions();
      const result = handleStructuredPaste('root', 'line one\nline two\nline three', actions);
      expect(result.handled).toBe(false);
    });
  });

  describe('handles structured markdown', () => {
    it('handles heading with content', () => {
      const actions = createMockActions();
      const markdown = `# Heading
Some content under heading`;

      const result = handleStructuredPaste('root', markdown, actions);

      expect(result.handled).toBe(true);
      expect(actions.updateBlockContent).toHaveBeenCalled();
    });

    it('handles bulleted list', () => {
      const actions = createMockActions();
      const markdown = `- Item one
- Item two
- Item three`;

      const result = handleStructuredPaste('root', markdown, actions);

      expect(result.handled).toBe(true);
      // Should use batch create for sibling blocks
      expect(actions.batchCreateBlocksAfter).toHaveBeenCalled();
    });

    it('handles nested list', () => {
      const actions = createMockActions();
      const markdown = `- Parent item
  - Child item
  - Another child`;

      const result = handleStructuredPaste('root', markdown, actions);

      expect(result.handled).toBe(true);
      // Nested children are passed as children in the ops tree
      const ops = (actions.batchCreateBlocksAfter as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
      if (ops) {
        expect(ops[0].children).toBeDefined();
        expect(ops[0].children.length).toBe(2);
      }
    });

    it('handles heading with list underneath', () => {
      const actions = createMockActions();
      const markdown = `# Section Title
- First point
- Second point`;

      const result = handleStructuredPaste('root', markdown, actions);

      expect(result.handled).toBe(true);
    });
  });

  describe('empty block behavior', () => {
    it('uses first block content for empty current block', () => {
      const actions = createMockActions();
      // Current block is empty (default)

      const markdown = `# First Heading
- Item under heading`;

      const result = handleStructuredPaste('root', markdown, actions);

      expect(result.handled).toBe(true);
      // First call should update root with "# First Heading"
      expect(actions.updateBlockContent).toHaveBeenCalledWith('root', '# First Heading');
    });

    it('inserts first block children inside current block via batch', () => {
      const actions = createMockActions();

      const markdown = `# Heading
- Child one
- Child two`;

      const result = handleStructuredPaste('root', markdown, actions);

      expect(result.handled).toBe(true);
      expect(actions.batchCreateBlocksInside).toHaveBeenCalledWith('root', expect.any(Array));
    });
  });

  describe('non-empty block behavior', () => {
    it('creates siblings via batch when current block has content', () => {
      const actions = createMockActions();
      // Set root to have content
      actions.blocks.get('root')!.content = 'existing content';

      const markdown = `- New item one
- New item two`;

      const result = handleStructuredPaste('root', markdown, actions);

      expect(result.handled).toBe(true);
      expect(actions.batchCreateBlocksAfter).toHaveBeenCalledWith('root', expect.any(Array));
    });
  });

  describe('focus handling', () => {
    it('returns focusId for last inserted block', () => {
      const actions = createMockActions();
      actions.blocks.get('root')!.content = 'existing';

      const markdown = `- Item one
- Item two
- Item three`;

      const result = handleStructuredPaste('root', markdown, actions);

      expect(result.handled).toBe(true);
      expect(result.focusId).toBeDefined();
      // focusId should be the last created block
      expect(result.focusId).toMatch(/^block-\d+$/);
    });
  });

  describe('batch operation structure (FLO-322)', () => {
    it('passes correct ops tree to batchCreateBlocksAfter', () => {
      const actions = createMockActions();
      actions.blocks.get('root')!.content = 'existing';

      const markdown = `# Section
- Point one
  - Sub point
- Point two`;

      handleStructuredPaste('root', markdown, actions);

      const calls = (actions.batchCreateBlocksAfter as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.length).toBe(1);

      const [afterId, ops] = calls[0];
      expect(afterId).toBe('root');
      expect(ops[0].content).toBe('# Section');
      // Section should have children (the list items)
      expect(ops[0].children).toBeDefined();
    });

    it('uses single batch call for multi-block paste (not per-block calls)', () => {
      const actions = createMockActions();
      actions.blocks.get('root')!.content = 'existing';

      const markdown = `- Item 1
- Item 2
- Item 3
- Item 4
- Item 5`;

      handleStructuredPaste('root', markdown, actions);

      // One batch call, not 5 individual calls
      expect(actions.batchCreateBlocksAfter).toHaveBeenCalledTimes(1);
      const ops = (actions.batchCreateBlocksAfter as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(ops.length).toBe(5);
    });
  });
});
