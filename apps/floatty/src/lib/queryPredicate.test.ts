/**
 * queryPredicate — grammar tests (brief E). Synthetic, PII-free.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_QUERY_LIMIT,
  MAX_QUERY_LIMIT,
  parseQuery,
  tokenizeQueryLine,
  type QueryTerm,
} from './queryPredicate';

describe('tokenizeQueryLine', () => {
  it('splits on whitespace at bracket depth zero only', () => {
    expect(tokenizeQueryLine('link:⬜  !link:✅\tpage~^2026')).toEqual(['link:⬜', '!link:✅', 'page~^2026']);
    expect(tokenizeQueryLine('under:[[Demo Page Name]] since:7d')).toEqual(['under:[[Demo Page Name]]', 'since:7d']);
    expect(tokenizeQueryLine('[stamp:: a=b c=d] [limit:: 5]')).toEqual(['[stamp:: a=b c=d]', '[limit:: 5]']);
    expect(tokenizeQueryLine('[create_block:: [[Demo Home]]] link:x')).toEqual(['[create_block:: [[Demo Home]]]', 'link:x']);
  });

  it('never throws on unbalanced brackets — the rest of the line rides one token', () => {
    expect(tokenizeQueryLine('under:[[broken link:x')).toEqual(['under:[[broken link:x']);
    expect(tokenizeQueryLine(']]] link:x')).toEqual([']]]', 'link:x']);
    expect(tokenizeQueryLine('')).toEqual([]);
    expect(tokenizeQueryLine('   ')).toEqual([]);
  });
});

describe('parseQuery — terms', () => {
  const termsOf = (line: string): QueryTerm[] => parseQuery(line).terms;

  it('rejects non-query content without throwing', () => {
    const parse = parseQuery('just prose with link:x');
    expect(parse.isQuery).toBe(false);
    expect(parse.terms).toEqual([]);
    expect(parse.errors).toEqual(['not a query:: block']);
  });

  it('reads only the first line, case-insensitive prefix', () => {
    const parse = parseQuery('Query:: link:⬜\nsecond line link:✅ is a child note');
    expect(parse.isQuery).toBe(true);
    expect(parse.terms).toEqual([{ kind: 'link', negate: false, match: { op: 'exact', value: '⬜' } }]);
  });

  it('parses link exact / regex and negation', () => {
    expect(termsOf('query:: link:⬜ !link:✅')).toEqual([
      { kind: 'link', negate: false, match: { op: 'exact', value: '⬜' } },
      { kind: 'link', negate: true, match: { op: 'exact', value: '✅' } },
    ]);
    const [regexTerm] = termsOf('query:: link~^(PC|REX)-\\d+$');
    expect(regexTerm.kind).toBe('link');
    if (regexTerm.kind !== 'link' || regexTerm.match.op !== 'regex') throw new Error('expected regex');
    expect(regexTerm.match.regex.test('PC-236')).toBe(true);
    expect(regexTerm.match.regex.test('FLO-947')).toBe(false);
  });

  it('link: unwraps [[brackets]] around an exact target', () => {
    expect(termsOf('query:: link:[[Demo Page]]')).toEqual([
      { kind: 'link', negate: false, match: { op: 'exact', value: 'Demo Page' } },
    ]);
  });

  it('parses page exact / regex', () => {
    expect(termsOf('query:: page:2026-w33')).toEqual([
      { kind: 'page', negate: false, match: { op: 'exact', value: '2026-w33' } },
    ]);
    const [regexTerm] = termsOf('query:: page~^2026-w3');
    if (regexTerm.kind !== 'page' || regexTerm.match.op !== 'regex') throw new Error('expected regex');
    expect(regexTerm.match.regex.test('2026-W33')).toBe(true); // case-insensitive
  });

  it('parses under: with or without wikilink brackets (spaces preserved)', () => {
    expect(termsOf('query:: under:[[Demo Page Name]]')).toEqual([
      { kind: 'under', negate: false, target: 'Demo Page Name' },
    ]);
    expect(termsOf('query:: under:7fc0276f')).toEqual([
      { kind: 'under', negate: false, target: '7fc0276f' },
    ]);
    expect(termsOf('query:: !under:[[x]]')).toEqual([{ kind: 'under', negate: true, target: 'x' }]);
  });

  it('parses since:<N>d', () => {
    expect(termsOf('query:: since:7d')).toEqual([{ kind: 'since', negate: false, days: 7 }]);
    expect(termsOf('query:: since:30D')).toEqual([{ kind: 'since', negate: false, days: 30 }]);
  });

  it('parses text~ and marker:<type>[:<value>]', () => {
    const [text] = termsOf('query:: text~^todo');
    if (text.kind !== 'text') throw new Error('expected text');
    expect(text.regex.test('TODO: x')).toBe(true);
    expect(termsOf('query:: marker:project:rangle/rexall-catalyst marker:status')).toEqual([
      { kind: 'marker', negate: false, markerType: 'project', value: 'rangle/rexall-catalyst' },
      { kind: 'marker', negate: false, markerType: 'status', value: null },
    ]);
    // trailing colon = no value
    expect(termsOf('query:: marker:status:')).toEqual([
      { kind: 'marker', negate: false, markerType: 'status', value: null },
    ]);
  });

  it('term keys are case-insensitive', () => {
    expect(termsOf('query:: LINK:x PAGE:y')).toEqual([
      { kind: 'link', negate: false, match: { op: 'exact', value: 'x' } },
      { kind: 'page', negate: false, match: { op: 'exact', value: 'y' } },
    ]);
  });
});

describe('parseQuery — malformed input never throws', () => {
  it('reports unknown terms and keeps the rest', () => {
    const parse = parseQuery('query:: foo link:⬜ bar:baz');
    expect(parse.terms).toEqual([{ kind: 'link', negate: false, match: { op: 'exact', value: '⬜' } }]);
    expect(parse.errors).toEqual(['unknown term "foo"', 'unknown term "bar:baz"']);
  });

  it('reports empty values, bare "!", and bad since/text/under/marker shapes', () => {
    const parse = parseQuery('query:: link: ! since:soon since~7d text:plain under~x marker~y marker::v');
    expect(parse.terms).toEqual([]);
    expect(parse.errors).toEqual([
      'empty value in "link:"',
      'empty term after "!"',
      'since: expects <N>d ("since:soon")',
      'since: expects <N>d ("since~7d")',
      'text: takes a regex — use text~ ("text:plain")',
      'under: takes a [[target]], not a regex ("under~x")',
      'marker: takes <type>[:<value>], not a regex ("marker~y")',
      'empty marker type in "marker::v"',
    ]);
  });

  it('reports invalid regexes and drops only that term', () => {
    const parse = parseQuery('query:: text~(unclosed link:⬜');
    expect(parse.terms).toEqual([{ kind: 'link', negate: false, match: { op: 'exact', value: '⬜' } }]);
    expect(parse.errors).toHaveLength(1);
    expect(parse.errors[0]).toMatch(/^invalid regex in text~:/);
  });

  it('since:0d is rejected', () => {
    expect(parseQuery('query:: since:0d').errors).toEqual(['since: expects a positive day count ("since:0d")']);
  });

  it('a bare query:: with no terms is a valid, empty parse', () => {
    const parse = parseQuery('query::');
    expect(parse.isQuery).toBe(true);
    expect(parse.terms).toEqual([]);
    expect(parse.errors).toEqual([]);
  });
});

describe('parseQuery — options (pills via extractTagMarkers)', () => {
  it('defaults', () => {
    expect(parseQuery('query:: link:x').options).toEqual({
      createBlock: null, display: 'rows', stamp: {}, hasExplicitStamp: false, limit: DEFAULT_QUERY_LIMIT,
    });
  });

  it('reads display, limit, stamp, create_block', () => {
    const parse = parseQuery(
      'query:: link:⬜ [display:: titles] [limit:: 50] [stamp:: status=doing project=x] [create_block:: [[Demo Home]]]',
    );
    expect(parse.errors).toEqual([]);
    expect(parse.options).toEqual({
      createBlock: 'Demo Home',
      hasExplicitStamp: true,
      display: 'titles',
      stamp: { status: 'doing', project: 'x' },
      limit: 50,
    });
    // pills never leak into the term list
    expect(parse.terms).toHaveLength(1);
  });

  it('option keys are case-insensitive and limit is clamped', () => {
    expect(parseQuery('query:: link:x [Display:: Titles]').options.display).toBe('titles');
    expect(parseQuery('query:: link:x [limit:: 999999]').options.limit).toBe(MAX_QUERY_LIMIT);
  });

  it('reports malformed options without throwing', () => {
    const parse = parseQuery('query:: link:x [display:: grid] [limit:: -3] [limit:: abc] [stamp:: novalue] [glyph:: status]');
    expect(parse.errors).toEqual([
      'display expects rows|titles ("grid")',
      'limit expects a positive integer ("-3")',
      'limit expects a positive integer ("abc")',
      'stamp expects key=value ("novalue")',
      'unknown option "glyph"',
    ]);
    expect(parse.options.display).toBe('rows');
    expect(parse.options.limit).toBe(DEFAULT_QUERY_LIMIT);
  });

  it('points the hyphenated create-block spelling at the grammar-legal key', () => {
    const parse = parseQuery('query:: link:x [create-block:: [[Demo Home]]]');
    expect(parse.options.createBlock).toBeNull();
    expect(parse.errors).toEqual([
      'option "create-block" is not a marker key — use [create_block:: [[target]]]',
    ]);
  });

  it('reports a bracket token that is not a marker at all', () => {
    expect(parseQuery('query:: link:x [nope]').errors).toEqual(['unrecognised option "[nope]"']);
  });
});
