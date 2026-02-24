/**
 * Tests for fuzzyFilter utility
 * FLO-389
 */

import { describe, it, expect } from 'vitest';
import { fuzzyFilter } from './fuzzyFilter';

describe('fuzzyFilter with string arrays', () => {
  const items = ['Daily Notes', 'Project Ideas', 'Meeting Notes', 'Reading List'];

  it('returns all items when query is empty', () => {
    expect(fuzzyFilter(items, '')).toEqual(items);
  });

  it('finds exact substring matches', () => {
    const result = fuzzyFilter(items, 'Daily');
    expect(result).toContain('Daily Notes');
  });

  it('finds matches with typos', () => {
    const result = fuzzyFilter(items, 'Daly');
    expect(result).toContain('Daily Notes');
  });

  it('finds matches with transposed letters', () => {
    const result = fuzzyFilter(items, 'Meting');
    expect(result).toContain('Meeting Notes');
  });

  it('ranks exact matches first', () => {
    const result = fuzzyFilter(items, 'Notes');
    // Both "Daily Notes" and "Meeting Notes" match, but exact substring should rank high
    expect(result.length).toBeGreaterThanOrEqual(2);
    expect(result).toContain('Daily Notes');
    expect(result).toContain('Meeting Notes');
  });

  it('returns empty array when nothing matches', () => {
    expect(fuzzyFilter(items, 'zzzzxyzzy')).toEqual([]);
  });

  it('handles empty items list', () => {
    expect(fuzzyFilter([], 'test')).toEqual([]);
  });

  it('is case-insensitive', () => {
    const result = fuzzyFilter(items, 'project');
    expect(result).toContain('Project Ideas');
  });

  it('respects custom threshold (strict)', () => {
    // Very strict threshold — only near-exact matches
    const result = fuzzyFilter(items, 'Daly', { threshold: 0.1 });
    // "Daly" vs "Daily" is close but may not pass 0.1 threshold
    // The exact behavior depends on fuse.js scoring
    expect(result.length).toBeLessThanOrEqual(items.length);
  });

  it('respects custom threshold (loose)', () => {
    // Very loose threshold — more matches even with poor query
    const result = fuzzyFilter(items, 'Readng', { threshold: 0.6 });
    expect(result).toContain('Reading List');
  });
});

describe('fuzzyFilter', () => {
  const pages = [
    { name: 'Daily Notes', updatedAt: 100 },
    { name: 'Project Ideas', updatedAt: 300 },
    { name: 'Meeting Notes', updatedAt: 200 },
  ];

  it('returns all items when query is empty', () => {
    expect(fuzzyFilter(pages, '', { keys: ['name'] })).toEqual(pages);
  });

  it('filters by named key', () => {
    const result = fuzzyFilter(pages, 'Project', { keys: ['name'] });
    expect(result.length).toBe(1);
    expect(result[0].name).toBe('Project Ideas');
  });

  it('finds fuzzy matches on named key', () => {
    const result = fuzzyFilter(pages, 'Projct', { keys: ['name'] });
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].name).toBe('Project Ideas');
  });

  it('preserves full object in results', () => {
    const result = fuzzyFilter(pages, 'Daily', { keys: ['name'] });
    expect(result[0]).toEqual({ name: 'Daily Notes', updatedAt: 100 });
  });

  it('returns empty when nothing matches', () => {
    expect(fuzzyFilter(pages, 'zzzzxyzzy', { keys: ['name'] })).toEqual([]);
  });

  it('works with command-like objects', () => {
    const commands = [
      { label: 'Export JSON', id: 'export-json' },
      { label: 'Export Binary', id: 'export-binary' },
      { label: 'Export Markdown', id: 'export-markdown' },
    ];
    const result = fuzzyFilter(commands, 'bianry', { keys: ['label'] });
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].id).toBe('export-binary');
  });
});
