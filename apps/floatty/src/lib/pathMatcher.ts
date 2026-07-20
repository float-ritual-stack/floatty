/**
 * Segment matcher — ADR-008 Decision 2, the coupling invariant lives HERE.
 *
 * Two entry points over one grammar:
 *   - matchExact  — the WRITE predicate (mkdir-p direct-child find-or-create).
 *   - matchFuzzy  — the READ ladder (nav / resolve descendant matching).
 * matchFuzzy's rung 1 IS matchExact (same call, not a copy): if they diverge,
 * write-then-read round-trips land in different blocks.
 *
 * OWNED INVARIANT — oldest-createdAt-wins is implemented ONCE, in `selectOldest`
 * below. Walkers (stage-2 `walk_descendants`) and mkdir-p CALL this matcher;
 * they never re-derive the tie-break. `createdAt` of 0/missing compares as
 * +infinity (never steals), matching PageNameIndex `add_existing_page` /
 * `scan_pages_container_for_name` semantics.
 *
 * Depth-proximity × recency cross-level scoring is stage-2's job, not the
 * matcher's — matchFuzzy returns the rung so a walker can compose it.
 *
 * PARITY: mirrors `segment_match` in floatty-core `projections/segment_match.rs`;
 * shared corpus `__fixtures__/path-grammar.json` `match` section asserts both.
 */

import { getSectionKey } from './pageTitle';

/**
 * Minimal candidate shape — content + creation time only. Kept tiny so
 * stage-2 adapters can feed it from Y.Doc blocks, store rows, or DTOs; the
 * caller maps the returned index back to its own block list.
 */
export interface MatchCandidate {
  content: string;
  /** Epoch ms. 0 (or absent) means "unknown age" → compares as +infinity. */
  createdAt: number;
}

/** Fuzzy ladder rung (lower beats higher). */
export type MatchRung = 1 | 2 | 3 | 4;

export interface FuzzyMatch {
  index: number;
  rung: MatchRung;
}

/** `[key::value]` — the canonical tag-marker pattern (floatty-core TAG_PATTERN). */
const TAG_MARKER = /\[(\w+)::([^\]]+)\]/g;

/**
 * Effective createdAt for tie-breaking: 0/missing → +infinity (never steals).
 *
 * Exported so walkers composing the ADR-008 D2 total order (rung → depth →
 * recency → oldest-createdAt) reuse THIS rule for their final tie-break
 * instead of re-deriving the +∞ semantics. Mirrors `effective_created_at`
 * exported by `segment_match.rs`.
 */
export function effectiveCreatedAt(createdAt: number): number {
  return createdAt > 0 ? createdAt : Number.POSITIVE_INFINITY;
}

/**
 * THE tie-break. Among candidates satisfying `predicate`, return the index of
 * the oldest (min effective createdAt); ties resolve to the first encountered
 * (mirrors `scan_pages_container_for_name`'s `>= best` keep-earlier rule).
 */
function selectOldest(
  candidates: MatchCandidate[],
  predicate: (content: string) => boolean
): number | null {
  let best: { index: number; createdAt: number } | null = null;
  for (let i = 0; i < candidates.length; i++) {
    if (!predicate(candidates[i].content)) continue;
    const createdAt = effectiveCreatedAt(candidates[i].createdAt);
    if (best === null || createdAt < best.createdAt) {
      best = { index: i, createdAt };
    }
  }
  return best === null ? null : best.index;
}

/** Sanitize a captured marker value — unwrap the `[key::[[wikilink]]]` typo. */
function sanitizeMarkerValue(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('[[')) {
    const inner = trimmed.slice(2);
    return (inner.endsWith(']]') ? inner.slice(0, -2) : inner).trim();
  }
  return trimmed;
}

/** Remove markdown emphasis markers so rung 2 can compare on the plain name. */
function stripMarkdown(s: string): string {
  return s.replace(/[*_~`]/g, '').trim();
}

/** Lowercased content with `[key::value]` markers removed (rung 3 input). */
function markerStrippedContent(content: string): string {
  return content.toLowerCase().replace(TAG_MARKER, '');
}

/** Canonicalized values of every `[key::value]` marker in `content` (rung 4). */
function markerValues(content: string): string[] {
  const values: string[] = [];
  for (const match of content.matchAll(TAG_MARKER)) {
    values.push(getSectionKey(sanitizeMarkerValue(match[2])));
  }
  return values;
}

/**
 * WRITE predicate — exact canonicalized equality only, oldest-createdAt wins.
 * No prefix/contains/marker matching (a fuzzy write is a bug, ADR-008 D2).
 *
 * @returns Index of the matching candidate, or null.
 */
export function matchExact(segment: string, candidates: MatchCandidate[]): number | null {
  const key = getSectionKey(segment);
  // Empty canonical key (e.g. "## ", whitespace-only) matches nothing — the
  // tokenizer never emits such segments, but the matcher guards its own door.
  if (key === '') return null;
  return selectOldest(candidates, (content) => getSectionKey(content) === key);
}

/**
 * READ ladder — 4 rungs, lower always beats higher; within a rung, oldest
 * createdAt wins. Rung 1 delegates to `matchExact` (shared predicate).
 *   1. exact (canonicalized equality) — the write predicate.
 *   2. markdown-stripped equality.
 *   3. contains (case-insensitive) against marker-stripped content.
 *   4. marker-value match — segment equals a `[key::value]` value.
 *
 * Rung 3 runs on marker-stripped content so a segment appearing ONLY inside a
 * marker falls through to rung 4 (otherwise the value is always a literal
 * substring of the raw content and rung 4 is unreachable).
 *
 * @returns { index, rung }, or null when no rung matches.
 */
export function matchFuzzy(segment: string, candidates: MatchCandidate[]): FuzzyMatch | null {
  const rung1 = matchExact(segment, candidates);
  if (rung1 !== null) return { index: rung1, rung: 1 };

  const key = getSectionKey(segment);
  // Empty key would make rung 3's includes('') match every candidate.
  if (key === '') return null;
  const strippedKey = stripMarkdown(key);
  const rung2 = selectOldest(candidates, (content) => stripMarkdown(getSectionKey(content)) === strippedKey);
  if (rung2 !== null) return { index: rung2, rung: 2 };

  const rung3 = selectOldest(candidates, (content) => markerStrippedContent(content).includes(key));
  if (rung3 !== null) return { index: rung3, rung: 3 };

  const rung4 = selectOldest(candidates, (content) => markerValues(content).includes(key));
  if (rung4 !== null) return { index: rung4, rung: 4 };

  return null;
}
