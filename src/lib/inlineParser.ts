/**
 * Inline Markdown Token Parser
 *
 * Parses inline formatting patterns for overlay display.
 * Returns tokens with both raw (with markers) and content (without markers).
 *
 * Display shows raw text but with styling on the content portion.
 */

export interface InlineToken {
  type: 'text' | 'bold' | 'italic' | 'code' | 'link' | 'ctx-prefix' | 'ctx-timestamp' | 'ctx-tag';
  content: string;  // inner text without markers
  raw: string;      // original text with markers (what we display)
  start: number;    // position in source string
  end: number;      // end position (for future selection sync)
  tagType?: string; // For ctx-tag: 'project', 'mode', 'issue', etc.
  linkTarget?: string; // For link: target page name
  linkAlias?: string; // For link: alias label
}

// ctx:: pattern: timestamp required to distinguish from abstract discussion
// Example: "ctx::2026-01-03 @ 02:50:24 AM [project::floatty]"

/**
 * Check if content contains ctx:: patterns worth parsing.
 */
export function hasCtxPatterns(content: string): boolean {
  return /ctx::\d{4}-\d{2}-\d{2}/.test(content);
}

/**
 * Parse ctx:: patterns into tokens.
 * Handles: ctx:: prefix, timestamps, and [key::value] tags.
 */
function parseCtxTokens(content: string): InlineToken[] {
  if (!hasCtxPatterns(content)) return [];

  const tokens: InlineToken[] = [];

  // Combined pattern that matches ctx components in order
  const COMBINED_CTX = /ctx::|\d{4}-\d{2}-\d{2}(?: ?@ ?\d{1,2}:\d{2}(?::\d{2})?(?: ?[AP]M)?)?|\[(project|mode|issue|repo|branch|meeting)::([^\]]+)\]/gi;

  let lastIndex = 0;
  for (const match of content.matchAll(COMBINED_CTX)) {
    const raw = match[0];
    const start = match.index ?? 0;
    const end = start + raw.length;

    // Add plain text before this match
    if (start > lastIndex) {
      const plainText = content.slice(lastIndex, start);
      tokens.push({
        type: 'text',
        content: plainText,
        raw: plainText,
        start: lastIndex,
        end: start,
      });
    }

    // Determine token type
    if (raw.toLowerCase() === 'ctx::') {
      tokens.push({
        type: 'ctx-prefix',
        content: raw,
        raw,
        start,
        end,
      });
    } else if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
      tokens.push({
        type: 'ctx-timestamp',
        content: raw,
        raw,
        start,
        end,
      });
    } else if (match[1]) {
      // [key::value] tag - match[1] is key, match[2] is value
      tokens.push({
        type: 'ctx-tag',
        content: match[2], // just the value
        raw,
        start,
        end,
        tagType: match[1].toLowerCase(),
      });
    }

    lastIndex = end;
  }

  // Add trailing text
  if (lastIndex < content.length) {
    const plainText = content.slice(lastIndex);
    tokens.push({
      type: 'text',
      content: plainText,
      raw: plainText,
      start: lastIndex,
      end: content.length,
    });
  }

  return tokens;
}

/**
 * Parse inline markdown patterns into tokens.
 *
 * Order of precedence (longer patterns first):
 * 1. `code` - backtick code spans
 * 2. [[link]] - double bracket links
 * 3. **bold** - double asterisk
 * 4. *italic* - single asterisk
 *
 * Returns array of tokens covering the entire input string.
 */
export function parseInlineTokens(content: string): InlineToken[] {
  if (!content) return [];

  const tokens: InlineToken[] = [];

  // Combined regex - order matters: code first, then link, then bold (** before *)
  // Using non-greedy matches and avoiding empty content
  const PATTERN = /(`[^`]+`)|(\[\[[^\]]+\]\])|(\*\*[^*]+\*\*)|(\*[^*]+\*)/g;

  let lastIndex = 0;

  // Use matchAll instead of while loop with regex.ex-ec
  for (const match of content.matchAll(PATTERN)) {
    // Add plain text before this match
    if (match.index !== undefined && match.index > lastIndex) {
      const plainText = content.slice(lastIndex, match.index);
      tokens.push({
        type: 'text',
        content: plainText,
        raw: plainText,
        start: lastIndex,
        end: match.index,
      });
    }

    const raw = match[0];
    const start = match.index ?? lastIndex;
    const end = start + raw.length;

    // Determine token type and extract inner content
    if (match[1]) {
      // `code` - strip backticks
      tokens.push({
        type: 'code',
        content: raw.slice(1, -1),
        raw,
        start,
        end,
      });
    } else if (match[2]) {
      const inner = raw.slice(2, -2);
      const [target, alias] = inner.split('|');
      tokens.push({
        type: 'link',
        content: (alias ?? target).trim(),
        raw,
        start,
        end,
        linkTarget: target.trim(),
        linkAlias: alias?.trim(),
      });
    } else if (match[3]) {
      // **bold** - strip double asterisks
      tokens.push({
        type: 'bold',
        content: raw.slice(2, -2),
        raw,
        start,
        end,
      });
    } else if (match[4]) {
      // *italic* - strip single asterisks
      tokens.push({
        type: 'italic',
        content: raw.slice(1, -1),
        raw,
        start,
        end,
      });
    }

    lastIndex = end;
  }

  // Add trailing plain text
  if (lastIndex < content.length) {
    const plainText = content.slice(lastIndex);
    tokens.push({
      type: 'text',
      content: plainText,
      raw: plainText,
      start: lastIndex,
      end: content.length,
    });
  }

  return tokens;
}

/**
 * Check if content has any inline formatting worth parsing.
 * Use for early-exit optimization in rendering.
 */
export function hasInlineFormatting(content: string): boolean {
  // Standard markdown OR ctx:: patterns
  return /`[^`]+`|\[\[[^\]]+\]\]|\*\*[^*]+\*\*|\*[^*]+\*/.test(content) || hasCtxPatterns(content);
}

/**
 * Parse all inline patterns (markdown + ctx::).
 * Returns unified token array for rendering.
 */
export function parseAllInlineTokens(content: string): InlineToken[] {
  const hasMarkdown = /`[^`]+`|\[\[[^\]]+\]\]|\*\*[^*]+\*\*|\*[^*]+\*/.test(content);
  const hasCtx = hasCtxPatterns(content);

  if (!hasMarkdown && !hasCtx) return [];

  // If only ctx patterns, use ctx-specific parser
  if (hasCtx && !hasMarkdown) {
    return parseCtxTokens(content);
  }

  // If only markdown, use markdown parser
  if (hasMarkdown && !hasCtx) {
    return parseInlineTokens(content);
  }

  // Both: need to merge. For simplicity, prioritize ctx parsing,
  // then apply markdown parsing to text segments
  const ctxTokens = parseCtxTokens(content);

  // Apply markdown parsing to 'text' tokens from ctx parsing
  const mergedTokens: InlineToken[] = [];
  for (const token of ctxTokens) {
    if (token.type === 'text' && /`[^`]+`|\[\[[^\]]+\]\]|\*\*[^*]+\*\*|\*[^*]+\*/.test(token.raw)) {
      // Parse markdown within this text segment
      const mdTokens = parseInlineTokens(token.raw);
      // Adjust positions to be relative to original content
      for (const mdToken of mdTokens) {
        mergedTokens.push({
          ...mdToken,
          start: mdToken.start + token.start,
          end: mdToken.end + token.start,
        });
      }
    } else {
      mergedTokens.push(token);
    }
  }

  return mergedTokens;
}
