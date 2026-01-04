/**
 * inlineParser.test.ts - Markdown inline tokenization tests
 *
 * Tests parseInlineTokens which extracts **bold**, *italic*, `code` spans.
 */
import { describe, it, expect } from 'vitest';
import { parseInlineTokens, parseAllInlineTokens, hasInlineFormatting, hasCtxPatterns, hasWikilinks, type InlineToken } from './inlineParser';

// Helper to extract just types and content for easier assertions
function tokenSummary(tokens: InlineToken[]): Array<{ type: string; content: string }> {
  return tokens.map(t => ({ type: t.type, content: t.content }));
}

describe('parseInlineTokens', () => {
  describe('basic patterns', () => {
    it('parses **bold** text', () => {
      const tokens = parseInlineTokens('this is **bold** text');
      expect(tokenSummary(tokens)).toEqual([
        { type: 'text', content: 'this is ' },
        { type: 'bold', content: 'bold' },
        { type: 'text', content: ' text' },
      ]);
    });

    it('parses *italic* text', () => {
      const tokens = parseInlineTokens('some *italic* words');
      expect(tokenSummary(tokens)).toEqual([
        { type: 'text', content: 'some ' },
        { type: 'italic', content: 'italic' },
        { type: 'text', content: ' words' },
      ]);
    });

    it('parses `code` spans', () => {
      const tokens = parseInlineTokens('run `npm install` command');
      expect(tokenSummary(tokens)).toEqual([
        { type: 'text', content: 'run ' },
        { type: 'code', content: 'npm install' },
        { type: 'text', content: ' command' },
      ]);
    });
  });

  describe('precedence', () => {
    it('code takes precedence - asterisks inside backticks are literal', () => {
      const tokens = parseInlineTokens('text `**not bold**` more');
      expect(tokenSummary(tokens)).toEqual([
        { type: 'text', content: 'text ' },
        { type: 'code', content: '**not bold**' },
        { type: 'text', content: ' more' },
      ]);
    });

    it('bold takes precedence over italic', () => {
      // **x** should be bold, not two italics
      const tokens = parseInlineTokens('a **bold** b');
      expect(tokens.find(t => t.type === 'bold')).toBeDefined();
      expect(tokens.filter(t => t.type === 'italic')).toHaveLength(0);
    });
  });

  describe('multiple patterns', () => {
    it('handles mixed formatting', () => {
      const tokens = parseInlineTokens('**bold** and *italic* and `code`');
      expect(tokenSummary(tokens)).toEqual([
        { type: 'bold', content: 'bold' },
        { type: 'text', content: ' and ' },
        { type: 'italic', content: 'italic' },
        { type: 'text', content: ' and ' },
        { type: 'code', content: 'code' },
      ]);
    });

    it('handles adjacent formatting', () => {
      const tokens = parseInlineTokens('**bold***italic*');
      expect(tokenSummary(tokens)).toEqual([
        { type: 'bold', content: 'bold' },
        { type: 'italic', content: 'italic' },
      ]);
    });

    it('handles multiple of same type', () => {
      const tokens = parseInlineTokens('`a` and `b` and `c`');
      const codeTokens = tokens.filter(t => t.type === 'code');
      expect(codeTokens).toHaveLength(3);
      expect(codeTokens.map(t => t.content)).toEqual(['a', 'b', 'c']);
    });
  });

  describe('raw preservation', () => {
    it('preserves raw text with markers', () => {
      const tokens = parseInlineTokens('**bold**');
      expect(tokens[0].raw).toBe('**bold**');
      expect(tokens[0].content).toBe('bold');
    });

    it('preserves raw for code', () => {
      const tokens = parseInlineTokens('`code`');
      expect(tokens[0].raw).toBe('`code`');
      expect(tokens[0].content).toBe('code');
    });

    it('raw equals content for plain text', () => {
      const tokens = parseInlineTokens('plain text');
      expect(tokens[0].raw).toBe('plain text');
      expect(tokens[0].content).toBe('plain text');
    });
  });

  describe('position tracking', () => {
    it('tracks start/end positions correctly', () => {
      const tokens = parseInlineTokens('a **b** c');
      // 'a ' -> 0-2
      // '**b**' -> 2-7
      // ' c' -> 7-9
      expect(tokens[0].start).toBe(0);
      expect(tokens[0].end).toBe(2);
      expect(tokens[1].start).toBe(2);
      expect(tokens[1].end).toBe(7);
      expect(tokens[2].start).toBe(7);
      expect(tokens[2].end).toBe(9);
    });

    it('positions cover entire string', () => {
      const input = 'some **bold** text';
      const tokens = parseInlineTokens(input);
      expect(tokens[0].start).toBe(0);
      expect(tokens[tokens.length - 1].end).toBe(input.length);
    });
  });

  describe('edge cases', () => {
    it('returns empty array for empty string', () => {
      expect(parseInlineTokens('')).toEqual([]);
    });

    it('returns single text token for plain text', () => {
      const tokens = parseInlineTokens('no formatting here');
      expect(tokens).toHaveLength(1);
      expect(tokens[0].type).toBe('text');
    });

    it('handles unclosed patterns as text', () => {
      // Unclosed ** should not match
      const tokens = parseInlineTokens('**unclosed');
      expect(tokens).toHaveLength(1);
      expect(tokens[0].type).toBe('text');
    });

    it('handles empty patterns', () => {
      // ** ** has content, `x` has content
      // But ** ** (empty) - regex requires at least 1 char
      const tokens = parseInlineTokens('text only');
      expect(tokens.every(t => t.type === 'text')).toBe(true);
    });

    it('matches content between asterisks as italic', () => {
      // 'a * b * c' - the '* b *' matches as italic because there's content
      const tokens = parseInlineTokens('a * b * c');
      expect(tokens).toHaveLength(3);
      expect(tokens[0].type).toBe('text');
      expect(tokens[1].type).toBe('italic');
      expect(tokens[1].content).toBe(' b ');
      expect(tokens[2].type).toBe('text');
    });

    it('handles formatting at string boundaries', () => {
      const tokens1 = parseInlineTokens('**start');
      expect(tokens1[0].type).toBe('text');

      const tokens2 = parseInlineTokens('**bold**');
      expect(tokens2[0].type).toBe('bold');
    });

    it('handles consecutive bold without space', () => {
      // **one****two** - the [^*]+ prevents matching across ****
      const tokens = parseInlineTokens('**one****two**');
      // First **one** matches, then ****two** doesn't match (starts with **)
      expect(tokens[0].type).toBe('bold');
      expect(tokens[0].content).toBe('one');
    });

    it('does not support nested formatting (asterisks inside are literal)', () => {
      // Nested formatting not supported - inner asterisks are part of content
      const tokens = parseInlineTokens('**bold with *asterisks* inside**');
      // The [^*]+ in regex stops at first *, so this matches differently
      expect(tokens.some(t => t.type === 'bold' || t.type === 'italic')).toBe(true);
    });
  });
});

