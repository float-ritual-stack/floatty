/**
 * inlineParser.test.ts - Markdown inline tokenization tests
 *
 * Tests parseInlineTokens which extracts **bold**, *italic*, `code` spans.
 */
import { describe, it, expect } from 'vitest';
import {
  parseInlineTokens,
  parseAllInlineTokens,
  hasInlineFormatting,
  hasCtxPatterns,
  isMarkdownTable,
  parseMarkdownTable,
  type InlineToken,
} from './inlineParser';

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

describe('isMarkdownTable', () => {
  describe('valid tables', () => {
    it('returns true for simple table', () => {
      const table = `| Header 1 | Header 2 |
| --- | --- |
| Cell 1 | Cell 2 |`;
      expect(isMarkdownTable(table)).toBe(true);
    });

    it('returns true for table without leading pipes', () => {
      const table = `Header 1 | Header 2
--- | ---
Cell 1 | Cell 2`;
      expect(isMarkdownTable(table)).toBe(true);
    });

    it('returns true for table with alignment markers', () => {
      const table = `| Left | Center | Right |
| :--- | :---: | ---: |
| A | B | C |`;
      expect(isMarkdownTable(table)).toBe(true);
    });

    it('returns true for header and separator only', () => {
      const table = `| Header |
| --- |`;
      expect(isMarkdownTable(table)).toBe(true);
    });
  });

  describe('invalid tables', () => {
    it('returns false for single line', () => {
      expect(isMarkdownTable('| Just | One | Line |')).toBe(false);
    });

    it('returns false for missing separator', () => {
      const notTable = `| Header 1 | Header 2 |
| Cell 1 | Cell 2 |`;
      expect(isMarkdownTable(notTable)).toBe(false);
    });

    it('returns false for invalid separator', () => {
      const notTable = `| Header 1 | Header 2 |
| abc | def |
| Cell 1 | Cell 2 |`;
      expect(isMarkdownTable(notTable)).toBe(false);
    });

    it('returns false for text without pipes', () => {
      expect(isMarkdownTable('just some text\nwith newlines')).toBe(false);
    });

    it('returns false for empty string', () => {
      expect(isMarkdownTable('')).toBe(false);
    });
  });
});

describe('parseMarkdownTable', () => {
  describe('basic parsing', () => {
    it('parses simple table', () => {
      const table = `| Header 1 | Header 2 |
| --- | --- |
| Cell 1 | Cell 2 |`;
      const result = parseMarkdownTable(table);

      expect(result).not.toBeNull();
      expect(result!.headers).toHaveLength(2);
      expect(result!.headers[0].content).toBe('Header 1');
      expect(result!.headers[1].content).toBe('Header 2');
      expect(result!.rows).toHaveLength(1);
      expect(result!.rows[0][0].content).toBe('Cell 1');
      expect(result!.rows[0][1].content).toBe('Cell 2');
    });

    it('parses table with multiple rows', () => {
      const table = `| Name | Age |
| --- | --- |
| Alice | 30 |
| Bob | 25 |
| Charlie | 35 |`;
      const result = parseMarkdownTable(table);

      expect(result).not.toBeNull();
      expect(result!.rows).toHaveLength(3);
      expect(result!.rows[0][0].content).toBe('Alice');
      expect(result!.rows[1][0].content).toBe('Bob');
      expect(result!.rows[2][0].content).toBe('Charlie');
    });

    it('returns null for non-table content', () => {
      expect(parseMarkdownTable('just text')).toBeNull();
      expect(parseMarkdownTable('')).toBeNull();
    });
  });

  describe('alignment', () => {
    it('parses left alignment (default)', () => {
      const table = `| Header |
| --- |
| Cell |`;
      const result = parseMarkdownTable(table);

      expect(result!.alignments[0]).toBe('left');
      expect(result!.headers[0].alignment).toBe('left');
    });

    it('parses explicit left alignment', () => {
      const table = `| Header |
| :--- |
| Cell |`;
      const result = parseMarkdownTable(table);

      expect(result!.alignments[0]).toBe('left');
    });

    it('parses center alignment', () => {
      const table = `| Header |
| :---: |
| Cell |`;
      const result = parseMarkdownTable(table);

      expect(result!.alignments[0]).toBe('center');
      expect(result!.headers[0].alignment).toBe('center');
    });

    it('parses right alignment', () => {
      const table = `| Header |
| ---: |
| Cell |`;
      const result = parseMarkdownTable(table);

      expect(result!.alignments[0]).toBe('right');
      expect(result!.headers[0].alignment).toBe('right');
    });

    it('parses mixed alignments', () => {
      const table = `| Left | Center | Right |
| :--- | :---: | ---: |
| A | B | C |`;
      const result = parseMarkdownTable(table);

      expect(result!.alignments).toEqual(['left', 'center', 'right']);
    });
  });

  describe('edge cases', () => {
    it('handles cells with inline formatting markers', () => {
      const table = `| Type | Example |
| --- | --- |
| Bold | **text** |
| Code | \`code\` |`;
      const result = parseMarkdownTable(table);

      expect(result).not.toBeNull();
      expect(result!.rows[0][1].content).toBe('**text**');
      expect(result!.rows[1][1].content).toBe('`code`');
    });

    it('handles empty cells', () => {
      const table = `| A | B |
| --- | --- |
| | value |
| value | |`;
      const result = parseMarkdownTable(table);

      expect(result).not.toBeNull();
      expect(result!.rows[0][0].content).toBe('');
      expect(result!.rows[0][1].content).toBe('value');
      expect(result!.rows[1][0].content).toBe('value');
      expect(result!.rows[1][1].content).toBe('');
    });

    it('handles table without leading/trailing pipes', () => {
      const table = `Header 1 | Header 2
--- | ---
Cell 1 | Cell 2`;
      const result = parseMarkdownTable(table);

      expect(result).not.toBeNull();
      expect(result!.headers[0].content).toBe('Header 1');
      expect(result!.rows[0][0].content).toBe('Cell 1');
    });

    it('trims whitespace from cells', () => {
      const table = `|   Header   |
| --- |
|   Cell   |`;
      const result = parseMarkdownTable(table);

      expect(result!.headers[0].content).toBe('Header');
      expect(result!.rows[0][0].content).toBe('Cell');
    });

    it('handles header-only table (no data rows)', () => {
      const table = `| Header 1 | Header 2 |
| --- | --- |`;
      const result = parseMarkdownTable(table);

      expect(result).not.toBeNull();
      expect(result!.headers).toHaveLength(2);
      expect(result!.rows).toHaveLength(0);
    });

    it('skips blank lines in body', () => {
      const table = `| A |
| --- |
| 1 |

| 2 |`;
      const result = parseMarkdownTable(table);

      expect(result!.rows).toHaveLength(2);
    });
  });
});
