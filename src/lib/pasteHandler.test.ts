/**
 * Tests for smart paste handler (FLO-62, FLO-128)
 */

import { describe, it, expect, vi } from 'vitest';
import { handleStructuredPaste, type PasteActions } from './pasteHandler';

function createMockActions(): PasteActions & { blocks: Map<string, { content: string; parentId: string | null; childIds: string[] }> } {
  const blocks = new Map<string, { content: string; parentId: string | null; childIds: string[] }>();
  let idCounter = 0;

  // Initialize with a root block
  blocks.set('root', { content: '', parentId: null, childIds: [] });

  return {
    blocks,
    getBlock: (id) => blocks.get(id),
    createBlockAfter: vi.fn((afterId) => {
      const newId = `block-${++idCounter}`;
      blocks.set(newId, { content: '', parentId: null, childIds: [] });
      return newId;
    }),
    createBlockInside: vi.fn((parentId) => {
      const newId = `block-${++idCounter}`;
      const parent = blocks.get(parentId);
      if (parent) {
        parent.childIds.push(newId);
      }
      blocks.set(newId, { content: '', parentId, childIds: [] });
      return newId;
    }),
    updateBlockContent: vi.fn((id, content) => {
      const block = blocks.get(id);
      if (block) block.content = content;
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
      // Should create sibling blocks for each item
      expect(actions.createBlockAfter).toHaveBeenCalled();
    });

    it('handles nested list', () => {
      const actions = createMockActions();
      const markdown = `- Parent item
  - Child item
  - Another child`;

      const result = handleStructuredPaste('root', markdown, actions);

      expect(result.handled).toBe(true);
      // Should create child blocks inside parent
      expect(actions.createBlockInside).toHaveBeenCalled();
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
  });

  describe('non-empty block behavior', () => {
    it('creates siblings when current block has content', () => {
      const actions = createMockActions();
      // Set root to have content
      actions.blocks.get('root')!.content = 'existing content';

      const markdown = `- New item one
- New item two`;

      const result = handleStructuredPaste('root', markdown, actions);

      expect(result.handled).toBe(true);
      // Should create siblings after root, not modify root
      expect(actions.createBlockAfter).toHaveBeenCalledWith('root');
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
});
