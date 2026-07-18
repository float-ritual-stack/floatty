/**
 * Tests for wikilinkUtils path tokenizer (ADR-008 stage 1) + characterization
 * guards proving the `>`-naive surfaces are unchanged.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import { parsePathSegments, parseWikilinkInner, extractAllWikilinkTargets } from './wikilinkUtils';
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

const corpus = JSON.parse(corpusRaw) as { tokenize: TokenizeCase[] };

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
    const tokens = parseAllInlineTokens('[[a > b]]');
    const wikilink = tokens.find((t) => t.type === 'wikilink');
    expect(wikilink?.target).toBe('a > b');
  });

  it('extractAllWikilinkTargets returns the opaque path string', () => {
    expect(extractAllWikilinkTargets('[[a > b]]')).toEqual(['a > b']);
  });
});
