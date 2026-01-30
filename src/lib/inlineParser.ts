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
  type: 'text' | 'bold' | 'italic' | 'code' | 'ctx-prefix' | 'ctx-timestamp' | 'ctx-tag' | 'wikilink' | 'code-fence' | 'line-comment' | 'filter-function' | 'filter-prefix' | 'table';
  content: string;  // inner text without markers (for wikilink: display text)
  raw: string;      // original text with markers (what we display)
  start: number;    // position in source string
  end: number;      // end position (for future selection sync)
  tagType?: string; // For ctx-tag: 'project', 'mode', 'issue', etc.
  target?: string;  // For wikilink: the page name to link to
  lang?: string;    // For code-fence: language identifier (rust, js, etc.)
  code?: string;    // For code-fence: the code content without fence markers
  commentPrefix?: string; // For line-comment: the prefix used (//, %%, --, #)
  functionName?: string;  // For filter-function: include or exclude
  // Table-specific fields
  headers?: string[];  // For table: column headers
  rows?: string[][];   // For table: data rows (2D array)
  alignments?: ('left' | 'center' | 'right')[];  // For table: column alignments
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
 * Check if content starts with filter:: prefix.
 */
export function hasFilterPrefixPattern(content: string): boolean {
  return /^filter::/i.test(content.trim());
}

/**
 * Check if content is a line-comment (starts with //, %%, --, #).
 */
export function hasLineCommentPattern(content: string): boolean {
  const trimmed = content.replace(/^[-•]\s+/, '').trim();
  return /^(\/\/|%%|--|#)\s/.test(trimmed);
}

/**
 * Check if content is a filter function call (include(...) or exclude(...)).
 */
export function hasFilterFunctionPattern(content: string): boolean {
  const trimmed = content.replace(/^[-•]\s+/, '').trim();
  return /^(include|exclude)\s*\([^)]*\)\s*$/i.test(trimmed);
}

/**
 * Check if content contains fenced code block patterns.
 * Requires opening ``` and closing ``` on separate lines.
 */
export function hasCodeFencePatterns(content: string): boolean {
  // Must have at least two ``` on line starts (opening and closing)
  const lines = content.split('\n');
  let fenceCount = 0;
  for (const line of lines) {
    if (line.trimStart().startsWith('```')) {
      fenceCount++;
      if (fenceCount >= 2) return true;
    }
  }
  return false;
}

/**
 * Parse fenced code blocks into tokens.
 * Uses line-by-line state machine to handle:
 * - ```lang ... ``` blocks
 * - Nested content (code inside is NOT parsed for markdown)
 * - Multiple fenced blocks in same content
 *
 * Returns tokens with text between fences as separate text tokens.
 */
function parseCodeFenceTokens(content: string): InlineToken[] {
  if (!hasCodeFencePatterns(content)) return [];

  const tokens: InlineToken[] = [];
  const lines = content.split('\n');

  let inCodeFence = false;
  let fenceLang = '';
  let fenceStart = 0;
  let fenceLines: string[] = [];
  let currentPos = 0;
  let textStart = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmedLine = line.trimStart();
    const lineStart = currentPos;
    const lineEnd = currentPos + line.length + (i < lines.length - 1 ? 1 : 0); // +1 for \n except last

    if (trimmedLine.startsWith('```')) {
      if (inCodeFence) {
        // Closing fence - emit code-fence token
        const fenceEnd = lineEnd;
        const raw = content.slice(fenceStart, fenceEnd);
        const code = fenceLines.join('\n');

        tokens.push({
          type: 'code-fence',
          content: code,
          raw,
          start: fenceStart,
          end: fenceEnd,
          lang: fenceLang,
          code,
        });

        inCodeFence = false;
        fenceLines = [];
        textStart = fenceEnd;
      } else {
        // Opening fence - first emit any text before it
        if (lineStart > textStart) {
          const plainText = content.slice(textStart, lineStart);
          tokens.push({
            type: 'text',
            content: plainText,
            raw: plainText,
            start: textStart,
            end: lineStart,
          });
        }

        inCodeFence = true;
        fenceLang = trimmedLine.slice(3).trim(); // Extract language after ```
        fenceStart = lineStart;
      }
    } else if (inCodeFence) {
      fenceLines.push(line);
    }

    currentPos = lineEnd;
  }

  // Handle unclosed fence (treat as text)
  if (inCodeFence) {
    // Unclosed fence - emit everything from fence start as text
    const plainText = content.slice(fenceStart);
    tokens.push({
      type: 'text',
      content: plainText,
      raw: plainText,
      start: fenceStart,
      end: content.length,
    });
  } else if (textStart < content.length) {
    // Trailing text after last fence
    const plainText = content.slice(textStart);
    tokens.push({
      type: 'text',
      content: plainText,
      raw: plainText,
      start: textStart,
      end: content.length,
    });
  }

  return tokens;
}

