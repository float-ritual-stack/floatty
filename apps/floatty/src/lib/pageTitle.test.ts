/**
 * Tests for the section canonicalizer (ADR-008 Decision 8, stage 1).
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import { getSectionKey } from './pageTitle';
import corpusRaw from './__fixtures__/path-grammar.json?raw';

interface CanonicalizeCase {
  name: string;
  input: string;
  canonical: string;
}

const corpus = JSON.parse(corpusRaw) as { canonicalize: CanonicalizeCase[] };

describe('getSectionKey — shared corpus', () => {
  for (const c of corpus.canonicalize) {
    it(c.name, () => {
      expect(getSectionKey(c.input)).toBe(c.canonical);
    });
  }
});
