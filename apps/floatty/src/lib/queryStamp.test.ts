import { describe, expect, it } from 'vitest';
import raw from './__fixtures__/query-stamp.json?raw';
import { parseQuery, tokenizeQueryLine } from './queryPredicate';
import { defaultPropTable } from './markerSurgery';
import { stampForQuery } from './queryStamp';
const corpus = JSON.parse(raw) as {
  cases: Array<{ name: string; content: string; stamp: Record<string, string> }>;
  tokens: Array<{ line: string; tokens: string[] }>;
};
describe('shared query-stamp corpus (Rust + TS)', () => {
  for (const entry of corpus.cases) {
    it(entry.name, () => expect(stampForQuery(parseQuery(entry.content), defaultPropTable())).toEqual(entry.stamp));
  }
  for (const entry of corpus.tokens) {
    it(`tokenize ${entry.line}`, () => expect(tokenizeQueryLine(entry.line)).toEqual(entry.tokens));
  }
  it('uses the supplied glyph reverse map', () => {
    expect(stampForQuery(parseQuery('query:: link:★'), [
      { key: 'priority', surface: 'glyph', glyphs: [['high', '★']] },
    ])).toEqual({ priority: 'high' });
  });
});
