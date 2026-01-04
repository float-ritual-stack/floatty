/**
 * Inline Markdown Token Parser
 *
 * Parses inline formatting patterns for overlay display.
 * Returns tokens with both raw (with markers) and content (without markers).
 *
 * Display shows raw text but with styling on the content portion.
 */

export interface InlineToken {
  type: 'text' | 'bold' | 'italic' | 'code' | 'ctx-prefix' | 'ctx-timestamp' | 'ctx-tag' | 'wikilink';
  content: string;  // inner text without markers
  raw: string;      // original text with markers (what we display)
  start: number;    // position in source string
  end: number;      // end position (for future selection sync)
  tagType?: string; // For ctx-tag: 'project', 'mode', 'issue', etc.
  linkTarget?: string; // For wikilink: the actual link target (differs from content when alias is used)
}

// ctx:: pattern: timestamp required to distinguish from abstract discussion
// Example: "ctx::2026-01-03 @ 02:50:24 AM [project::floatty]"

/**
 * Wikilink pattern: [[Target]] or [[Target|Alias]]
 * - Group 1: Target (the page name)
 * - Group 2: Alias (optional display text)
 *
 * Limitations: Does not handle nested brackets [[outer [[inner]] outer]]
 * or escaped brackets. This is acceptable for simple wikilink syntax.
 */
export const WIKILINK_PATTERN = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

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
 * 2. [[Link]] or [[Link|Alias]] - wikilinks
 * 3. **bold** - double asterisk
 * 4. *italic* - single asterisk
 *
 * Returns array of tokens covering the entire input string.
 */
export function parseInlineTokens(content: string): InlineToken[] {
  if (!content) return [];

  const tokens: InlineToken[] = [];

  // Combined regex - order matters: code first, wikilinks, then bold (** before *)
  // Wikilink pattern: [[Target]] or [[Target|Alias]]
  // Using non-greedy matches and avoiding empty content
  const PATTERN = /(`[^`]+`)|(\[\[([^\]|]+)(?:\|([^\]]+))?\]\])|(\*\*[^*]+\*\*)|(\*[^*]+\*)/g;

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
      // [[Link]] or [[Link|Alias]] - wikilink
      // match[3] is the target, match[4] is the alias (optional)
      const target = match[3];
      const alias = match[4];
      tokens.push({
        type: 'wikilink',
        content: alias || target,  // Display alias if present, otherwise target
        raw,
        start,
        end,
        linkTarget: target,  // Always store the actual target
      });
    } else if (match[5]) {
      // **bold** - strip double asterisks
      tokens.push({
        type: 'bold',
        content: raw.slice(2, -2),
        raw,
        start,
        end,
      });
    } else if (match[6]) {
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
 * Check if content contains wikilink patterns.
 * Matches [[Target]] and [[Target|Alias]] syntax.
 */
export function hasWikilinks(content: string): boolean {
  return /\[\[[^\]|]+(?:\|[^\]]+)?\]\]/.test(content);
}

/**
 * Check if content has any inline formatting worth parsing.
 * Use for early-exit optimization in rendering.
 */
export function hasInlineFormatting(content: string): boolean {
  // Standard markdown OR ctx:: patterns OR wikilinks
  return /`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*/.test(content) || hasCtxPatterns(content) || hasWikilinks(content);
}

/**
 * Parse all inline patterns (markdown + ctx:: + wikilinks).
 * Returns unified token array for rendering.
 */
export function parseAllInlineTokens(content: string): InlineToken[] {
  const hasMarkdown = /`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*/.test(content);
  const hasCtx = hasCtxPatterns(content);
  const hasLinks = hasWikilinks(content);

  if (!hasMarkdown && !hasCtx && !hasLinks) return [];

  // If only ctx patterns, use ctx-specific parser
  if (hasCtx && !hasMarkdown && !hasLinks) {
    return parseCtxTokens(content);
  }

  // If only markdown/wikilinks (no ctx), use markdown parser (handles wikilinks too)
  if ((hasMarkdown || hasLinks) && !hasCtx) {
    return parseInlineTokens(content);
  }

  // Both ctx and markdown/wikilinks: need to merge. For simplicity, prioritize ctx parsing,
  // then apply markdown/wikilink parsing to text segments
  const ctxTokens = parseCtxTokens(content);

  // Apply markdown/wikilink parsing to 'text' tokens from ctx parsing
  const mergedTokens: InlineToken[] = [];
  const mdPattern = /`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[\[[^\]|]+(?:\|[^\]]+)?\]\]/;
  for (const token of ctxTokens) {
    if (token.type === 'text' && mdPattern.test(token.raw)) {
      // Parse markdown/wikilinks within this text segment
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
