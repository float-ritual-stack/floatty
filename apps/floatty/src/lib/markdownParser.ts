/**
 * Markdown → Block Tree Parser
 *
 * Converts markdown-structured output into hierarchical blocks.
 * Headings define parent/child relationships:
 *   # H1 → root level
 *   ## H2 → child of nearest H1
 *   ### H3 → child of nearest H2
 *   **Bold** → acts like H7 (list heading)
 *   Content → child of nearest heading
 *
 * Lists: a contiguous run of list lines becomes ONE block with the `- ` markers
 * and indentation preserved verbatim — list indentation does NOT create outline
 * hierarchy. (Markdown-list→outline-import is a different intent that deserves
 * an explicit command; see docs/design/2026-07-06-slurp-format-and-box-rendering.md.)
 *
 * Code fences: ``` blocks are isolated into their own block, fence markers
 * included, body verbatim (blank lines preserved).
 *
 * Leaf blocks (paragraph / list run / fence) get a trailing blank line
 * (BLOCK_SEPARATOR) for visual separation in the outline. Headings don't —
 * they get their weight from rendering and their children sit below anyway.
 *
 * Originally ported from float-liner's parse_markdown_tree (Rust/pulldown_cmark).
 */

export interface ParsedBlock {
  content: string;
  children: ParsedBlock[];
}

/**
 * Detect if content has markdown structure worth parsing
 */
