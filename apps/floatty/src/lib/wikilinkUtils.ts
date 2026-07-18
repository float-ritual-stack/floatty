/**
 * Shared utilities for [[wikilink]] parsing.
 *
 * Bracket-counting parser handles nested wikilinks like [[outer [[inner]]]].
 * Used by inlineParser, useBacklinkNavigation, and BlockDisplay.
 */

/**
 * Find the closing ]] for a wikilink starting at position `start`.
 * Uses bracket counting to handle nested [[wikilinks]].
 *
 * @param content - The full string to search
 * @param start - Index of the opening [[
 * @returns Index after the closing ]], or -1 if unbalanced
 */
export function findWikilinkEnd(content: string, start: number): number {
  let depth = 0;
  let i = start;

  while (i < content.length - 1) {
    const twoChars = content.slice(i, i + 2);
    if (twoChars === '[[') {
      depth++;
      i += 2;
    } else if (twoChars === ']]') {
      depth--;
      i += 2;
      if (depth === 0) {
        return i;
      }
    } else {
      i++;
    }
  }

  // Check last char for edge case
  if (i === content.length - 1) {
    i++;
  }

  return -1; // Unbalanced
}

/**
 * Parse wikilink inner content to extract target and alias.
 * Handles top-level pipe only (nested [[links]] can contain pipes).
 *
 * @param inner - Content between [[ and ]] (already stripped)
 * @returns { target, alias } where alias is null if no pipe
 */
export function parseWikilinkInner(inner: string): { target: string; alias: string | null } {
  let pipeDepth = 0;

  for (let k = 0; k < inner.length; k++) {
    // Check for [[ and ]]
    if (k < inner.length - 1) {
      const twoChars = inner.slice(k, k + 2);
      if (twoChars === '[[') {
        pipeDepth++;
        k++; // Skip next char
        continue;
      } else if (twoChars === ']]') {
        pipeDepth--;
        k++; // Skip next char
        continue;
      }
    }

    // Only match pipe at depth 0
    if (inner[k] === '|' && pipeDepth === 0) {
      return {
        target: inner.slice(0, k).trim(),
        alias: inner.slice(k + 1).trim() || null
      };
    }
  }

  return { target: inner.trim(), alias: null };
}

/**
 * Split a wikilink target into path segments on whitespace-delimited `>`.
 *
 * ADR-008 Decision 1 grammar. Runs on the alias-stripped target (call
 * `parseWikilinkInner` first). PARITY: mirrors `parse_path_segments` in
 * floatty-core `hooks/parsing.rs` — shared fixture corpus at
 * `__fixtures__/path-grammar.json` asserts both. Interpretation is a USE-time
 * concern (click, API call); extraction/render stay `>`-naive, so this
 * function is NOT wired into parseWikilinkInner or extractAllWikilinkTargets.
 *
 * A `>` splits only when it sits at `[[`/`]]` depth 0 AND has whitespace on
 * the left AND whitespace-or-end-of-string on the right (bare `a>b`, generics
 * `Vec<String>`, arrows `A->B` never split). Any malformed shape — an empty
 * segment (leading/middle/trailing) or unbalanced `[[` — yields the whole
 * target as one opaque segment, preserving pre-path-addressing behavior.
 *
 * @param target - Wikilink target, already alias-stripped
 * @returns One segment (opaque) when there is no separator or the path is
 *   malformed; otherwise the trimmed segments in order.
 */
export function parsePathSegments(target: string): string[] {
  const len = target.length;
  const segments: string[] = [];
  let depth = 0;
  let segStart = 0;
  let i = 0;

  while (i < len) {
    if (i + 1 < len && target[i] === '[' && target[i + 1] === '[') {
      depth++;
      i += 2;
      continue;
    }
    if (i + 1 < len && target[i] === ']' && target[i + 1] === ']') {
      depth--;
      i += 2;
      continue;
    }

    if (depth === 0 && target[i] === '>') {
      const prevIsWs = i > 0 && /\s/.test(target[i - 1]);
      const nextIsWsOrEnd = i + 1 >= len || /\s/.test(target[i + 1]);
      if (prevIsWs && nextIsWsOrEnd) {
        const seg = target.slice(segStart, i).trim();
        if (seg === '') return [target]; // empty segment → opaque
        segments.push(seg);
        segStart = i + 1;
        i++;
        continue;
      }
    }
    i++;
  }

  if (depth !== 0) return [target]; // unbalanced [[ → opaque
  if (segments.length === 0) return [target]; // no separator → single opaque segment
  const last = target.slice(segStart).trim();
  if (last === '') return [target]; // trailing empty → opaque
  segments.push(last);
  return segments;
}

/**
 * Extract the FIRST wikilink in `content` as { target, alias }, or null if
 * there is none. Unlike extractAllWikilinkTargets (targets only, recursive),
 * this preserves the alias for display — e.g. the pin shelf shows the alias of
 * `[[96c10e9d|deep pin]]` ("deep pin") in its header rather than the raw id.
 *
 * @param content - Text to scan
 * @returns { target, alias } of the first wikilink, or null
 */
export function extractFirstWikilink(
  content: string
): { target: string; alias: string | null } | null {
  const openIdx = content.indexOf('[[');
  if (openIdx === -1) return null;
  const endIdx = findWikilinkEnd(content, openIdx);
  if (endIdx === -1) return null;
  const inner = content.slice(openIdx + 2, endIdx - 2);
  const parsed = parseWikilinkInner(inner);
  return parsed.target ? parsed : null;
}

/**
 * Extract all wikilink targets from content, including nested ones.
 *
 * For `[[outer [[inner]]]]`, returns: ["outer [[inner]]", "inner"]
 * This enables backlinks to both the outer and inner targets.
 *
 * @param content - Text to extract targets from
 * @returns Array of target strings (may contain duplicates)
 */
export function extractAllWikilinkTargets(content: string): string[] {
  const targets: string[] = [];

  let i = 0;
  while (i < content.length - 1) {
    const openIdx = content.indexOf('[[', i);
    if (openIdx === -1) break;

    const endIdx = findWikilinkEnd(content, openIdx);
    if (endIdx === -1) {
      // Unbalanced - skip this [[
      i = openIdx + 2;
      continue;
    }

    // Extract inner content (strip outer [[ ]])
    const inner = content.slice(openIdx + 2, endIdx - 2);
    const { target } = parseWikilinkInner(inner);

    if (target) {
      targets.push(target);

      // Recursively extract from the target (for nested wikilinks)
      const nestedTargets = extractAllWikilinkTargets(target);
      targets.push(...nestedTargets);
    }

    i = endIdx;
  }

  return targets;
}
