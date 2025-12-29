/**
 * markdownExport.test.ts - Tests for FLO-74 selection export
 */
import { describe, it, expect } from 'vitest';
import { blocksToMarkdown } from './markdownExport';
import type { Block } from './blockTypes';

// Helper to create minimal block for tests
function createBlock(overrides: Partial<Block> = {}): Block {
  return {
    id: 'test',
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

describe('blocksToMarkdown', () => {
  describe('single block export', () => {
    it('exports single text block without indentation', () => {
      const blocks: Record<string, Block> = {
        'b1': createBlock({ id: 'b1', content: 'Hello world' }),
      };
      const selected = new Set(['b1']);
      const visible = ['b1'];

      const result = blocksToMarkdown(selected, blocks, visible);
      expect(result).toBe('Hello world');
    });

    it('exports h1 with # prefix', () => {
      const blocks: Record<string, Block> = {
        'b1': createBlock({ id: 'b1', content: 'Title', type: 'h1' }),
      };
      const selected = new Set(['b1']);
      const visible = ['b1'];

      const result = blocksToMarkdown(selected, blocks, visible);
      expect(result).toBe('# Title');
    });

    it('exports h2 with ## prefix', () => {
      const blocks: Record<string, Block> = {
        'b1': createBlock({ id: 'b1', content: 'Section', type: 'h2' }),
      };
      const selected = new Set(['b1']);
      const visible = ['b1'];

      const result = blocksToMarkdown(selected, blocks, visible);
      expect(result).toBe('## Section');
    });

    it('exports bullet with - prefix', () => {
      const blocks: Record<string, Block> = {
        'b1': createBlock({ id: 'b1', content: 'Item', type: 'bullet' }),
      };
      const selected = new Set(['b1']);
      const visible = ['b1'];

      const result = blocksToMarkdown(selected, blocks, visible);
      expect(result).toBe('- Item');
    });

    it('exports todo with checkbox', () => {
      const blocks: Record<string, Block> = {
        'b1': createBlock({ id: 'b1', content: 'Task', type: 'todo' }),
      };
      const selected = new Set(['b1']);
      const visible = ['b1'];

      const result = blocksToMarkdown(selected, blocks, visible);
      expect(result).toBe('- [ ] Task');
    });

    it('exports quote with > prefix', () => {
      const blocks: Record<string, Block> = {
        'b1': createBlock({ id: 'b1', content: 'Quote', type: 'quote' }),
      };
      const selected = new Set(['b1']);
      const visible = ['b1'];

      const result = blocksToMarkdown(selected, blocks, visible);
      expect(result).toBe('> Quote');
    });

    it('preserves special prefixes for sh/ai blocks', () => {
      const blocks: Record<string, Block> = {
        'b1': createBlock({ id: 'b1', content: 'sh::ls -la', type: 'sh' }),
      };
      const selected = new Set(['b1']);
      const visible = ['b1'];

      const result = blocksToMarkdown(selected, blocks, visible);
      expect(result).toBe('sh::ls -la');
    });
  });

  describe('multiple block export', () => {
    it('exports flat siblings as separate lines', () => {
      const blocks: Record<string, Block> = {
        'b1': createBlock({ id: 'b1', content: 'First' }),
        'b2': createBlock({ id: 'b2', content: 'Second' }),
        'b3': createBlock({ id: 'b3', content: 'Third' }),
      };
      const selected = new Set(['b1', 'b2', 'b3']);
      const visible = ['b1', 'b2', 'b3'];

      const result = blocksToMarkdown(selected, blocks, visible);
      expect(result).toBe('First\nSecond\nThird');
    });

    it('maintains visible order when selection is out of order', () => {
      const blocks: Record<string, Block> = {
        'b1': createBlock({ id: 'b1', content: 'First' }),
        'b2': createBlock({ id: 'b2', content: 'Second' }),
        'b3': createBlock({ id: 'b3', content: 'Third' }),
      };
      // Selection added in different order
      const selected = new Set(['b3', 'b1', 'b2']);
      const visible = ['b1', 'b2', 'b3'];

      const result = blocksToMarkdown(selected, blocks, visible);
      expect(result).toBe('First\nSecond\nThird');
    });

    it('only includes selected blocks', () => {
      const blocks: Record<string, Block> = {
        'b1': createBlock({ id: 'b1', content: 'First' }),
        'b2': createBlock({ id: 'b2', content: 'Second' }),
        'b3': createBlock({ id: 'b3', content: 'Third' }),
      };
      const selected = new Set(['b1', 'b3']);
      const visible = ['b1', 'b2', 'b3'];

      const result = blocksToMarkdown(selected, blocks, visible);
      expect(result).toBe('First\nThird');
    });
  });

  describe('hierarchical export', () => {
    it('indents nested children', () => {
      const blocks: Record<string, Block> = {
        'parent': createBlock({ id: 'parent', content: 'Parent', childIds: ['child'] }),
        'child': createBlock({ id: 'child', content: 'Child', parentId: 'parent' }),
      };
      const selected = new Set(['parent', 'child']);
      const visible = ['parent', 'child'];

      const result = blocksToMarkdown(selected, blocks, visible);
      expect(result).toBe('Parent\n  - Child');
    });

    it('deeply nested blocks get more indentation', () => {
      const blocks: Record<string, Block> = {
        'a': createBlock({ id: 'a', content: 'Level 0', childIds: ['b'] }),
        'b': createBlock({ id: 'b', content: 'Level 1', parentId: 'a', childIds: ['c'] }),
        'c': createBlock({ id: 'c', content: 'Level 2', parentId: 'b' }),
      };
      const selected = new Set(['a', 'b', 'c']);
      const visible = ['a', 'b', 'c'];

      const result = blocksToMarkdown(selected, blocks, visible);
      expect(result).toBe('Level 0\n  - Level 1\n    - Level 2');
    });

    it('normalizes indentation when selecting only nested blocks', () => {
      const blocks: Record<string, Block> = {
        'a': createBlock({ id: 'a', content: 'Level 0', childIds: ['b'] }),
        'b': createBlock({ id: 'b', content: 'Level 1', parentId: 'a', childIds: ['c'] }),
        'c': createBlock({ id: 'c', content: 'Level 2', parentId: 'b' }),
      };
      // Only select the nested blocks
      const selected = new Set(['b', 'c']);
      const visible = ['a', 'b', 'c'];

      const result = blocksToMarkdown(selected, blocks, visible);
      // b is at depth 1, c is at depth 2, so minDepth=1
      // Relative: b=0, c=1
      expect(result).toBe('Level 1\n  - Level 2');
    });
  });

  describe('edge cases', () => {
    it('returns empty string for empty selection', () => {
      const blocks: Record<string, Block> = {
        'b1': createBlock({ id: 'b1', content: 'Content' }),
      };
      const selected = new Set<string>();
      const visible = ['b1'];

      const result = blocksToMarkdown(selected, blocks, visible);
      expect(result).toBe('');
    });

    it('handles missing blocks gracefully', () => {
      const blocks: Record<string, Block> = {
        'b1': createBlock({ id: 'b1', content: 'Exists' }),
      };
      const selected = new Set(['b1', 'missing']);
      const visible = ['b1', 'missing'];

      const result = blocksToMarkdown(selected, blocks, visible);
      expect(result).toBe('Exists');
    });

    it('handles blocks not in visible order', () => {
      const blocks: Record<string, Block> = {
        'b1': createBlock({ id: 'b1', content: 'Content' }),
      };
      const selected = new Set(['b1']);
      const visible: string[] = []; // Block not visible

      const result = blocksToMarkdown(selected, blocks, visible);
      expect(result).toBe('');
    });
  });
});
