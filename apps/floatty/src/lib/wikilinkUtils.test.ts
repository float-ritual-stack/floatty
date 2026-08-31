/**
 * Tests for wikilinkUtils path tokenizer (ADR-008 stage 1) + characterization
 * guards proving the `>`-naive surfaces are unchanged.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import {
  parsePathSegments,
  parseWikilinkInner,
  extractAllWikilinkTargets,
  extractWikilinkTargets,
} from './wikilinkUtils';
import { parseAllInlineTokens } from './inlineParser';
import corpusRaw from './__fixtures__/path-grammar.json?raw';

interface TokenizeCase {
  name: string;
  input?: string;
  input_inner?: string;
  target?: string;
  alias?: string | null;
  segments: string[];
}

interface OutlinkCase {
  name: string;
  content: string;
  targets: string[];
}

const corpus = JSON.parse(corpusRaw) as {
  tokenize: TokenizeCase[];
  outlinks: OutlinkCase[];
};

describe('parsePathSegments — shared corpus', () => {
  for (const c of corpus.tokenize) {
    it(c.name, () => {
      if (c.input_inner !== undefined) {
        // Alias split happens FIRST — parsePathSegments runs on the target only.
        const parsed = parseWikilinkInner(c.input_inner);
        expect(parsed.target).toBe(c.target);
        expect(parsed.alias).toBe(c.alias ?? null);
        expect(parsePathSegments(parsed.target)).toEqual(c.segments);
      } else {
        expect(parsePathSegments(c.input as string)).toEqual(c.segments);
      }
    });
  }
});

describe('characterization — `>`-naive surfaces unchanged', () => {
  it('parseWikilinkInner does not split on `>`', () => {
    expect(parseWikilinkInner('a > b').target).toBe('a > b');
    expect(parseWikilinkInner('a > b').alias).toBeNull();
  });

  it('inlineParser wikilink token keeps the whole path as target', () => {
    // The render/click tokenizer stays `>`-naive — path interpretation is a
    // USE-time concern. Only the extraction/index surfaces change (below).
    const tokens = parseAllInlineTokens('[[a > b]]');
    const wikilink = tokens.find((t) => t.type === 'wikilink');
    expect(wikilink?.target).toBe('a > b');
  });
});

// ADR-008 Decision 4 (stage 2c, FLO-830): the extraction/index surface now
// resolves a path link to its FIRST segment. This flips the stage-1
// characterization guard that pinned the opaque path string
// (`extractAllWikilinkTargets('[[a > b]]')` used to return `['a > b']`; it now
// returns `['a']`). Cases are corpus-driven so TS and Rust stay in parity.
describe('extractWikilinkTargets — explicit nesting mode', () => {
  it('keeps outer mode byte-compatible with one-target-per-token outlinks', () => {
    const content = '[[Demo Alpha|label]] and [[Root > Child]] and [[outer [[inner]]]]';
    expect(extractWikilinkTargets(content, 'outer')).toEqual([
      'Demo Alpha',
      'Root',
      'outer [[inner]]',
    ]);
  });

  it('emits every nesting level in nested mode', () => {
    expect(extractWikilinkTargets('[[a [[b]] c]]', 'nested')).toEqual([
      'a [[b]] c',
      'b',
    ]);
  });

  it('applies alias and path cuts at each span top level only', () => {
    expect(extractWikilinkTargets('[[Root [[Inner > Leaf]] Tail > Child|Alias [[Alias Link]]]]', 'nested')).toEqual([
      'Root [[Inner > Leaf]] Tail',
      'Inner',
      'Alias Link',
    ]);
  });

  it('does not promote nested targets in outer mode', () => {
    expect(extractWikilinkTargets('[[outer [[inner]]]]', 'outer')).toEqual(['outer [[inner]]']);
  });
});

describe('extractAllWikilinkTargets — path link → first segment (ADR-008 D4)', () => {
  for (const c of corpus.outlinks) {
    it(c.name, () => {
      expect(extractAllWikilinkTargets(c.content)).toEqual(c.targets);
    });
  }

  it('flips the stage-1 opaque-path guard', () => {
    // Was `['a > b']` at stage 1; now the first segment.
    expect(extractAllWikilinkTargets('[[a > b]]')).toEqual(['a']);
  });
});
