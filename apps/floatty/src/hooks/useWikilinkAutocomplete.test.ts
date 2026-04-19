/**
 * Tests for useWikilinkAutocomplete pure logic functions
 *
 * FLO-376: Trigger detection, filtering, edge cases
 */

import { describe, it, expect } from 'vitest';
import { detectWikilinkTrigger, filterSuggestions, sortPageNames, buildSuggestionsWithTypedText } from './useWikilinkAutocomplete';

describe('detectWikilinkTrigger', () => {
  it('detects [[ at start of content', () => {
    const result = detectWikilinkTrigger('[[', 2);
    expect(result).toEqual({ query: '', startOffset: 0 });
  });

  it('detects [[ with partial query', () => {
    const result = detectWikilinkTrigger('[[my pa', 7);
    expect(result).toEqual({ query: 'my pa', startOffset: 0 });
  });

  it('detects [[ after other text', () => {
    const result = detectWikilinkTrigger('some text [[query', 17);
    expect(result).toEqual({ query: 'query', startOffset: 10 });
  });

  it('returns null when no [[', () => {
    const result = detectWikilinkTrigger('hello world', 11);
    expect(result).toBeNull();
  });

  it('returns null when [[ is already closed with ]]', () => {
    const result = detectWikilinkTrigger('[[Page Name]] more text', 23);
    expect(result).toBeNull();
  });

  it('returns null when cursor is before [[', () => {
    const result = detectWikilinkTrigger('text [[page', 3);
    expect(result).toBeNull();
  });

  it('detects second [[ after first is closed', () => {
    // '[[First]] and [[Second'
    //  0123456789012345678901
    //                 ^ [[ starts at index 14
    const result = detectWikilinkTrigger('[[First]] and [[Second', 22);
    expect(result).toEqual({ query: 'Second', startOffset: 14 });
  });

  it('handles empty content', () => {
    const result = detectWikilinkTrigger('', 0);
    expect(result).toBeNull();
  });

  it('handles [[ at cursor position exactly', () => {
    const result = detectWikilinkTrigger('text [[', 7);
    expect(result).toEqual({ query: '', startOffset: 5 });
  });

  it('handles multiline content', () => {
    const result = detectWikilinkTrigger('line1\nline2 [[page', 18);
    expect(result).toEqual({ query: 'page', startOffset: 12 });
  });

  it('handles single bracket (not a trigger)', () => {
    const result = detectWikilinkTrigger('text [not a trigger', 19);
    expect(result).toBeNull();
  });
});

describe('sortPageNames', () => {
  it('pins top 3 by recency, rest alphabetical', () => {
    const pages = [
      { name: 'Zebra', updatedAt: 50 },
      { name: 'Alpha', updatedAt: 100 },
      { name: 'Beta', updatedAt: 300 },
      { name: 'Gamma', updatedAt: 200 },
      { name: 'Delta', updatedAt: 10 },
    ];
    expect(sortPageNames(pages)).toEqual(['Beta', 'Gamma', 'Alpha', 'Delta', 'Zebra']);
  });

  it('all recency-sorted when fewer than 3 pages', () => {
    const pages = [
      { name: 'B', updatedAt: 100 },
      { name: 'A', updatedAt: 200 },
    ];
    expect(sortPageNames(pages)).toEqual(['A', 'B']);
  });

  it('handles empty list', () => {
    expect(sortPageNames([])).toEqual([]);
  });
});

describe('filterSuggestions', () => {
  const pages = ['My Page', 'Another Page', 'Daily Notes', 'meeting notes'];

  it('returns all pages when query is empty', () => {
    expect(filterSuggestions(pages, '')).toEqual(pages);
  });

  it('finds exact substring matches', () => {
    const result = filterSuggestions(pages, 'page');
    expect(result).toContain('My Page');
    expect(result).toContain('Another Page');
  });

  it('finds substring matches anywhere in name', () => {
    const result = filterSuggestions(pages, 'not');
    // "not" appears in "Another", "Notes", "notes"
    expect(result).toContain('Another Page');
    expect(result).toContain('Daily Notes');
    expect(result).toContain('meeting notes');
  });

  it('returns empty array when nothing matches', () => {
    expect(filterSuggestions(pages, 'zzzzxyzzy')).toEqual([]);
  });

  it('handles empty pages list', () => {
    expect(filterSuggestions([], 'test')).toEqual([]);
  });

  it('finds matches with typos (FLO-389)', () => {
    const result = filterSuggestions(pages, 'Daly');
    expect(result).toContain('Daily Notes');
  });

  it('finds matches with missing letters (FLO-389)', () => {
    const result = filterSuggestions(pages, 'Metin');
    expect(result).toContain('meeting notes');
  });
});

