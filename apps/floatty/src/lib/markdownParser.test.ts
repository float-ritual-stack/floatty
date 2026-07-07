/**
 * markdownParser.test.ts - Markdown hierarchy parsing tests
 *
 * Tests parseMarkdownTree which converts markdown into nested block structure.
 * Also tests detackify for emoji cleanup.
 */
import { describe, it, expect } from 'vitest';
import { parseMarkdownTree, detackify, type ParsedBlock } from './markdownParser';

// Helper to extract content tree (for cleaner assertions)
// Currently unused but kept for future test debugging
interface ContentNode { content: string; children: ContentNode[] }
function _contentTree(blocks: ParsedBlock[]): ContentNode[] {
  return blocks.map(b => ({
    content: b.content,
    children: b.children.length > 0 ? _contentTree(b.children) : [],
  }));
}

// Flatten all content strings from tree
function allContent(blocks: ParsedBlock[]): string[] {
  const result: string[] = [];
  for (const block of blocks) {
    result.push(block.content);
    result.push(...allContent(block.children));
  }
  return result;
}

describe('parseMarkdownTree', () => {
  describe('flat content (no structure)', () => {
    it('returns flat blocks for plain text', () => {
      const result = parseMarkdownTree('line one\nline two\nline three');
      expect(result).toHaveLength(3);
      expect(result.every(b => b.children.length === 0)).toBe(true);
    });

    it('filters empty lines', () => {
      const result = parseMarkdownTree('first\n\nsecond\n\n\nthird');
      expect(result).toHaveLength(3);
      expect(allContent(result)).toEqual(['first', 'second', 'third']);
    });
  });

  describe('heading hierarchy', () => {
    it('creates children under headings', () => {
      const md = `# Title
Some content under title
More content`;
      const result = parseMarkdownTree(md);

      expect(result).toHaveLength(1);
      expect(result[0].content).toBe('# Title');
      expect(result[0].children).toHaveLength(1);
      expect(result[0].children[0].content).toBe('Some content under title\nMore content\n\n');
    });

    it('nests ## under #', () => {
      const md = `# H1
## H2
Content under H2`;
      const result = parseMarkdownTree(md);

      expect(result).toHaveLength(1);
      expect(result[0].content).toBe('# H1');

      const h2 = result[0].children[0];
      expect(h2.content).toBe('## H2');
      expect(h2.children[0].content).toBe('Content under H2\n\n');
    });

    it('nests ### under ## under #', () => {
      const md = `# H1
## H2
### H3
Deep content`;
      const result = parseMarkdownTree(md);

      const h3 = result[0].children[0].children[0];
      expect(h3.content).toBe('### H3');
      expect(h3.children[0].content).toBe('Deep content\n\n');
    });

    it('handles sibling headings', () => {
      const md = `# First
## Sub1
## Sub2`;
      const result = parseMarkdownTree(md);

      expect(result).toHaveLength(1);
      expect(result[0].children).toHaveLength(2);
      expect(result[0].children[0].content).toBe('## Sub1');
      expect(result[0].children[1].content).toBe('## Sub2');
    });

    it('handles multiple root headings', () => {
      const md = `# First
Content
# Second
More content`;
      const result = parseMarkdownTree(md);

      expect(result).toHaveLength(2);
      expect(result[0].content).toBe('# First');
      expect(result[1].content).toBe('# Second');
    });
  });

  describe('bold headings (level 7)', () => {
    it('treats bold line as heading', () => {
      const md = `**Section Title**
Content here`;
      const result = parseMarkdownTree(md);

      expect(result).toHaveLength(1);
      expect(result[0].content).toBe('**Section Title**');
      expect(result[0].children[0].content).toBe('Content here\n\n');
    });

    it('bold heading with trailing colon', () => {
      const md = `**Fixes delivered:**
- Fix one
- Fix two`;
      const result = parseMarkdownTree(md);

      expect(result).toHaveLength(1);
      expect(result[0].content).toBe('**Fixes delivered:**');
    });
  });

  describe('list parsing (one block per run, markers intact)', () => {
    it('keeps a list run as ONE child block with markers', () => {
      const md = `# Title
- item one
- item two`;
      const result = parseMarkdownTree(md);

      const h1 = result[0];
      expect(h1.children).toHaveLength(1);
      expect(h1.children[0].content).toBe('- item one\n- item two\n\n');
    });

    it('preserves the list marker', () => {
      const result = parseMarkdownTree('- bullet item');
      expect(result[0].content).toBe('- bullet item\n\n');
    });

    it('keeps indented lists as one literal block (no hierarchy)', () => {
      const md = `- parent
  - child
    - grandchild`;
      const result = parseMarkdownTree(md);

      expect(result).toHaveLength(1);
      expect(result[0].content).toBe('- parent\n  - child\n    - grandchild\n\n');
      expect(result[0].children).toEqual([]);
    });

    it('handles numbered lists as one block', () => {
      const md = `1. first
2. second`;
      const result = parseMarkdownTree(md);

      expect(result).toHaveLength(1);
      expect(result[0].content).toBe('1. first\n2. second\n\n');
    });

    it('handles asterisk bullets', () => {
      const result = parseMarkdownTree('* item');
      expect(result[0].content).toBe('* item\n\n');
    });

    it('blank line splits two list runs into two blocks', () => {
      const md = `- run one a
- run one b

- run two a`;
      const result = parseMarkdownTree(md);

      expect(result).toHaveLength(2);
      expect(result[0].content).toBe('- run one a\n- run one b\n\n');
      expect(result[1].content).toBe('- run two a\n\n');
    });

    it('list stays separate from the paragraph before it ([[ae840d8a]] shape)', () => {
      const md = `block of text yo yo yo

- list
- list

more text`;
      const result = parseMarkdownTree(md);

      expect(result).toHaveLength(3);
      expect(result[0].content).toBe('block of text yo yo yo\n\n');
      expect(result[1].content).toBe('- list\n- list\n\n');
      expect(result[2].content).toBe('more text\n\n');
    });

    it('prose line directly after a list ends the run', () => {
      const md = `- item
prose right after`;
      const result = parseMarkdownTree(md);

      expect(result).toHaveLength(2);
      expect(result[0].content).toBe('- item\n\n');
      expect(result[1].content).toBe('prose right after\n\n');
    });
  });

  describe('code fences', () => {
    it('isolates a fence into its own block, markers included', () => {
      const md = `intro text

\`\`\`js
const x = 1;
\`\`\`

outro text`;
      const result = parseMarkdownTree(md);

      expect(result).toHaveLength(3);
      expect(result[0].content).toBe('intro text\n\n');
      expect(result[1].content).toBe('```js\nconst x = 1;\n```\n\n');
      expect(result[2].content).toBe('outro text\n\n');
    });

    it('preserves blank lines and list-like lines inside a fence', () => {
      const md = `\`\`\`
- not a list

# not a heading
\`\`\``;
      const result = parseMarkdownTree(md);

      expect(result).toHaveLength(1);
      expect(result[0].content).toBe('```\n- not a list\n\n# not a heading\n```\n\n');
      expect(result[0].children).toEqual([]);
    });

    it('fence interrupts a list run', () => {
      const md = `- item
\`\`\`
code
\`\`\``;
      const result = parseMarkdownTree(md);

      expect(result).toHaveLength(2);
      expect(result[0].content).toBe('- item\n\n');
      expect(result[1].content).toBe('```\ncode\n```\n\n');
    });

    it('unclosed fence at EOF still becomes its own block', () => {
      const md = `# Title
\`\`\`sh
echo unterminated`;
      const result = parseMarkdownTree(md);

      expect(result).toHaveLength(1);
      expect(result[0].children).toHaveLength(1);
      expect(result[0].children[0].content).toBe('```sh\necho unterminated\n\n');
    });

    it('fence nests under the current heading', () => {
      const md = `## Section
\`\`\`
tree art
\`\`\``;
      const result = parseMarkdownTree(md);

      expect(result[0].content).toBe('## Section');
      expect(result[0].children[0].content).toBe('```\ntree art\n```\n\n');
    });
  });

  describe('nested-list mode (legacy import semantics — echoCopy:: path)', () => {
    it('item-per-block, markers stripped, indentation → hierarchy, no separators', () => {
      const md = `- parent
  - child
    - grandchild`;
      const result = parseMarkdownTree(md, { lists: 'nested' });

      expect(result).toHaveLength(1);
      expect(result[0].content).toBe('parent');
      expect(result[0].children[0].content).toBe('child');
      expect(result[0].children[0].children[0].content).toBe('grandchild');
    });

    it('paragraphs get no separator in nested mode', () => {
      const md = `# Title
Some content`;
      const result = parseMarkdownTree(md, { lists: 'nested' });

      expect(result[0].children[0].content).toBe('Some content');
    });
  });

  describe('mixed content', () => {
    it('combines headings and lists', () => {
      const md = `# Project
## Features
- Feature 1
- Feature 2
## Bugs
- Bug 1`;
      const result = parseMarkdownTree(md);

      expect(result).toHaveLength(1);
      const project = result[0];
      expect(project.content).toBe('# Project');

      const features = project.children[0];
      expect(features.content).toBe('## Features');
      expect(features.children).toHaveLength(1);
      expect(features.children[0].content).toBe('- Feature 1\n- Feature 2\n\n');

      const bugs = project.children[1];
      expect(bugs.content).toBe('## Bugs');
      expect(bugs.children).toHaveLength(1);
      expect(bugs.children[0].content).toBe('- Bug 1\n\n');
    });
  });

  describe('edge cases', () => {
    it('handles empty string', () => {
      expect(parseMarkdownTree('')).toEqual([]);
    });

    it('handles whitespace-only', () => {
      expect(parseMarkdownTree('   \n\n  ')).toEqual([]);
    });

    it('handles single heading', () => {
      const result = parseMarkdownTree('# Solo');
      expect(result).toHaveLength(1);
      expect(result[0].content).toBe('# Solo');
      expect(result[0].children).toEqual([]);
    });
  });
});

