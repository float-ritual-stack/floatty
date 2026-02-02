/**
 * Tests for staged-import.ts parsing logic
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { parseBackup, resetFenceState } from './staged-import';

describe('parseBackup', () => {
  beforeEach(() => {
    resetFenceState();
  });

  describe('basic parsing', () => {
    it('parses simple blocks', () => {
      const input = `=== Pane: default ===
root block
  child block`;

      const blocks = parseBackup(input);
      expect(blocks).toHaveLength(2);
      expect(blocks[0].content).toBe('root block');
      expect(blocks[0].depth).toBe(0);
      expect(blocks[1].content).toBe('child block');
      expect(blocks[1].depth).toBe(1);
    });

    it('skips header lines before pane marker', () => {
      const input = `Some header garbage
More header
=== Pane: default ===
actual content`;

      const blocks = parseBackup(input);
      expect(blocks).toHaveLength(1);
      expect(blocks[0].content).toBe('actual content');
    });
  });

  describe('code fence handling (BUG #6)', () => {
    it('preserves empty lines inside code fences', () => {
      const input = `=== Pane: default ===
\`\`\`typescript
function foo() {

  return bar;
}
\`\`\``;

      const blocks = parseBackup(input);
      expect(blocks).toHaveLength(1);
      // The block should contain the entire code fence including empty line
      expect(blocks[0].content).toContain('function foo()');
      expect(blocks[0].content).toContain('return bar');
      expect(blocks[0].content).toContain('```');
    });

    it('handles multiple code fences', () => {
      const input = `=== Pane: default ===
\`\`\`js
first

block
\`\`\`
normal text
\`\`\`py
second

block
\`\`\``;

      const blocks = parseBackup(input);
      expect(blocks).toHaveLength(3);
      expect(blocks[0].content).toContain('first');
      expect(blocks[0].content).toContain('block');
      expect(blocks[1].content).toBe('normal text');
      expect(blocks[2].content).toContain('second');
    });

    it('does not merge blocks across code fence boundaries', () => {
      const input = `=== Pane: default ===
before fence
\`\`\`
code
\`\`\`
after fence`;

      const blocks = parseBackup(input);
      expect(blocks).toHaveLength(3);
      expect(blocks[0].content).toBe('before fence');
      expect(blocks[1].content).toContain('```');
      expect(blocks[1].content).toContain('code');
      expect(blocks[2].content).toBe('after fence');
    });
  });

  describe('table continuation', () => {
    it('merges table continuation lines', () => {
      const input = `=== Pane: default ===
Jan 19 │ Some content
│ continued here
│ more continuation`;

      const blocks = parseBackup(input);
      expect(blocks).toHaveLength(1);
      expect(blocks[0].content).toContain('Jan 19');
      expect(blocks[0].content).toContain('continued here');
      expect(blocks[0].content).toContain('more continuation');
    });

    it('treats date lines as new blocks', () => {
      const input = `=== Pane: default ===
Jan 19 │ First day
│ continuation
Feb 01 │ Second day`;

      const blocks = parseBackup(input);
      expect(blocks).toHaveLength(2);
      expect(blocks[0].content).toContain('Jan 19');
      expect(blocks[1].content).toContain('Feb 01');
    });

    it('handles box drawing characters as continuations', () => {
      const input = `=== Pane: default ===
┌─────────────┐
│ table cell  │
└─────────────┘`;

      const blocks = parseBackup(input);
      // Box drawing lines should merge
      expect(blocks.length).toBeLessThanOrEqual(2);
    });
  });

  describe('depth calculation', () => {
    it('calculates depth from leading spaces (2 spaces per level)', () => {
      const input = `=== Pane: default ===
root
  level1
    level2
      level3`;

      const blocks = parseBackup(input);
      expect(blocks[0].depth).toBe(0);
      expect(blocks[1].depth).toBe(1);
      expect(blocks[2].depth).toBe(2);
      expect(blocks[3].depth).toBe(3);
    });
  });

  describe('empty line handling', () => {
    it('empty lines end block grouping outside code fences', () => {
      const input = `=== Pane: default ===
block one

block two`;

      const blocks = parseBackup(input);
      expect(blocks).toHaveLength(2);
      expect(blocks[0].content).toBe('block one');
      expect(blocks[1].content).toBe('block two');
    });
  });

  describe('line numbers', () => {
    it('tracks source line numbers (1-indexed)', () => {
      const input = `=== Pane: default ===
first
second`;

      const blocks = parseBackup(input);
      expect(blocks[0].lineNumber).toBe(2); // Line after header
      expect(blocks[1].lineNumber).toBe(3);
    });
  });

  describe('orphan detection (col0 non-roots)', () => {
    it('allows true roots at depth 0', () => {
      const input = `=== Pane: default ===
## here be dragons
## Weekly notes
pages::`;

      const blocks = parseBackup(input);
      expect(blocks).toHaveLength(3);
      expect(blocks[0].depth).toBe(0);
      expect(blocks[1].depth).toBe(0);
      expect(blocks[2].depth).toBe(0);
    });

    it('re-parents orphan col0 lines', () => {
      const input = `=== Pane: default ===
## here be dragons
  child block
ctx::orphan at col0
**Did**: also orphan`;

      const blocks = parseBackup(input);
      expect(blocks).toHaveLength(4);
      expect(blocks[0].depth).toBe(0); // true root
      expect(blocks[1].depth).toBe(1); // child
      expect(blocks[2].depth).toBe(2); // orphan re-parented under child's level + 1
      expect(blocks[3].depth).toBe(2); // same
    });

    it('attaches orphans after true root', () => {
      const input = `=== Pane: default ===
## Weekly notes
orphan line`;

      const blocks = parseBackup(input);
      expect(blocks[0].content).toBe('## Weekly notes');
      expect(blocks[0].depth).toBe(0);
      expect(blocks[1].content).toBe('orphan line');
      expect(blocks[1].depth).toBe(1); // attached as child of Weekly notes
    });
  });
});