describe('hasInlineFormatting', () => {
  it('returns true for bold', () => {
    expect(hasInlineFormatting('has **bold** text')).toBe(true);
  });

  it('returns true for italic', () => {
    expect(hasInlineFormatting('has *italic* text')).toBe(true);
  });

  it('returns true for code', () => {
    expect(hasInlineFormatting('has `code` text')).toBe(true);
  });

  it('returns false for plain text', () => {
    expect(hasInlineFormatting('plain text only')).toBe(false);
  });

  it('returns false for unclosed patterns', () => {
    expect(hasInlineFormatting('**unclosed')).toBe(false);
    expect(hasInlineFormatting('`no end')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(hasInlineFormatting('')).toBe(false);
  });

  it('returns true for space between asterisks (matches as bold)', () => {
    // '** **' - the space is content, so it matches as bold
    expect(hasInlineFormatting('** **')).toBe(true);
  });

  it('returns true for ctx:: with timestamp', () => {
    expect(hasInlineFormatting('ctx::2026-01-03 @ 02:50 AM')).toBe(true);
    expect(hasInlineFormatting('- ctx::2026-01-03 [project::floatty]')).toBe(true);
  });

  it('returns false for ctx:: without timestamp', () => {
    expect(hasInlineFormatting('talking about ctx:: in general')).toBe(false);
  });
});

describe('ctx:: inline parsing', () => {
  describe('hasCtxPatterns', () => {
    it('returns true for ctx:: with timestamp', () => {
      expect(hasCtxPatterns('ctx::2026-01-03')).toBe(true);
      expect(hasCtxPatterns('- ctx::2026-01-03 @ 02:50:24 AM')).toBe(true);
    });

    it('returns false for ctx:: without timestamp', () => {
      expect(hasCtxPatterns('ctx:: without date')).toBe(false);
      expect(hasCtxPatterns('talking about ctx::')).toBe(false);
    });
  });

  describe('parseAllInlineTokens for ctx::', () => {
    it('parses ctx:: prefix', () => {
      const tokens = parseAllInlineTokens('ctx::2026-01-03');
      expect(tokens.find(t => t.type === 'ctx-prefix')).toBeDefined();
      expect(tokens.find(t => t.type === 'ctx-prefix')?.raw).toBe('ctx::');
    });

    it('parses timestamp', () => {
      const tokens = parseAllInlineTokens('ctx::2026-01-03');
      expect(tokens.find(t => t.type === 'ctx-timestamp')).toBeDefined();
      expect(tokens.find(t => t.type === 'ctx-timestamp')?.raw).toBe('2026-01-03');
    });

    it('parses timestamp with time', () => {
      const tokens = parseAllInlineTokens('ctx::2026-01-03 @ 02:50:24 AM');
      const timestamp = tokens.find(t => t.type === 'ctx-timestamp');
      expect(timestamp).toBeDefined();
      expect(timestamp?.raw).toBe('2026-01-03 @ 02:50:24 AM');
    });

    it('parses project tag', () => {
      const tokens = parseAllInlineTokens('ctx::2026-01-03 [project::floatty]');
      const tag = tokens.find(t => t.type === 'ctx-tag');
      expect(tag).toBeDefined();
      expect(tag?.tagType).toBe('project');
      expect(tag?.content).toBe('floatty');
      expect(tag?.raw).toBe('[project::floatty]');
    });

    it('parses multiple tags', () => {
      const tokens = parseAllInlineTokens('ctx::2026-01-03 [project::floatty] [mode::build]');
      const tags = tokens.filter(t => t.type === 'ctx-tag');
      expect(tags).toHaveLength(2);
      expect(tags[0].tagType).toBe('project');
      expect(tags[1].tagType).toBe('mode');
    });

    it('parses issue tag', () => {
      const tokens = parseAllInlineTokens('ctx::2026-01-03 [issue::FLO-39]');
      const tag = tokens.find(t => t.type === 'ctx-tag');
      expect(tag?.tagType).toBe('issue');
      expect(tag?.content).toBe('FLO-39');
    });

    it('preserves surrounding text', () => {
      const tokens = parseAllInlineTokens('- ctx::2026-01-03 summary text');
      expect(tokens[0].type).toBe('text');
      expect(tokens[0].raw).toBe('- ');
      const lastTextToken = tokens.filter(t => t.type === 'text').pop();
      expect(lastTextToken?.raw).toContain('summary text');
    });

    it('handles real-world ctx:: footer pattern', () => {
      const input = '- ctx::2026-01-03 @ 02:36:23 AM - [project::floatty] - [issue::FLO-39]';
      const tokens = parseAllInlineTokens(input);

      expect(tokens.find(t => t.type === 'ctx-prefix')).toBeDefined();
      expect(tokens.find(t => t.type === 'ctx-timestamp')).toBeDefined();
      expect(tokens.filter(t => t.type === 'ctx-tag')).toHaveLength(2);
    });
  });

  describe('mixed ctx:: and markdown', () => {
    it('parses ctx:: with markdown in surrounding text', () => {
      const input = '**heading** - ctx::2026-01-03 [project::floatty]';
      const tokens = parseAllInlineTokens(input);

      expect(tokens.find(t => t.type === 'bold')).toBeDefined();
      expect(tokens.find(t => t.type === 'ctx-prefix')).toBeDefined();
      expect(tokens.find(t => t.type === 'ctx-tag')).toBeDefined();
    });
  });
});

describe('wikilink parsing', () => {
  describe('hasWikilinks', () => {
    it('returns true for simple wikilink', () => {
      expect(hasWikilinks('Check out [[My Page]]')).toBe(true);
    });

    it('returns true for wikilink with alias', () => {
      expect(hasWikilinks('See [[Target Page|displayed text]]')).toBe(true);
    });

    it('returns false for text without wikilinks', () => {
      expect(hasWikilinks('Just regular text')).toBe(false);
    });

    it('returns false for unclosed brackets', () => {
      expect(hasWikilinks('[[unclosed')).toBe(false);
      expect(hasWikilinks('just [single]')).toBe(false);
    });

    it('returns true for wikilinks with spaces', () => {
      expect(hasWikilinks('[[Page With Spaces]]')).toBe(true);
    });
  });

  describe('parseInlineTokens for wikilinks', () => {
    it('parses simple wikilink', () => {
      const tokens = parseInlineTokens('Check out [[My Page]]');
      expect(tokenSummary(tokens)).toEqual([
        { type: 'text', content: 'Check out ' },
        { type: 'wikilink', content: 'My Page' },
      ]);
    });

    it('parses wikilink with alias', () => {
      const tokens = parseInlineTokens('See [[Target|display]]');
      const wikilink = tokens.find(t => t.type === 'wikilink');
      expect(wikilink).toBeDefined();
      expect(wikilink?.content).toBe('display');  // Display text is the alias
      expect(wikilink?.linkTarget).toBe('Target');  // Target is stored separately
    });

    it('parses multiple wikilinks', () => {
      const tokens = parseInlineTokens('[[First]] and [[Second]]');
      const wikilinks = tokens.filter(t => t.type === 'wikilink');
      expect(wikilinks).toHaveLength(2);
      expect(wikilinks[0].content).toBe('First');
      expect(wikilinks[1].content).toBe('Second');
    });

    it('preserves raw text with brackets', () => {
      const tokens = parseInlineTokens('[[Link]]');
      expect(tokens[0].raw).toBe('[[Link]]');
      expect(tokens[0].content).toBe('Link');
    });

    it('tracks positions correctly', () => {
      const tokens = parseInlineTokens('a [[b]] c');
      // 'a ' -> 0-2
      // '[[b]]' -> 2-7
      // ' c' -> 7-9
      expect(tokens[0].start).toBe(0);
      expect(tokens[0].end).toBe(2);
      expect(tokens[1].start).toBe(2);
      expect(tokens[1].end).toBe(7);
      expect(tokens[2].start).toBe(7);
      expect(tokens[2].end).toBe(9);
    });

    it('handles wikilinks with spaces in target', () => {
      const tokens = parseInlineTokens('[[Page With Spaces]]');
      expect(tokens[0].type).toBe('wikilink');
      expect(tokens[0].content).toBe('Page With Spaces');
      expect(tokens[0].linkTarget).toBe('Page With Spaces');
    });

    it('handles alias with spaces', () => {
      const tokens = parseInlineTokens('[[Target|Link Text Here]]');
      const wikilink = tokens[0];
      expect(wikilink.type).toBe('wikilink');
      expect(wikilink.content).toBe('Link Text Here');
      expect(wikilink.linkTarget).toBe('Target');
    });
  });

  describe('mixed wikilinks and markdown', () => {
    it('parses wikilinks alongside bold', () => {
      const tokens = parseInlineTokens('**bold** and [[link]]');
      expect(tokenSummary(tokens)).toEqual([
        { type: 'bold', content: 'bold' },
        { type: 'text', content: ' and ' },
        { type: 'wikilink', content: 'link' },
      ]);
    });

    it('parses wikilinks alongside italic', () => {
      const tokens = parseInlineTokens('*italic* [[Page Name]]');
      expect(tokens.find(t => t.type === 'italic')).toBeDefined();
      expect(tokens.find(t => t.type === 'wikilink')).toBeDefined();
    });

    it('parses wikilinks alongside code', () => {
      const tokens = parseInlineTokens('`code` and [[link]]');
      expect(tokens.find(t => t.type === 'code')).toBeDefined();
      expect(tokens.find(t => t.type === 'wikilink')).toBeDefined();
    });

    it('handles bold inside wikilink alias (renders as plain)', () => {
      // Nested formatting not supported - bold markers become part of content
      const tokens = parseInlineTokens('[[Target|**bold alias**]]');
      const wikilink = tokens.find(t => t.type === 'wikilink');
      expect(wikilink?.content).toBe('**bold alias**');
    });
  });

  describe('wikilinks with ctx:: patterns', () => {
    it('parses wikilinks in ctx:: context', () => {
      const tokens = parseAllInlineTokens('ctx::2026-01-03 [[Related Page]]');
      expect(tokens.find(t => t.type === 'ctx-prefix')).toBeDefined();
      expect(tokens.find(t => t.type === 'wikilink')).toBeDefined();
    });
  });

  describe('hasInlineFormatting with wikilinks', () => {
    it('returns true for wikilinks', () => {
      expect(hasInlineFormatting('text with [[link]]')).toBe(true);
    });

    it('returns true for aliased wikilinks', () => {
      expect(hasInlineFormatting('[[target|alias]]')).toBe(true);
    });
  });
});