/**
 * Check if content contains a markdown table pattern.
 * Tables require: first line with pipes, second line is separator with dashes.
 */
export function hasTablePattern(content: string): boolean {
  const lines = content.split('\n');
  if (lines.length < 2) return false;

  const firstLine = lines[0].trim();
  const secondLine = lines[1].trim();

  // First line: | header | header | (must have pipes)
  if (!firstLine.startsWith('|') || !firstLine.endsWith('|')) return false;

  // Second line: |---|---| (separator with dashes, optional colons for alignment)
  return /^\|[\s\-:|]+\|$/.test(secondLine);
}

/**
 * Split table row by pipes, respecting escaped pipes (\|).
 * Returns cells between the outer pipes.
 */
function splitTableRow(line: string): string[] {
  // Remove leading/trailing |
  const trimmed = line.trim();
  const inner = trimmed.slice(1, -1);  // Remove outer |

  // Split by unescaped pipes only
  const cells: string[] = [];
  let current = '';
  let i = 0;
  while (i < inner.length) {
    if (inner[i] === '\\' && inner[i + 1] === '|') {
      // Escaped pipe - unescape and include
      current += '|';
      i += 2;
    } else if (inner[i] === '|') {
      // Unescaped pipe - cell boundary
      cells.push(current.trim());
      current = '';
      i++;
    } else {
      current += inner[i];
      i++;
    }
  }
  cells.push(current.trim());  // Last cell
  return cells;
}

/**
 * Parse markdown table into token with structured data.
 * Returns null if content is not a valid table.
 * Exported for BlockItem to use (picker pattern).
 */
