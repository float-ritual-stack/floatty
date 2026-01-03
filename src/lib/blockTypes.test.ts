/**
 * blockTypes.test.ts - Content classification tests
 *
 * Tests parseBlockType which detects magic triggers and markdown syntax.
 */
import { describe, it, expect } from 'vitest';
import { parseBlockType, createBlock } from './blockTypes';

describe('parseBlockType', () => {
  describe('magic triggers (case-insensitive)', () => {
    it('detects sh:: trigger', () => {
      expect(parseBlockType('sh:: ls -la')).toBe('sh');
      expect(parseBlockType('SH:: ls -la')).toBe('sh');
      expect(parseBlockType('Sh::command')).toBe('sh');
    });

    it('detects term:: as shell', () => {
      expect(parseBlockType('term:: echo hello')).toBe('sh');
      expect(parseBlockType('TERM::pwd')).toBe('sh');
    });

    it('detects ai:: trigger', () => {
      expect(parseBlockType('ai:: explain this code')).toBe('ai');
      expect(parseBlockType('AI:: summarize')).toBe('ai');
    });

    it('detects chat:: as ai', () => {
      expect(parseBlockType('chat:: what is 2+2?')).toBe('ai');
      expect(parseBlockType('CHAT::hello')).toBe('ai');
    });

    it('detects ctx:: with timestamp trigger', () => {
      expect(parseBlockType('ctx::2025-12-28 project=floatty')).toBe('ctx');
      expect(parseBlockType('CTX::2025-12-28')).toBe('ctx');
    });

    it('detects ctx:: at line start or after bullet (FLO-39)', () => {
      // Block-level ctx:: detection
      expect(parseBlockType('ctx::2026-01-03 [project::floatty]')).toBe('ctx');
      expect(parseBlockType('- ctx::2026-01-03 [project::floatty]')).toBe('ctx');
      // Mid-content ctx:: keeps original type - inline parser handles styling
      expect(parseBlockType('some note ctx::2026-01-03 marker here')).toBe('text');
      expect(parseBlockType('## heading ctx::2025-11-15 with marker')).toBe('h2');
    });

    it('does NOT detect ctx:: without timestamp (abstract discussion)', () => {
      expect(parseBlockType('talking about ctx:: in general')).toBe('text');
      expect(parseBlockType('the ctx:: marker is useful')).toBe('text');
    });

    it('detects dispatch:: trigger', () => {
      expect(parseBlockType('dispatch:: summarize this')).toBe('dispatch');
      expect(parseBlockType('DISPATCH::run task')).toBe('dispatch');
    });

    it('detects web:: trigger', () => {
      expect(parseBlockType('web:: https://example.com')).toBe('web');
      expect(parseBlockType('WEB::google.com')).toBe('web');
    });

    it('detects link:: as web', () => {
      expect(parseBlockType('link:: https://github.com')).toBe('web');
      expect(parseBlockType('LINK::url')).toBe('web');
    });

    it('detects output:: trigger', () => {
      expect(parseBlockType('output:: result here')).toBe('output');
      expect(parseBlockType('OUTPUT::data')).toBe('output');
    });

    it('detects error:: trigger', () => {
      expect(parseBlockType('error:: something went wrong')).toBe('error');
      expect(parseBlockType('ERROR::stack trace')).toBe('error');
    });
  });

  describe('markdown headings', () => {
    it('detects # as h1', () => {
      expect(parseBlockType('# Main Title')).toBe('h1');
      expect(parseBlockType('  # Indented heading')).toBe('h1');
    });

    it('detects ## as h2', () => {
      expect(parseBlockType('## Section')).toBe('h2');
    });

    it('detects ### as h3', () => {
      expect(parseBlockType('### Subsection')).toBe('h3');
    });

    it('requires space after hash', () => {
      expect(parseBlockType('#NoSpace')).toBe('text');
      expect(parseBlockType('##AlsoNoSpace')).toBe('text');
    });

    it('distinguishes heading levels correctly', () => {
      // ### must be checked before ## before #
      expect(parseBlockType('### h3')).toBe('h3');
      expect(parseBlockType('## h2')).toBe('h2');
      expect(parseBlockType('# h1')).toBe('h1');
    });
  });

  describe('markdown lists', () => {
    it('detects - as bullet', () => {
      expect(parseBlockType('- list item')).toBe('bullet');
      expect(parseBlockType('  - indented bullet')).toBe('bullet');
    });

    it('detects - [ ] as todo (unchecked)', () => {
      expect(parseBlockType('- [ ] unchecked task')).toBe('todo');
      expect(parseBlockType('  - [ ] indented task')).toBe('todo');
    });

    it('detects - [x] as todo (checked)', () => {
      expect(parseBlockType('- [x] done task')).toBe('todo');
      expect(parseBlockType('- [X] also done')).toBe('todo');
    });

    it('requires space after dash for bullet', () => {
      expect(parseBlockType('-no space')).toBe('text');
    });

    it('does not detect * as bullet (asterisk is not a trigger)', () => {
      // parseBlockType only recognizes - prefix, not * (markdownParser handles *)
      expect(parseBlockType('* item')).toBe('text');
    });
  });

  describe('blockquotes', () => {
    it('detects > as quote', () => {
      expect(parseBlockType('> quoted text')).toBe('quote');
      expect(parseBlockType('  > indented quote')).toBe('quote');
    });

    it('requires space after >', () => {
      expect(parseBlockType('>nospace')).toBe('text');
    });
  });

  describe('plain text fallback', () => {
    it('returns text for regular content', () => {
      expect(parseBlockType('just some text')).toBe('text');
      expect(parseBlockType('Hello world')).toBe('text');
    });

    it('returns text for empty/whitespace', () => {
      expect(parseBlockType('')).toBe('text');
      expect(parseBlockType('   ')).toBe('text');
    });

    it('returns text for partial triggers', () => {
      expect(parseBlockType('sh: missing colon')).toBe('text');
      expect(parseBlockType('ctx: also missing')).toBe('text');
    });
  });

  describe('edge cases', () => {
    it('handles trigger with no content after', () => {
      expect(parseBlockType('sh::')).toBe('sh');
      expect(parseBlockType('ai::')).toBe('ai');
    });

    it('trims leading/trailing whitespace', () => {
      expect(parseBlockType('  sh:: command  ')).toBe('sh');
      expect(parseBlockType('\t# Heading\t')).toBe('h1');
    });

    it('trigger takes precedence over markdown', () => {
      // If someone writes "sh:: # this", it's still sh
      expect(parseBlockType('sh:: # comment')).toBe('sh');
      expect(parseBlockType('ctx::2026-01-03 - item')).toBe('ctx');
    });
  });
});

describe('createBlock', () => {
  it('creates block with correct type from content', () => {
    const block = createBlock('id-1', 'sh:: ls');
    expect(block.type).toBe('sh');
    expect(block.content).toBe('sh:: ls');
  });

  it('creates text block by default', () => {
    const block = createBlock('id-2', 'plain text');
    expect(block.type).toBe('text');
  });

  it('creates block with empty content', () => {
    const block = createBlock('id-3', '');
    expect(block.type).toBe('text');
    expect(block.content).toBe('');
  });

  it('sets parentId correctly', () => {
    const block = createBlock('child', 'content', 'parent-id');
    expect(block.parentId).toBe('parent-id');
  });

  it('initializes with default values', () => {
    const block = createBlock('id-4', 'test');
    expect(block.childIds).toEqual([]);
    expect(block.collapsed).toBe(false);
    expect(block.createdAt).toBeLessThanOrEqual(Date.now());
    expect(block.updatedAt).toBeLessThanOrEqual(Date.now());
  });
});