describe('buildSuggestionsWithTypedText (FLO-400)', () => {
  const pages = ['My Page', 'Another Page', 'Daily Notes', 'meeting notes'];

  it('returns all pages as exists:true when query is empty', () => {
    const result = buildSuggestionsWithTypedText(pages, '');
    expect(result).toEqual(pages.map(name => ({ name, exists: true })));
  });

  it('prepends typed text at position 0 with exists:false for novel text', () => {
    const result = buildSuggestionsWithTypedText(pages, 'Brand New');
    expect(result[0]).toEqual({ name: 'Brand New', exists: false });
    expect(result.length).toBeGreaterThan(0);
  });

  it('resolves to canonical name when exact match exists (case-insensitive)', () => {
    const result = buildSuggestionsWithTypedText(pages, 'my page');
    // Should resolve to canonical "My Page", not the raw "my page"
    expect(result[0]).toEqual({ name: 'My Page', exists: true });
  });

  it('deduplicates exact match from fuzzy results', () => {
    const result = buildSuggestionsWithTypedText(pages, 'My Page');
    // "My Page" should only appear once (at position 0), not also in fuzzy results
    const myPageCount = result.filter(s => s.name.toLowerCase() === 'my page').length;
    expect(myPageCount).toBe(1);
    expect(result[0]).toEqual({ name: 'My Page', exists: true });
  });

  it('fuzzy results follow typed text at positions 1+', () => {
    const result = buildSuggestionsWithTypedText(pages, 'page');
    expect(result[0]).toEqual({ name: 'page', exists: false });
    // Fuzzy results should include pages containing "page"
    const fuzzyNames = result.slice(1).map(s => s.name);
    expect(fuzzyNames).toContain('My Page');
    expect(fuzzyNames).toContain('Another Page');
  });

  it('fuzzy results all have exists:true', () => {
    const result = buildSuggestionsWithTypedText(pages, 'Note');
    const fuzzy = result.slice(1);
    fuzzy.forEach((s) => {
      expect(s.exists).toBe(true);
    });
  });

  it('handles query that matches nothing', () => {
    const result = buildSuggestionsWithTypedText(pages, 'zzzzxyzzy');
    expect(result).toEqual([{ name: 'zzzzxyzzy', exists: false }]);
  });

  // FLO-552: block-alias form (`<hex-prefix>|alias`) should not offer "Create new page"
  describe('block-alias form (FLO-552)', () => {
    it('suppresses Create badge when hex prefix resolves to an existing block', () => {
      // "abc123de" is an 8-char hex; resolveAlias returns true → exists:true, no fuzzy noise
      const resolveAlias = (hex: string) => hex === 'abc123de';
      const result = buildSuggestionsWithTypedText(pages, 'abc123de|alias text', resolveAlias);
      expect(result).toEqual([{ name: 'abc123de|alias text', exists: true }]);
    });

    it('keeps Create badge when hex prefix is valid shape but does not resolve', () => {
      // Shape matches BLOCK_ID_PREFIX_RE but no such block exists → falls through to normal flow
      const resolveAlias = () => false;
      const result = buildSuggestionsWithTypedText(pages, 'deadbeef00|fake', resolveAlias);
      expect(result[0]).toEqual({ name: 'deadbeef00|fake', exists: false });
    });

    it('ignores alias form when left side is not hex', () => {
      // "not-hex" is not a block-ID prefix → resolveAlias never consulted, normal flow applies
      const resolveAlias = () => {
        throw new Error('should not be called for non-hex prefix');
      };
      const result = buildSuggestionsWithTypedText(pages, 'not-hex|alias', resolveAlias);
      expect(result[0]).toEqual({ name: 'not-hex|alias', exists: false });
    });

    it('does not trigger block-alias path without a pipe', () => {
      // Bare hex prefix (no pipe) should fall through to normal page search
      const resolveAlias = () => {
        throw new Error('should not be called without a pipe');
      };
      const result = buildSuggestionsWithTypedText(pages, 'abc123de', resolveAlias);
      expect(result[0]).toEqual({ name: 'abc123de', exists: false });
    });

    it('backward-compat: no resolveAlias arg behaves exactly like pre-FLO-552', () => {
      const result = buildSuggestionsWithTypedText(pages, 'abc123de|alias');
      // No resolver → Create badge still shows, same as any unknown typed text
      expect(result[0]).toEqual({ name: 'abc123de|alias', exists: false });
    });
  });
});