describe('detackify', () => {
  describe('checkmarks to diamond', () => {
    it('converts checkmarks to filled diamond', () => {
      expect(detackify('Done: ✅')).toBe('Done: ◆');
      expect(detackify('☑️ Complete')).toBe('◆ Complete');
      expect(detackify('✔️')).toBe('◆');
    });
  });

  describe('x marks to empty diamond', () => {
    it('converts x marks to empty diamond', () => {
      expect(detackify('Failed: ❌')).toBe('Failed: ◇');
      expect(detackify('❎ No')).toBe('◇ No');
      expect(detackify('⛔ Blocked')).toBe('◇ Blocked');
      expect(detackify('🚫 Forbidden')).toBe('◇ Forbidden');
    });
  });

  describe('warning to triangle', () => {
    it('converts warning to triangle', () => {
      expect(detackify('⚠️ Caution')).toBe('△ Caution');
    });
  });

  describe('colored circles to bullet', () => {
    it('converts colored circles to bullet', () => {
      expect(detackify('🔴 Red')).toBe('● Red');
      expect(detackify('🟢 Green')).toBe('● Green');
      expect(detackify('🟡 Yellow')).toBe('● Yellow');
    });
  });

  describe('misc emojis', () => {
    it('converts memo/pin to guillemet', () => {
      expect(detackify('📝 Note')).toBe('» Note');
      expect(detackify('📌 Pinned')).toBe('» Pinned');
    });

    it('converts lightbulb to lozenge', () => {
      expect(detackify('💡 Idea')).toBe('◊ Idea');
    });

    it('converts target to angle', () => {
      expect(detackify('🎯 Goal')).toBe('› Goal');
    });

    it('converts rocket to arrow', () => {
      expect(detackify('🚀 Launch')).toBe('→ Launch');
    });
  });

  describe('multiple replacements', () => {
    it('replaces all occurrences', () => {
      expect(detackify('✅ First ✅ Second')).toBe('◆ First ◆ Second');
    });

    it('handles mixed emojis', () => {
      expect(detackify('✅ Done ❌ Failed ⚠️ Warning'))
        .toBe('◆ Done ◇ Failed △ Warning');
    });
  });

  describe('edge cases', () => {
    it('returns unchanged text without emojis', () => {
      expect(detackify('plain text')).toBe('plain text');
    });

    it('handles empty string', () => {
      expect(detackify('')).toBe('');
    });

    it('preserves other emojis unchanged', () => {
      expect(detackify('Hello 👋 World')).toBe('Hello 👋 World');
    });
  });
});