export function hasMarkdownStructure(content: string): boolean {
  // Check for headings, bold headings, lists (bulleted, numbered, indented),
  // or fenced code blocks
  return /^#{1,6}\s/m.test(content) ||
         /^\*\*[^*]+\*\*[:\s]*$/m.test(content) ||
         /^[-*]\s/m.test(content) ||
         /^\d+\.\s/m.test(content) ||
         /^[ \t]+[-*\d]/m.test(content) ||  // indented lists
         /^```/m.test(content);             // fenced code blocks
}

/**
 * Extract heading level from a line (returns 0 if not a heading)
 * Regular headings: 1-6
 * Bold text alone on line (with optional trailing :): 7 (acts as list heading)
 */
function getHeadingLevel(line: string): number {
  const trimmed = line.trim();

  // Check for # headings first
  const hashMatch = trimmed.match(/^(#{1,6})\s/);
  if (hashMatch) return hashMatch[1].length;

  // Check for bold text alone on line (list heading) - level 7
  // Allow trailing colon/punctuation: **Fixes delivered**: or **Fixes delivered**
  if (/^\*\*[^*]+\*\*[:\s]*$/.test(trimmed) || /^__[^_]+__[:\s]*$/.test(trimmed)) {
    return 7;
  }

  return 0;
}

/**
 * Check if a line is a list item (bulleted or numbered), at any indentation.
 */
function isListLine(line: string): boolean {
  const trimmed = line.trim();
  return /^[-*]\s/.test(trimmed) || /^\d+\.\s/.test(trimmed);
}

/**
 * Nested-list mode only: list nesting level from indentation.
 * Returns 8+ so list items nest under headings (levels 1-7).
 * 2 spaces or 1 tab = 1 indent level.
 */
function getListLevel(line: string): number {
  let indent = 0;
  for (const char of line) {
    if (char === ' ') {
      indent++;
    } else if (char === '\t') {
      indent += 2; // treat tab as 2 spaces
    } else {
      break;
    }
  }
  return 8 + Math.floor(indent / 2);
}

/**
 * Nested-list mode only: strip the list marker from a line.
 */
function stripListPrefix(line: string): string {
  return line.trim()
    .replace(/^[-*]\s+/, '')      // - item or * item
    .replace(/^\d+\.\s+/, '');    // 1. item
}

/**
 * Trailing separator appended to leaf blocks (paragraph / list run / fence)
 * so slurped content gets visual breathing room in the outline. Literal
 * list mode only.
 */
const BLOCK_SEPARATOR = '\n\n';

export interface ParseMarkdownOptions {
  /**
   * 'literal' (default): a contiguous run of list lines becomes ONE block with
   * markers + indentation verbatim, and leaf blocks get a trailing blank line.
   * The slurp behavior — paste, sh::, help::.
   *
   * 'nested': legacy import semantics — each list item is its own block,
   * marker stripped, indentation becomes outline hierarchy, no separators.
   * For paths where nested bullets ENCODE tree depth: echoCopy:: door
   * materialization round-trips flattenSpecToMarkdown output through this.
   */
  lists?: 'literal' | 'nested';
}

/**
 * Parse markdown content into a tree of blocks based on heading hierarchy.
 * Returns flat list if no structure found, or nested structure if headings present.
 * List runs and code fences each become a single leaf block (see module header),
 * unless `lists: 'nested'` requests legacy item-per-block import semantics.
 */
export function parseMarkdownTree(content: string, options?: ParseMarkdownOptions): ParsedBlock[] {
  // If no structure, return flat blocks per non-empty line
  if (!hasMarkdownStructure(content)) {
    return content
      .split('\n')
      .filter(line => line.trim())
      .map(line => ({ content: line, children: [] }));
  }

  const nestedLists = options?.lists === 'nested';
  const separator = nestedLists ? '' : BLOCK_SEPARATOR;

  const lines = content.split('\n');
  const rootBlocks: ParsedBlock[] = [];

  // Stack tracks context: level 0 = root, 1-6 = # headings, 7 = bold headings,
  // 8+ = list items (nested mode only)
  type StackEntry = { level: number; block: ParsedBlock };
  const stack: StackEntry[] = [{ level: 0, block: { content: '', children: rootBlocks } }];

  // Three accumulators; at most one is non-empty at a time.
  let pendingContent: string[] = []; // prose paragraph
  let pendingList: string[] = []; // contiguous run of list lines, verbatim (literal mode)
  let fenceLines: string[] | null = null; // non-null = inside a ``` fence

  const pushLeaf = (text: string) => {
    const parent = stack[stack.length - 1].block;
    parent.children.push({ content: text + separator, children: [] });
  };

  const flushPending = () => {
    if (pendingContent.length === 0) return;
    const combined = pendingContent.join('\n').trim();
    pendingContent = [];
    if (combined) pushLeaf(combined);
  };

  const flushList = () => {
    if (pendingList.length === 0) return;
    const combined = pendingList.join('\n');
    pendingList = [];
    pushLeaf(combined);
  };

  const flushFence = () => {
    if (fenceLines === null) return;
    const combined = fenceLines.join('\n');
    fenceLines = null;
    pushLeaf(combined);
  };

  for (const line of lines) {
    const trimmed = line.trim();

    // Inside a fence: accumulate verbatim (blank lines included) until closing ```
    if (fenceLines !== null) {
      fenceLines.push(line);
      if (trimmed.startsWith('```')) flushFence();
      continue;
    }

    // Fence opens: isolate it from whatever was accumulating
    if (trimmed.startsWith('```')) {
      flushPending();
      flushList();
      fenceLines = [line];
      continue;
    }

    if (!trimmed) {
      flushPending();
      flushList();
      continue;
    }

    const headingLevel = getHeadingLevel(line);

    if (headingLevel > 0) {
      flushPending();
      flushList();

      // Pop stack to find correct parent level
      while (stack.length > 1 && stack[stack.length - 1].level >= headingLevel) {
        stack.pop();
      }

      const headingBlock: ParsedBlock = { content: trimmed, children: [] };
      const parent = stack[stack.length - 1].block;
      parent.children.push(headingBlock);
      stack.push({ level: headingLevel, block: headingBlock });
    } else if (isListLine(line)) {
      flushPending();

      if (nestedLists) {
        // Legacy import semantics: item-per-block, marker stripped,
        // indentation → hierarchy via the stack
        const listLevel = getListLevel(line);
        const itemBlock: ParsedBlock = { content: stripListPrefix(line), children: [] };

        while (stack.length > 1 && stack[stack.length - 1].level >= listLevel) {
          stack.pop();
        }

        const parent = stack[stack.length - 1].block;
        parent.children.push(itemBlock);
        stack.push({ level: listLevel, block: itemBlock });
      } else {
        // Literal: a list run interrupts prose; markers + indentation verbatim
        pendingList.push(line.trimEnd());
      }
    } else {
      // Prose interrupts a list run
      flushList();
      pendingContent.push(line);
    }
  }

  flushPending();
  flushList();
  flushFence(); // unclosed fence at EOF still lands as its own block

  return rootBlocks;
}

/**
 * Clean up tacky emojis with tasteful alternatives
 * (Ported from float-liner's detackify)
 */
export function detackify(content: string): string {
  return content
    // Checkmarks → ◆
    .replace(/✅/g, '◆')
    .replace(/☑️/g, '◆')
    .replace(/✔️/g, '◆')
    // X marks → ◇
    .replace(/❌/g, '◇')
    .replace(/❎/g, '◇')
    .replace(/⛔/g, '◇')
    .replace(/🚫/g, '◇')
    // Warning → △
    .replace(/⚠️/g, '△')
    // Colored circles → ●
    .replace(/🔴/g, '●')
    .replace(/🟢/g, '●')
    .replace(/🟡/g, '●')
    // Memo/pin → »
    .replace(/📝/g, '»')
    .replace(/📌/g, '»')
    // Lightbulb → ◊
    .replace(/💡/g, '◊')
    // Target → ›
    .replace(/🎯/g, '›')
    // Rocket → →
    .replace(/🚀/g, '→');
}
