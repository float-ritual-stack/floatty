/**
 * Inline Markdown Token Parser
 *
 * Parses inline formatting patterns for overlay display.
 * Returns tokens with both raw (with markers) and content (without markers).
 *
 * Display shows raw text but with styling on the content portion.
 */

import { findWikilinkEnd, parseWikilinkInner } from './wikilinkUtils';

export interface InlineToken {
  type: 'text' | 'bold' | 'italic' | 'code' | 'ctx-prefix' | 'ctx-timestamp' | 'ctx-tag' | 'wikilink';
  content: string;  // inner text without markers (for wikilink: display text)
  raw: string;      // original text with markers (what we display)
  start: number;    // position in source string
  end: number;      // end position (for future selection sync)
  tagType?: string; // For ctx-tag: 'project', 'mode', 'issue', etc.
  target?: string;  // For wikilink: the page name to link to
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
 * Check if content contains [[wikilink]] patterns.
 */
export function hasWikilinkPatterns(content: string): boolean {
  // Simple check: has `[[` followed eventually by `]]`
  const openIdx = content.indexOf('[[');
  if (openIdx === -1) return false;
  return content.indexOf(']]', openIdx + 2) !== -1;
}

/**
 * Parse [[wikilink]] patterns into tokens.
 * Supports nested brackets and [[Target|Alias]] syntax.
 *
 * Uses bracket counting instead of regex to handle:
 * - [[simple]]
 * - [[target|alias]]
 * - [[meeting:: [[nested]]]]
 */
function parseWikilinkTokens(content: string): InlineToken[] {
  if (!hasWikilinkPatterns(content)) return [];

  const tokens: InlineToken[] = [];
  let lastIndex = 0;
  let i = 0;

  while (i < content.length - 1) {
    // Look for `[[`
    const openIdx = content.indexOf('[[', i);
    if (openIdx === -1) break;

    // Find matching `]]` with bracket counting
    const endIdx = findWikilinkEnd(content, openIdx);
    if (endIdx === -1) {
      // Unbalanced - skip this `[[` and continue
      i = openIdx + 2;
      continue;
    }

    // Add plain text before this wikilink
    if (openIdx > lastIndex) {
      const plainText = content.slice(lastIndex, openIdx);
      tokens.push({
        type: 'text',
        content: plainText,
        raw: plainText,
        start: lastIndex,
        end: openIdx,
      });
    }

    // Extract wikilink
    const raw = content.slice(openIdx, endIdx);
    const inner = content.slice(openIdx + 2, endIdx - 2); // Strip outer [[ ]]
    const { target, alias } = parseWikilinkInner(inner);

    // Skip empty targets
    if (target) {
      tokens.push({
        type: 'wikilink',
        content: alias || target, // Display alias if present
        raw,
        start: openIdx,
        end: endIdx,
        target, // The actual target (may contain nested brackets)
      });
    }

    lastIndex = endIdx;
    i = endIdx;
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
 * 2. **bold** - double asterisk
 * 3. *italic* - single asterisk
 *
 * Returns array of tokens covering the entire input string.
 */
export function parseInlineTokens(content: string): InlineToken[] {
  if (!content) return [];

  const tokens: InlineToken[] = [];

  // Combined regex - order matters: code first, then bold (** before *)
  // Using non-greedy matches and avoiding empty content
  const PATTERN = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)/g;

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
      // **bold** - strip double asterisks
      tokens.push({
        type: 'bold',
        content: raw.slice(2, -2),
        raw,
        start,
        end,
      });
    } else if (match[3]) {
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
  // Standard markdown OR ctx:: patterns OR [[wikilinks]]
  return /`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*/.test(content) || hasCtxPatterns(content) || hasWikilinkPatterns(content);
}

/**
 * Parse all inline patterns (markdown + ctx:: + [[wikilinks]]).
 * Returns unified token array for rendering.
 *
 * Priority: wikilinks → ctx:: → markdown
 * Each parser handles 'text' segments from the previous pass.
 */
export function parseAllInlineTokens(content: string): InlineToken[] {
  const hasMarkdown = /`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*/.test(content);
  const hasCtx = hasCtxPatterns(content);
  const hasWikilinks = hasWikilinkPatterns(content);

  if (!hasMarkdown && !hasCtx && !hasWikilinks) return [];

  // Start with wikilinks (highest priority - interactive elements)
  let tokens: InlineToken[] = [];

  if (hasWikilinks) {
    tokens = parseWikilinkTokens(content);
  } else {
    // No wikilinks - start with full content as text
    tokens = [{
      type: 'text',
      content,
      raw: content,
      start: 0,
      end: content.length,
    }];
  }

  // Apply ctx parsing to text segments
  if (hasCtx) {
    const ctxMerged: InlineToken[] = [];
    for (const token of tokens) {
      if (token.type === 'text' && hasCtxPatterns(token.raw)) {
        const ctxTokens = parseCtxTokens(token.raw);
        for (const ctxToken of ctxTokens) {
          ctxMerged.push({
            ...ctxToken,
            start: ctxToken.start + token.start,
            end: ctxToken.end + token.start,
          });
        }
      } else {
        ctxMerged.push(token);
      }
    }
    tokens = ctxMerged;
  }

  // Apply markdown parsing to remaining text segments
  if (hasMarkdown) {
    const mdMerged: InlineToken[] = [];
    for (const token of tokens) {
      if (token.type === 'text' && /`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*/.test(token.raw)) {
        const mdTokens = parseInlineTokens(token.raw);
        for (const mdToken of mdTokens) {
          mdMerged.push({
            ...mdToken,
            start: mdToken.start + token.start,
            end: mdToken.end + token.start,
          });
        }
      } else {
        mdMerged.push(token);
      }
    }
    tokens = mdMerged;
  }

  // Filter out pure text tokens if they're the only thing (no formatting)
  if (tokens.length === 1 && tokens[0].type === 'text') {
    return [];
  }

  return tokens;
}
