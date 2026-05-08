/**
 * backlinkClassify.test.ts - Backlink kind classification tests
 *
 * Same 6-row fixture used on the Rust side (PR-B `classify_block_kind`
 * unit test). Drift between sides is detected by re-running the matching
 * fixture against either implementation.
 */
import { describe, it, expect } from 'vitest';
import { classifyBacklink, type BacklinkKind } from './backlinkClassify';
import { createBlock, type Block } from './blockTypes';

function withChildren(block: Block, childIds: string[]): Block {
  return { ...block, childIds };
}

describe('classifyBacklink', () => {
  describe('leaf_marker — heading + no children', () => {
    it('"## empty section" → leaf_marker', () => {
      expect(classifyBacklink(createBlock('a', '## empty section'))).toBe('leaf_marker');
    });
    it('"# top-level header" → leaf_marker', () => {
      expect(classifyBacklink(createBlock('a', '# top-level header'))).toBe('leaf_marker');
    });
    it('"### deep heading" → leaf_marker', () => {
      expect(classifyBacklink(createBlock('a', '### deep heading'))).toBe('leaf_marker');
    });
  });

  describe('nav_node — heading + children + no prose', () => {
    it('"## arcs" with children → nav_node', () => {
      const block = withChildren(createBlock('a', '## arcs'), ['c1', 'c2']);
      expect(classifyBacklink(block)).toBe('nav_node');
    });
    it('"# floatty" with children → nav_node', () => {
      const block = withChildren(createBlock('a', '# floatty'), ['c1']);
      expect(classifyBacklink(block)).toBe('nav_node');
    });

    // Trailing-newline edge cases — verified against the Rust implementation.
    it('trailing single newline still counts as heading-only', () => {
      const block = withChildren(createBlock('a', '## bones\n'), ['c1']);
      expect(classifyBacklink(block)).toBe('nav_node');
    });
    it('trailing double newline still counts as heading-only', () => {
      const block = withChildren(createBlock('a', '## tldr\n\n'), ['c1']);
      expect(classifyBacklink(block)).toBe('nav_node');
    });
  });

  describe('content_block — has prose OR not heading', () => {
    it('heading + body text + children → content_block', () => {
      const block = withChildren(
        createBlock('a', '## arcs\nbody content lives here'),
        ['c1'],
      );
      expect(classifyBacklink(block)).toBe('content_block');
    });
    it('heading + body text + no children → content_block', () => {
      expect(
        classifyBacklink(createBlock('a', '## arcs\nbody text')),
      ).toBe('content_block');
    });
    it('plain text → content_block', () => {
      expect(classifyBacklink(createBlock('a', 'just regular block content'))).toBe('content_block');
    });
    it('plain text with children → content_block', () => {
      const block = withChildren(createBlock('a', 'parent text'), ['c1']);
      expect(classifyBacklink(block)).toBe('content_block');
    });
    it('blank content → content_block', () => {
      expect(classifyBacklink(createBlock('a', ''))).toBe('content_block');
    });
    it('"#hashtag" without space → content_block (not a heading)', () => {
      // parseBlockType requires `# ` (with space) to classify as h1.
      expect(classifyBacklink(createBlock('a', '#hashtag'))).toBe('content_block');
    });
  });

  describe('cross-implementation parity fixture', () => {
    // Same rows as the Rust unit test in PR-B's classify_block_kind tests.
    // Order matters — drift is detected by index match.
    const fixtures: Array<{ content: string; childIds: string[]; expected: BacklinkKind }> = [
      { content: '## arcs',            childIds: ['c1'],      expected: 'nav_node' },
      { content: '## empty',           childIds: [],          expected: 'leaf_marker' },
      { content: '## arcs\nbody',      childIds: ['c1'],      expected: 'content_block' },
      { content: 'plain content',      childIds: ['c1'],      expected: 'content_block' },
      { content: '',                   childIds: [],          expected: 'content_block' },
      { content: '## bones\n\n',       childIds: ['c1'],      expected: 'nav_node' },
    ];

    fixtures.forEach((row, idx) => {
      it(`row ${idx}: ${JSON.stringify(row.content)} → ${row.expected}`, () => {
        const block = withChildren(createBlock(`fixture-${idx}`, row.content), row.childIds);
        expect(classifyBacklink(block)).toBe(row.expected);
      });
    });
  });
});
