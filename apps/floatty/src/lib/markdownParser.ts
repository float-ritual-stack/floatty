/**
 * Markdown → Block Tree Parser
 *
 * Converts markdown-structured output into hierarchical blocks.
 * Headings define parent/child relationships:
 *   # H1 → root level
 *   ## H2 → child of nearest H1
 *   ### H3 → child of nearest H2
 *   **Bold** → acts like H7 (list heading)
 *   - item → child of current context
 *   Content → child of nearest heading
 *
 * List indentation (2 spaces or 1 tab = 1 level):
 *   - top level     → level 8
 *     - indent 1    → level 9 (child of level 8)
 *       - indent 2  → level 10 (child of level 9)
 *
 * Logic ported from float-liner's parse_markdown_tree (Rust/pulldown_cmark)
 */

export interface ParsedBlock {
  content: string;
  children: ParsedBlock[];
}

/**
 * Detect if content has markdown structure worth parsing
 */
export function hasMarkdownStructure(content: string): boolean {
  // Check for headings, bold headings, or lists (bulleted, numbered, indented)
  return /^#{1,6}\s/m.test(content) ||
         /^\*\*[^*]+\*\*[:\s]*$/m.test(content) ||
         /^[-*]\s/m.test(content) ||
         /^\d+\.\s/m.test(content) ||
         /^[ \t]+[-*\d]/m.test(content);  // indented lists
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
 * Check if line is a list item and return its nesting level
 * Returns: 0 = not a list, 8+ = list item at indent level (8 = no indent, 9 = 1 level, etc.)
 *
 * Indentation: 2 spaces or 1 tab = 1 level
 * Stack uses 8+ for lists so they nest under headings (1-7)
 */
function getListLevel(line: string): number {
  const trimmed = line.trim();

  // Check if it's a list item at all
  if (!/^[-*]\s/.test(trimmed) && !/^\d+\.\s/.test(trimmed)) {
    return 0;
  }

  // Count leading whitespace to determine indent level
  // 2 spaces or 1 tab = 1 indent level
  let indent = 0;
  for (const char of line) {
    if (char === ' ') {
      indent++;
    } else if (char === '\t') {
      indent += 2;  // treat tab as 2 spaces
    } else {
      break;
    }
  }

  // Convert to indent levels (2 spaces = 1 level)
  const indentLevel = Math.floor(indent / 2);

  // Return 8 + indentLevel so lists nest properly under headings
  return 8 + indentLevel;
}

/**
 * Strip list prefix from line content
 */
function stripListPrefix(line: string): string {
  return line.trim()
    .replace(/^[-*]\s+/, '')      // - item or * item
    .replace(/^\d+\.\s+/, '');    // 1. item
}

/**
 * Parse markdown content into a tree of blocks based on heading hierarchy.
 * Returns flat list if no structure found, or nested structure if headings/lists present.
 */
export function parseMarkdownTree(content: string): ParsedBlock[] {
  // If no structure, return flat blocks per non-empty line
  if (!hasMarkdownStructure(content)) {
    return content
      .split('\n')
      .filter(line => line.trim())
      .map(line => ({ content: line, children: [] }));
  }

  const lines = content.split('\n');
  const rootBlocks: ParsedBlock[] = [];

  // Stack tracks: [{ level, block, isListParent }] where level 0 = root
  // Level 1-6 = # headings, Level 7 = bold headings, Level 8 = list context
  type StackEntry = { level: number; block: ParsedBlock };
  const stack: StackEntry[] = [{ level: 0, block: { content: '', children: rootBlocks } }];

  // Accumulate non-structural lines
  let pendingContent: string[] = [];

  const flushPending = () => {
    if (pendingContent.length === 0) return;

    const combinedContent = pendingContent.join('\n').trim();
    if (!combinedContent) {
      pendingContent = [];
      return;
    }

    // Add as child of current context
    const parent = stack[stack.length - 1].block;
    parent.children.push({ content: combinedContent, children: [] });
    pendingContent = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (pendingContent.length > 0) flushPending();
      continue;
    }

    const headingLevel = getHeadingLevel(line);

    if (headingLevel > 0) {
      // Flush pending content first
      flushPending();

      // Pop stack to find correct parent level
      while (stack.length > 1 && stack[stack.length - 1].level >= headingLevel) {
        stack.pop();
      }

      // Create the heading block
      const headingBlock: ParsedBlock = {
        content: trimmed,
        children: [],
      };

      // Add to parent's children
      const parent = stack[stack.length - 1].block;
      parent.children.push(headingBlock);

      // Push this heading onto stack as new context
      stack.push({ level: headingLevel, block: headingBlock });
    } else {
      const listLevel = getListLevel(line);

      if (listLevel > 0) {
        // Flush pending content first
        flushPending();

        const itemContent = stripListPrefix(line);
        const itemBlock: ParsedBlock = { content: itemContent, children: [] };

        // Pop stack to find correct parent for this indent level
        // listLevel is 8+ where 8 = no indent, 9 = 1 indent, etc.
        while (stack.length > 1 && stack[stack.length - 1].level >= listLevel) {
          stack.pop();
        }

        // Add to current context (parent at lower level)
        const parent = stack[stack.length - 1].block;
        parent.children.push(itemBlock);

        // Push onto stack so deeper items become children
        stack.push({ level: listLevel, block: itemBlock });
      } else {
        // Regular content - accumulate
        pendingContent.push(line);
      }
    }
  }

  // Flush any remaining content
  flushPending();

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
