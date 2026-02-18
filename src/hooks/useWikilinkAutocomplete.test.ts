/**
 * Tests for useWikilinkAutocomplete pure logic functions
 *
 * FLO-376: Trigger detection, filtering, edge cases
 */

import { describe, it, expect } from 'vitest';
import { detectWikilinkTrigger, filterSuggestions } from './useWikilinkAutocomplete';

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

describe('filterSuggestions', () => {
  const pages = ['My Page', 'Another Page', 'Daily Notes', 'meeting notes'];

  it('returns all pages when query is empty', () => {
    expect(filterSuggestions(pages, '')).toEqual(pages);
  });

  it('filters case-insensitively', () => {
    expect(filterSuggestions(pages, 'page')).toEqual(['My Page', 'Another Page']);
  });

  it('matches substring anywhere in name', () => {
    // "not" matches: "A-not-her Page", "Daily Notes", "meeting notes"
    expect(filterSuggestions(pages, 'not')).toEqual(['Another Page', 'Daily Notes', 'meeting notes']);
  });

  it('returns empty array when nothing matches', () => {
    expect(filterSuggestions(pages, 'xyz')).toEqual([]);
  });

  it('handles single character query', () => {
    expect(filterSuggestions(pages, 'm')).toEqual(['My Page', 'meeting notes']);
  });

  it('handles empty pages list', () => {
    expect(filterSuggestions([], 'test')).toEqual([]);
  });
});
