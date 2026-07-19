/**
 * Tests for the segment matcher (ADR-008 Decision 2, stage 1).
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import { matchExact, matchFuzzy, type MatchCandidate } from './pathMatcher';
import corpusRaw from './__fixtures__/path-grammar.json?raw';

interface MatchCase {
  name: string;
  mode: 'exact' | 'fuzzy';
  segment: string;
  candidates: MatchCandidate[];
  expected: number | null;
  expected_rung?: number;
}

const corpus = JSON.parse(corpusRaw) as { match: { cases: MatchCase[] } };

describe('segment matcher — shared corpus', () => {
  for (const c of corpus.match.cases) {
    it(c.name, () => {
      if (c.mode === 'exact') {
        expect(matchExact(c.segment, c.candidates)).toBe(c.expected);
      } else {
        const result = matchFuzzy(c.segment, c.candidates);
        expect(result === null ? null : result.index).toBe(c.expected);
        if (c.expected_rung !== undefined && result !== null) {
          expect(result.rung).toBe(c.expected_rung);
        }
      }
    });
  }
});

describe('matchFuzzy rung 1 IS matchExact (shared predicate)', () => {
  it('every exact match resolves fuzzy at rung 1 to the same index', () => {
    const candidates: MatchCandidate[] = [
      { content: '## Section B', createdAt: 100 },
      { content: 'Section C', createdAt: 50 },
    ];
    const exact = matchExact('section b', candidates);
    const fuzzy = matchFuzzy('section b', candidates);
    expect(exact).toBe(0);
    expect(fuzzy).toEqual({ index: 0, rung: 1 });
  });
});
