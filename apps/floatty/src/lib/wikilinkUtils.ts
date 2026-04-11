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
