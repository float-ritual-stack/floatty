/**
 * Shared utilities for [[wikilink]] parsing.
 *
 * Bracket-counting parser handles nested wikilinks like [[outer [[inner]]]].
 * Used by inlineParser, backlink indexing, outlink extraction, and BlockDisplay.
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
 * Match every balanced wikilink opener to its closing offset in one linear
 * pass. Unlike repeated findWikilinkEnd calls, malformed runs of unmatched
 * `[[` cannot degrade a whole-content scan to quadratic work.
 */
export function indexWikilinkEnds(content: string): ReadonlyMap<number, number> {
  const openings: number[] = [];
  const ends = new Map<number, number>();
  let i = 0;
  while (i < content.length - 1) {
    const pair = content.slice(i, i + 2);
    if (pair === '[[') {
      openings.push(i);
      i += 2;
      continue;
    }
    if (pair === ']]') {
      const opening = openings.pop();
      if (opening !== undefined) ends.set(opening, i + 2);
      i += 2;
      continue;
    }
    i++;
  }
  return ends;
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
      // \p{White_Space} (not \s) — JS \s additionally matches U+FEFF, which
      // Rust's char::is_whitespace does not. The Unicode White_Space property
      // is the exact set both twins share (parity: parse_path_segments).
      const prevIsWs = i > 0 && /\p{White_Space}/u.test(target[i - 1]);
      const nextIsWsOrEnd = i + 1 >= len || /\p{White_Space}/u.test(target[i + 1]);
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

/** Extraction depth for wikilink targets. */
export type WikilinkExtractionMode = 'outer' | 'nested';

// Real authored links are a handful of levels deep. This defensive ceiling
// keeps malformed/adversarial content from turning "every nesting level" into
// unbounded output allocation or main-thread work.
const MAX_WIKILINK_NESTING = 256;

/**
 * Extract wikilink targets from content with an explicit nesting contract.
 *
 * `outer` preserves the metadata.outlinks contract: one target per top-level
 * wikilink token. `nested` additionally emits every balanced nested span, so
 * `[[outer [[inner]]]]` yields `['outer [[inner]]', 'inner']`.
 *
 * Alias (`|`) and path (` > `) cuts apply independently at each span's top
 * level. ADR-008 D4 therefore makes `[[a > b > c]]` contribute `a`, while a
 * separator inside a nested span cannot cut its parent target.
 */
export function extractWikilinkTargets(
  content: string,
  mode: WikilinkExtractionMode,
): string[] {
  const targets: string[] = [];
  type ScanFrame = {
    text: string;
    cursor: number;
    depth: number;
    ends: ReadonlyMap<number, number>;
  };
  const stack: ScanFrame[] = [{
    text: content,
    cursor: 0,
    depth: 0,
    ends: indexWikilinkEnds(content),
  }];

  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    const openIdx = frame.text.indexOf('[[', frame.cursor);
    if (openIdx === -1) {
      stack.pop();
      continue;
    }

    const endIdx = frame.ends.get(openIdx);
    if (endIdx === undefined) {
      frame.cursor = openIdx + 2;
      continue;
    }

    frame.cursor = endIdx;
    const inner = frame.text.slice(openIdx + 2, endIdx - 2);
    const { target } = parseWikilinkInner(inner);
    if (target) targets.push(parsePathSegments(target)[0]);

    // Explicit stack preserves depth-first output order without consuming the
    // JavaScript call stack. Scan the uncut span so nested links in either the
    // target or alias remain nesting levels with their own top-level cuts.
    if (mode === 'nested' && frame.depth < MAX_WIKILINK_NESTING) {
      stack.push({
        text: inner,
        cursor: 0,
        depth: frame.depth + 1,
        ends: indexWikilinkEnds(inner),
      });
    }
  }
  return targets;
}

/**
 * Compatibility name for callers whose established behavior includes nested
 * targets. New callers should choose an explicit extraction mode.
 */
export function extractAllWikilinkTargets(content: string): string[] {
  return extractWikilinkTargets(content, 'nested');
}
