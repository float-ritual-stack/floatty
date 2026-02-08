/**
 * inlineParser.test.ts - Markdown inline tokenization tests
 *
 * Tests parseInlineTokens which extracts **bold**, *italic*, `code` spans.
 */
import { describe, it, expect } from 'vitest';
import { parseInlineTokens, parseAllInlineTokens, hasInlineFormatting, hasCtxPatterns, hasCodeFencePatterns, hasTablePattern, hasBoxDrawingPattern, type InlineToken } from './inlineParser';

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

  it('returns false for mid-line ctx:: without bracket exception', () => {
    expect(hasInlineFormatting('talking about ctx:: in general')).toBe(false);
  });

  it('returns true for bracketed word:: prefix anywhere', () => {
    expect(hasInlineFormatting('notes [ctx::topic] more')).toBe(true);
  });
});

describe('prefix-marker semantics', () => {
  it('parses bracketed prefix marker at line start', () => {
    const tokens = parseAllInlineTokens('[sc::');
    expect(tokens.some(t => t.type === 'prefix-marker' && t.raw === 'sc::')).toBe(true);
  });

  it('parses bracketed prefix marker mid-line', () => {
    const tokens = parseAllInlineTokens('foo [sc::bar]');
    expect(tokens.some(t => t.type === 'prefix-marker' && t.raw === 'sc::')).toBe(true);
  });

  it('does not parse unbracketed mid-line word:: marker', () => {
    const tokens = parseAllInlineTokens('foo sc::bar');
    expect(tokens.some(t => t.type === 'prefix-marker')).toBe(false);
  });

  it('keeps heading + bracketed prefix visible and tokenized', () => {
    const tokens = parseAllInlineTokens('## [sc::');
    expect(tokens.some(t => t.type === 'heading-marker')).toBe(true);
    expect(tokens.some(t => t.type === 'prefix-marker' && t.raw === 'sc::')).toBe(true);
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

// ctx::2026-01-04 @ 11:57 AM [project::floatty] [mode::build] wikilink parser tests
describe('wikilink parsing', () => {
  describe('basic patterns', () => {
    it('parses [[Simple]] wikilink', () => {
      const tokens = parseAllInlineTokens('check [[Simple]] page');
      expect(tokens.find(t => t.type === 'wikilink')).toBeDefined();
      const wikilink = tokens.find(t => t.type === 'wikilink')!;
      expect(wikilink.target).toBe('Simple');
      expect(wikilink.content).toBe('Simple');
      expect(wikilink.raw).toBe('[[Simple]]');
    });

    it('parses [[Target|Alias]] with display alias', () => {
      const tokens = parseAllInlineTokens('see [[Project Alpha|the project]]');
      const wikilink = tokens.find(t => t.type === 'wikilink')!;
      expect(wikilink.target).toBe('Project Alpha');
      expect(wikilink.content).toBe('the project');
      expect(wikilink.raw).toBe('[[Project Alpha|the project]]');
    });

    it('parses [[Multi Word Page]] names', () => {
      const tokens = parseAllInlineTokens('[[Multi Word Page]]');
      const wikilink = tokens.find(t => t.type === 'wikilink')!;
      expect(wikilink.target).toBe('Multi Word Page');
    });

    it('parses multiple wikilinks in same content', () => {
      const tokens = parseAllInlineTokens('link [[A]] and [[B]] here');
      const wikilinks = tokens.filter(t => t.type === 'wikilink');
      expect(wikilinks).toHaveLength(2);
      expect(wikilinks[0].target).toBe('A');
      expect(wikilinks[1].target).toBe('B');
    });
  });

  describe('edge cases', () => {
    it('ignores empty [[]] brackets', () => {
      const tokens = parseAllInlineTokens('empty [[]] should not match');
      const wikilinks = tokens.filter(t => t.type === 'wikilink');
      expect(wikilinks).toHaveLength(0);
    });

    it('handles wikilink at start of content', () => {
      const tokens = parseAllInlineTokens('[[Start]] of line');
      expect(tokens[0].type).toBe('wikilink');
    });

    it('handles wikilink at end of content', () => {
      const tokens = parseAllInlineTokens('end of [[Line]]');
      const wikilinks = tokens.filter(t => t.type === 'wikilink');
      expect(wikilinks).toHaveLength(1);
      expect(wikilinks[0].target).toBe('Line');
    });

    it('trims whitespace from target and alias', () => {
      const tokens = parseAllInlineTokens('[[  spaced  |  alias  ]]');
      const wikilink = tokens.find(t => t.type === 'wikilink')!;
      expect(wikilink.target).toBe('spaced');
      expect(wikilink.content).toBe('alias');
    });
  });

  describe('mixed with other formatting', () => {
    it('parses wikilink with **bold** text around it', () => {
      const tokens = parseAllInlineTokens('**bold** and [[link]]');
      expect(tokens.find(t => t.type === 'bold')).toBeDefined();
      expect(tokens.find(t => t.type === 'wikilink')).toBeDefined();
    });

    it('parses wikilink with ctx:: markers', () => {
      const input = '[[My Page]] - ctx::2026-01-04 [project::floatty]';
      const tokens = parseAllInlineTokens(input);
      expect(tokens.find(t => t.type === 'wikilink')).toBeDefined();
      expect(tokens.find(t => t.type === 'ctx-prefix')).toBeDefined();
      expect(tokens.find(t => t.type === 'ctx-tag')).toBeDefined();
    });

    it('wikilinks take priority (highest precedence)', () => {
      // Wikilinks should be extracted first, before other patterns
      const tokens = parseAllInlineTokens('see [[Page]] and **bold**');
      const types = tokens.map(t => t.type);
      // Wikilink should appear before bold in token order
      const wikilinkIdx = types.indexOf('wikilink');
      const boldIdx = types.indexOf('bold');
      expect(wikilinkIdx).toBeLessThan(boldIdx);
    });
  });

  describe('position tracking', () => {
    it('tracks start/end positions correctly', () => {
      const tokens = parseAllInlineTokens('abc [[link]] xyz');
      const wikilink = tokens.find(t => t.type === 'wikilink')!;
      expect(wikilink.start).toBe(4);  // After "abc "
      expect(wikilink.end).toBe(12);   // After "[[link]]"
    });
  });

  describe('nested brackets', () => {
    it('handles [[meeting:: [[person]]]] nested wikilinks', () => {
      const tokens = parseAllInlineTokens('[[meeting:: [[nick <--> evan]]]]');
      const wikilinks = tokens.filter(t => t.type === 'wikilink');
      expect(wikilinks).toHaveLength(1);
      expect(wikilinks[0].target).toBe('meeting:: [[nick <--> evan]]');
      expect(wikilinks[0].raw).toBe('[[meeting:: [[nick <--> evan]]]]');
    });

    it('handles [[outer [[inner]]]] two levels deep', () => {
      const tokens = parseAllInlineTokens('see [[outer [[inner]]]] here');
      const wikilink = tokens.find(t => t.type === 'wikilink')!;
      expect(wikilink.target).toBe('outer [[inner]]');
    });

    it('handles [[a [[b [[c]]]]]] three levels deep', () => {
      const tokens = parseAllInlineTokens('[[a [[b [[c]]]]]]');
      const wikilink = tokens.find(t => t.type === 'wikilink')!;
      expect(wikilink.target).toBe('a [[b [[c]]]]');
    });

    it('handles nested with alias [[outer [[inner]]|display]]', () => {
      const tokens = parseAllInlineTokens('[[outer [[inner]]|display]]');
      const wikilink = tokens.find(t => t.type === 'wikilink')!;
      expect(wikilink.target).toBe('outer [[inner]]');
      expect(wikilink.content).toBe('display');
    });

    it('handles pipe inside nested brackets [[a|b [[c|d]]]]', () => {
      // Top-level pipe splits: target="a", but inner [[c|d]] is part of alias
      // Wait, no - the inner brackets protect the inner pipe
      // Actually: [[a|b [[c|d]]]] - first top-level | is at position 2
      // target = "a", alias = "b [[c|d]]"
      const tokens = parseAllInlineTokens('[[target|alias [[nested|stuff]]]]');
      const wikilink = tokens.find(t => t.type === 'wikilink')!;
      expect(wikilink.target).toBe('target');
      expect(wikilink.content).toBe('alias [[nested|stuff]]');
    });

    it('handles unbalanced opening bracket gracefully', () => {
      // [[missing close - should not crash, skip the unbalanced link
      const tokens = parseAllInlineTokens('[[missing close and [[valid]]');
      // The first [[ is unbalanced so it should be skipped
      // [[valid]] should still be found
      const wikilinks = tokens.filter(t => t.type === 'wikilink');
      expect(wikilinks).toHaveLength(1);
      expect(wikilinks[0].target).toBe('valid');
    });

    it('handles multiple nested wikilinks in same line', () => {
      const tokens = parseAllInlineTokens('[[a [[b]]]] and [[c [[d]]]]');
      const wikilinks = tokens.filter(t => t.type === 'wikilink');
      expect(wikilinks).toHaveLength(2);
      expect(wikilinks[0].target).toBe('a [[b]]');
      expect(wikilinks[1].target).toBe('c [[d]]');
    });

    it('preserves text between nested wikilinks', () => {
      const tokens = parseAllInlineTokens('start [[a [[b]]]] middle [[c]] end');
      const text = tokens.filter(t => t.type === 'text').map(t => t.content).join('');
      expect(text).toBe('start  middle  end');
    });
  });

  describe('code fence parsing', () => {
    it('detects code fence patterns', () => {
      expect(hasCodeFencePatterns('```js\ncode\n```')).toBe(true);
      expect(hasCodeFencePatterns('no fence here')).toBe(false);
      expect(hasCodeFencePatterns('```')).toBe(false);  // Single fence = not valid
    });

    it('parses basic fenced code block', () => {
      const tokens = parseAllInlineTokens('```js\nconst x = 1;\n```');
      expect(tokens).toHaveLength(1);
      expect(tokens[0].type).toBe('code-fence');
      expect(tokens[0].lang).toBe('js');
    });

    it('parses adjacent fences', () => {
      const tokens = parseAllInlineTokens('```a\ncode1\n```\n```b\ncode2\n```');
      const fences = tokens.filter(t => t.type === 'code-fence');
      expect(fences).toHaveLength(2);
    });

    it('unclosed fence is not detected as code fence pattern', () => {
      // hasCodeFencePatterns requires 2 fences, unclosed = no pattern detected
      expect(hasCodeFencePatterns('```js\nno closing')).toBe(false);
      const tokens = parseAllInlineTokens('```js\nno closing');
      expect(tokens).toHaveLength(0); // No inline patterns detected
    });

    it('parses empty fence', () => {
      const tokens = parseAllInlineTokens('```\n```');
      expect(tokens[0].type).toBe('code-fence');
      expect(tokens[0].lang).toBe('');
    });

    it('parses fence with text before and after', () => {
      const tokens = parseAllInlineTokens('before\n```js\ncode\n```\nafter');
      expect(tokens.some(t => t.type === 'code-fence')).toBe(true);
      expect(tokens.some(t => t.type === 'text' && t.content.includes('before'))).toBe(true);
    });

    it('preserves code content in fence', () => {
      const tokens = parseAllInlineTokens('```rust\nfn main() {\n  println!("hello");\n}\n```');
      const fence = tokens.find(t => t.type === 'code-fence');
      expect(fence?.code).toContain('fn main()');
      expect(fence?.lang).toBe('rust');
    });
  });

  describe('line comments', () => {
    it('parses // comment lines', () => {
      const tokens = parseInlineTokens('// this is a comment');
      expect(tokens).toHaveLength(1);
      expect(tokens[0].type).toBe('line-comment');
      expect(tokens[0].commentPrefix).toBe('//');
      expect(tokens[0].content).toBe('this is a comment');
    });

    it('parses %% comment lines', () => {
      const tokens = parseInlineTokens('%% obsidian style comment');
      expect(tokens[0].type).toBe('line-comment');
      expect(tokens[0].commentPrefix).toBe('%%');
    });

    it('parses -- comment lines', () => {
      const tokens = parseInlineTokens('-- sql style comment');
      expect(tokens[0].type).toBe('line-comment');
      expect(tokens[0].commentPrefix).toBe('--');
    });

    it('does NOT parse # as comment (it is markdown heading, needs wikilinks inside)', () => {
      // # is markdown heading, not a comment - wikilinks must parse inside
      const tokens = parseInlineTokens('# shell style comment');
      expect(tokens[0].type).not.toBe('line-comment');
    });

    it('strips bullet prefix before detecting comment', () => {
      const tokens = parseInlineTokens('- // bulleted comment');
      expect(tokens[0].type).toBe('line-comment');
    });

    it('does not match // mid-line as comment', () => {
      const tokens = parseInlineTokens('some text // not a comment');
      expect(tokens[0].type).not.toBe('line-comment');
    });
  });

  describe('filter functions', () => {
    it('parses include() pattern', () => {
      const tokens = parseInlineTokens('include(project::floatty)');
      expect(tokens).toHaveLength(1);
      expect(tokens[0].type).toBe('filter-function');
      expect(tokens[0].functionName).toBe('include');
    });

    it('parses exclude() pattern', () => {
      const tokens = parseInlineTokens('exclude(status::archived)');
      expect(tokens[0].type).toBe('filter-function');
      expect(tokens[0].functionName).toBe('exclude');
    });

    it('handles case insensitivity', () => {
      const tokens = parseInlineTokens('INCLUDE(marker::*)');
      expect(tokens[0].type).toBe('filter-function');
      expect(tokens[0].functionName).toBe('include');
    });

    it('strips bullet prefix before detecting function', () => {
      const tokens = parseInlineTokens('- include(mode::test)');
      expect(tokens[0].type).toBe('filter-function');
    });

    it('does not match include() as part of sentence', () => {
      const tokens = parseInlineTokens('use include(foo) here');
      expect(tokens[0].type).not.toBe('filter-function');
    });
  });

  describe('hasInlineFormatting() gatekeeper', () => {
    it('returns true for line comments', () => {
      expect(hasInlineFormatting('// comment')).toBe(true);
      expect(hasInlineFormatting('%% comment')).toBe(true);
      expect(hasInlineFormatting('-- comment')).toBe(true);
      // Note: # is NOT a comment - it's markdown heading (needs wikilinks inside)
    });

    it('returns true for filter functions', () => {
      expect(hasInlineFormatting('include(marker::test)')).toBe(true);
      expect(hasInlineFormatting('exclude(status::archived)')).toBe(true);
    });

    it('returns false for plain text', () => {
      expect(hasInlineFormatting('just some text')).toBe(false);
    });

    it('returns true for other formatting patterns', () => {
      expect(hasInlineFormatting('**bold**')).toBe(true);
      expect(hasInlineFormatting('`code`')).toBe(true);
      expect(hasInlineFormatting('ctx::2025-12-15')).toBe(true);  // ctx:: needs timestamp format
      expect(hasInlineFormatting('[[wikilink]]')).toBe(true);
    });

    it('returns true for filter:: prefix', () => {
      expect(hasInlineFormatting('filter::test')).toBe(true);
      expect(hasInlineFormatting('Filter::Test')).toBe(true);
    });
  });

  describe('filter:: prefix parsing', () => {
    it('parses filter:: prefix', () => {
      const tokens = parseInlineTokens('filter::why');
      expect(tokens).toHaveLength(2);
      expect(tokens[0].type).toBe('filter-prefix');
      expect(tokens[0].raw).toBe('filter::');
      expect(tokens[1].type).toBe('text');
      expect(tokens[1].raw).toBe('why');
    });

    it('parses filter:: prefix alone', () => {
      const tokens = parseInlineTokens('filter::');
      expect(tokens).toHaveLength(1);
      expect(tokens[0].type).toBe('filter-prefix');
    });
  });
});

// FLO-58: Markdown table parsing
describe('markdown table parsing', () => {
  describe('hasTablePattern', () => {
    it('returns true for valid markdown table', () => {
      const table = `| Header 1 | Header 2 |
|----------|----------|
| Cell 1   | Cell 2   |`;
      expect(hasTablePattern(table)).toBe(true);
    });

    it('returns false for single line', () => {
      expect(hasTablePattern('| Header 1 | Header 2 |')).toBe(false);
    });

    it('returns false for missing pipe prefix', () => {
      const table = `Header 1 | Header 2 |
|----------|----------|`;
      expect(hasTablePattern(table)).toBe(false);
    });

    it('returns false for missing separator', () => {
      const table = `| Header 1 | Header 2 |
| Cell 1   | Cell 2   |`;
      expect(hasTablePattern(table)).toBe(false);
    });

    it('returns true for table with alignment markers', () => {
      const table = `| Left | Center | Right |
|:-----|:------:|------:|
| L    | C      | R     |`;
      expect(hasTablePattern(table)).toBe(true);
    });

    it('returns false for plain text', () => {
      expect(hasTablePattern('just some text')).toBe(false);
    });
  });

  describe('parseAllInlineTokens for tables', () => {
    it('parses basic table', () => {
      const table = `| A | B |
|---|---|
| 1 | 2 |`;
      const tokens = parseAllInlineTokens(table);
      expect(tokens).toHaveLength(1);
      expect(tokens[0].type).toBe('table');
    });

    it('extracts headers', () => {
      const table = `| Name | Age |
|------|-----|
| Bob  | 30  |`;
      const tokens = parseAllInlineTokens(table);
      const tableToken = tokens[0];
      expect(tableToken.headers).toEqual(['Name', 'Age']);
    });

    it('extracts rows', () => {
      const table = `| A | B |
|---|---|
| 1 | 2 |
| 3 | 4 |`;
      const tokens = parseAllInlineTokens(table);
      const tableToken = tokens[0];
      expect(tableToken.rows).toEqual([['1', '2'], ['3', '4']]);
    });

    it('parses left alignment (default)', () => {
      const table = `| Col |
|-----|
| X   |`;
      const tokens = parseAllInlineTokens(table);
      expect(tokens[0].alignments).toEqual(['left']);
    });

    it('parses center alignment', () => {
      const table = `| Col |
|:---:|
| X   |`;
      const tokens = parseAllInlineTokens(table);
      expect(tokens[0].alignments).toEqual(['center']);
    });

    it('parses right alignment', () => {
      const table = `| Col |
|----:|
| X   |`;
      const tokens = parseAllInlineTokens(table);
      expect(tokens[0].alignments).toEqual(['right']);
    });

    it('parses mixed alignments', () => {
      const table = `| L | C | R |
|:--|:-:|--:|
| 1 | 2 | 3 |`;
      const tokens = parseAllInlineTokens(table);
      expect(tokens[0].alignments).toEqual(['left', 'center', 'right']);
    });

    it('handles table with no data rows', () => {
      const table = `| Header |
|--------|`;
      const tokens = parseAllInlineTokens(table);
      expect(tokens[0].type).toBe('table');
      expect(tokens[0].headers).toEqual(['Header']);
      expect(tokens[0].rows).toEqual([]);
    });

    it('trims whitespace from cells', () => {
      const table = `|   Header   |
|------------|
|   Value    |`;
      const tokens = parseAllInlineTokens(table);
      expect(tokens[0].headers).toEqual(['Header']);
      expect(tokens[0].rows).toEqual([['Value']]);
    });

    it('preserves raw content', () => {
      const table = `| A | B |
|---|---|
| 1 | 2 |`;
      const tokens = parseAllInlineTokens(table);
      expect(tokens[0].raw).toBe(table);
    });
  });

  describe('hasInlineFormatting includes tables', () => {
    it('returns true for table content', () => {
      const table = `| A | B |
|---|---|
| 1 | 2 |`;
      expect(hasInlineFormatting(table)).toBe(true);
    });
  });

  describe('pipe escaping', () => {
    it('handles escaped pipes in cell content', () => {
      // Pipes escaped as \| should be treated as literal pipe in cell
      const table = `| Header |
|--------|
| a \\| b |`;
      const tokens = parseAllInlineTokens(table);
      expect(tokens[0].rows).toEqual([['a | b']]);
    });

    it('handles escaped pipes in headers', () => {
      const table = `| A \\| B |
|--------|
| val |`;
      const tokens = parseAllInlineTokens(table);
      expect(tokens[0].headers).toEqual(['A | B']);
    });

    it('handles multiple escaped pipes in one cell', () => {
      const table = `| Col |
|-----|
| a \\| b \\| c |`;
      const tokens = parseAllInlineTokens(table);
      expect(tokens[0].rows).toEqual([['a | b | c']]);
    });

    it('handles mixed escaped and unescaped pipes', () => {
      const table = `| A | B |
|---|---|
| x \\| y | z |`;
      const tokens = parseAllInlineTokens(table);
      expect(tokens[0].rows).toEqual([['x | y', 'z']]);
    });
  });

  describe('box-drawing characters', () => {
    describe('hasBoxDrawingPattern', () => {
      it('detects heavy box chars (shade blocks)', () => {
        expect(hasBoxDrawingPattern('▒▓█░')).toBe(true);
      });

      it('detects double-line box chars', () => {
        expect(hasBoxDrawingPattern('╔═══╗')).toBe(true);
      });

      it('detects tree-drawing chars', () => {
        expect(hasBoxDrawingPattern('├── folder')).toBe(true);
      });

      it('returns false for plain text', () => {
        expect(hasBoxDrawingPattern('just text')).toBe(false);
      });
    });

    describe('parseAllInlineTokens - box drawing', () => {
      it('classifies shade blocks as box-heavy', () => {
        const tokens = parseAllInlineTokens('▒▓█░ header');
        expect(tokenSummary(tokens)).toEqual([
          { type: 'box-heavy', content: '▒▓█░' },
          { type: 'text', content: ' header' },
        ]);
      });

      it('classifies double-line borders as box-double', () => {
        const tokens = parseAllInlineTokens('╔═══╗');
        expect(tokenSummary(tokens)).toEqual([
          { type: 'box-double', content: '╔═══╗' },
        ]);
      });

      it('classifies tree chars as box-tree', () => {
        const tokens = parseAllInlineTokens('├── src/');
        expect(tokenSummary(tokens)).toEqual([
          { type: 'box-tree', content: '├──' },
          { type: 'text', content: ' src/' },
        ]);
      });

      it('handles mixed box types in one line', () => {
        const tokens = parseAllInlineTokens('▓▓ header ▓▓');
        const types = tokens.map(t => t.type);
        expect(types).toEqual(['box-heavy', 'text', 'box-heavy']);
      });

      it('preserves wikilinks inside box-drawing content', () => {
        const tokens = parseAllInlineTokens('├── [[my page]]');
        const types = tokens.map(t => t.type);
        expect(types).toContain('box-tree');
        expect(types).toContain('wikilink');
      });

      it('preserves bold inside box-drawing lines', () => {
        const tokens = parseAllInlineTokens('│ **important** │');
        const types = tokens.map(t => t.type);
        expect(types).toContain('box-tree');
        expect(types).toContain('bold');
      });

      it('handles The Gurgle style headers', () => {
        const tokens = parseAllInlineTokens('▓▓ float.dispatch/ (today\'s activity) ▓▓');
        expect(tokens[0].type).toBe('box-heavy');
        expect(tokens[tokens.length - 1].type).toBe('box-heavy');
      });

      it('finds heading after box-drawing chars (code fence content)', () => {
        const tokens = parseAllInlineTokens('│ ## Day Shape     │');
        const types = tokens.map(t => t.type);
        expect(types).toContain('box-tree');
        expect(types).toContain('heading-marker');
        const heading = tokens.find(t => t.type === 'heading-marker');
        expect(heading?.raw).toMatch(/##/);
      });

      it('finds bracketed prefix-marker after box-drawing chars (code fence content)', () => {
        const tokens = parseAllInlineTokens('│ [scratch::        │');
        const types = tokens.map(t => t.type);
        expect(types).toContain('box-tree');
        expect(types).toContain('prefix-marker');
        const prefix = tokens.find(t => t.type === 'prefix-marker');
        expect(prefix?.raw).toMatch(/scratch::/);
      });

      it('finds time + heading in box-framed content', () => {
        const tokens = parseAllInlineTokens('│ ## 08:00 - morning │');
        const types = tokens.map(t => t.type);
        expect(types).toContain('heading-marker');
        expect(types).toContain('time');
        expect(types).toContain('box-tree');
      });
    });
  });
});