export function parseTableToken(content: string): InlineToken | null {
  if (!hasTablePattern(content)) return null;

  const lines = content.split('\n').filter(l => l.trim().startsWith('|'));
  if (lines.length < 2) return null;

  // Parse headers (line 0)
  const headers = splitTableRow(lines[0]);

  // Parse alignments from separator (line 1) - no escaping needed for separators
  const separatorCells = lines[1].split('|').slice(1, -1);
  const alignments: ('left' | 'center' | 'right')[] = separatorCells.map(cell => {
    const trimmed = cell.trim();
    if (trimmed.startsWith(':') && trimmed.endsWith(':')) return 'center';
    if (trimmed.endsWith(':')) return 'right';
    return 'left';
  });

  // Parse data rows (line 2+)
  const rows = lines.slice(2).map(row => splitTableRow(row));

  return {
    type: 'table',
    content: content,
    raw: content,
    start: 0,
    end: content.length,
    headers,
    rows,
    alignments,
  };
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

  // Check for filter:: prefix at start of line
  const filterPrefixMatch = content.match(/^(filter::)/i);
  if (filterPrefixMatch) {
    const prefix = filterPrefixMatch[1];
    const rest = content.slice(prefix.length);
    const tokens: InlineToken[] = [{
      type: 'filter-prefix',
      content: prefix,
      raw: prefix,
      start: 0,
      end: prefix.length,
    }];
    if (rest) {
      tokens.push({
        type: 'text',
        content: rest,
        raw: rest,
        start: prefix.length,
        end: content.length,
      });
    }
    return tokens;
  }

  // Check for line-level comment patterns (entire line is a comment)
  // Only matches if content STARTS with comment prefix (after optional bullet/whitespace)
  // Note: bullet pattern must be `- ` (dash + space) to avoid stripping `--` comments
  const trimmed = content.replace(/^[-•]\s+/, '').trim();
  const commentMatch = trimmed.match(/^(\/\/|%%|--|#)\s*/);
  if (commentMatch) {
    return [{
      type: 'line-comment',
      content: trimmed.slice(commentMatch[0].length),
      raw: content,
      start: 0,
      end: content.length,
      commentPrefix: commentMatch[1],
    }];
  }

  // Check for filter function patterns: include(...) or exclude(...)
  const filterFuncMatch = trimmed.match(/^(include|exclude)\s*\([^)]*\)\s*$/i);
  if (filterFuncMatch) {
    return [{
      type: 'filter-function',
      content: trimmed,
      raw: content,
      start: 0,
      end: content.length,
      functionName: filterFuncMatch[1].toLowerCase(),
    }];
  }

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
  // Tables OR code fences OR standard markdown OR ctx:: patterns OR [[wikilinks]] OR comments/filters/prefix
  return hasTablePattern(content)
    || hasCodeFencePatterns(content)
    || /`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*/.test(content)
    || hasCtxPatterns(content)
    || hasWikilinkPatterns(content)
    || hasLineCommentPattern(content)
    || hasFilterFunctionPattern(content)
    || hasFilterPrefixPattern(content);
}

/**
 * Parse all inline patterns (tables + code fences + markdown + ctx:: + [[wikilinks]]).
 * Returns unified token array for rendering.
 *
 * Priority: table → code-fence → wikilinks → ctx:: → markdown
 * Tables are block-level - if content IS a table, return single token.
 * Code fences are next highest priority because their content should NOT be parsed.
 */
export function parseAllInlineTokens(content: string): InlineToken[] {
  // Tables are block-level - if content IS a table, return single token
  // This takes priority over everything else
  if (hasTablePattern(content)) {
    const tableToken = parseTableToken(content);
    if (tableToken) return [tableToken];
  }

  const hasCodeFence = hasCodeFencePatterns(content);
  const hasMarkdown = /`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*/.test(content);
  const hasCtx = hasCtxPatterns(content);
  const hasWikilinks = hasWikilinkPatterns(content);
  const hasLineComment = hasLineCommentPattern(content);
  const hasFilterFunc = hasFilterFunctionPattern(content);
  const hasFilterPrefix = hasFilterPrefixPattern(content);

  if (!hasCodeFence && !hasMarkdown && !hasCtx && !hasWikilinks && !hasLineComment && !hasFilterFunc && !hasFilterPrefix) {
    return [];
  }

  // Handle line-comment/filter-function/filter-prefix FIRST (whole-line patterns)
  // These take precedence because they apply to the entire block content
  if (hasLineComment || hasFilterFunc || hasFilterPrefix) {
    return parseInlineTokens(content);
  }

  // Start with code fences (highest priority - content inside is NOT parsed)
  let tokens: InlineToken[] = [];

  if (hasCodeFence) {
    tokens = parseCodeFenceTokens(content);
  } else if (hasWikilinks) {
    tokens = parseWikilinkTokens(content);
  } else {
    // No code fences or wikilinks - start with full content as text
    tokens = [{
      type: 'text',
      content,
      raw: content,
      start: 0,
      end: content.length,
    }];
  }

  // Apply wikilink parsing to text segments (if code fences were found, text between them)
  if (hasCodeFence && hasWikilinks) {
    const wikiMerged: InlineToken[] = [];
    for (const token of tokens) {
      if (token.type === 'text' && hasWikilinkPatterns(token.raw)) {
        const wikiTokens = parseWikilinkTokens(token.raw);
        for (const wikiToken of wikiTokens) {
          wikiMerged.push({
            ...wikiToken,
            start: wikiToken.start + token.start,
            end: wikiToken.end + token.start,
          });
        }
      } else {
        wikiMerged.push(token);
      }
    }
    tokens = wikiMerged;
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
