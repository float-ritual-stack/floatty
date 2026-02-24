/**
 * useCommandBar tests — pure state logic
 * FLO-276
 */

import { describe, it, expect, vi } from 'vitest';
import { createRoot } from 'solid-js';

// Mock the dependencies before importing the hook
vi.mock('./useBlockStore', () => ({
  blockStore: {},
}));

vi.mock('./useWikilinkAutocomplete', () => ({
  getPageNamesWithTimestamps: vi.fn(() => [
    { name: 'Daily Notes', updatedAt: 100 },
    { name: 'Project Ideas', updatedAt: 300 },
    { name: 'Meeting Notes', updatedAt: 200 },
    { name: 'Reading List', updatedAt: 50 },
  ]),
}));

import { useCommandBar, sortPages, PINNED_RECENT_COUNT, BUILT_IN_COMMANDS } from './useCommandBar';

describe('sortPages', () => {
  it('pins top 3 by recency, rest alphabetical', () => {
    const pages = [
      { name: 'Zebra', updatedAt: 50 },
      { name: 'Alpha', updatedAt: 100 },
      { name: 'Beta', updatedAt: 300 },
      { name: 'Gamma', updatedAt: 200 },
      { name: 'Delta', updatedAt: 10 },
    ];
    const sorted = sortPages(pages);
    // Pinned: Beta(300), Gamma(200), Alpha(100)
    // Rest: Delta, Zebra (alphabetical)
    expect(sorted.map(p => p.name)).toEqual(['Beta', 'Gamma', 'Alpha', 'Delta', 'Zebra']);
  });

  it('all recency-sorted when fewer than pinned count', () => {
    const pages = [
      { name: 'B', updatedAt: 100 },
      { name: 'A', updatedAt: 200 },
    ];
    const sorted = sortPages(pages);
    expect(sorted.map(p => p.name)).toEqual(['A', 'B']);
  });

  it('does not mutate original array', () => {
    const pages = [
      { name: 'B', updatedAt: 100 },
      { name: 'A', updatedAt: 200 },
    ];
    sortPages(pages);
    expect(pages[0].name).toBe('B'); // unchanged
  });

  it('respects custom pinned count', () => {
    const pages = [
      { name: 'D', updatedAt: 10 },
      { name: 'C', updatedAt: 100 },
      { name: 'B', updatedAt: 200 },
      { name: 'A', updatedAt: 300 },
    ];
    const sorted = sortPages(pages, 1);
    // Pinned: A(300). Rest: B, C, D (alphabetical)
    expect(sorted.map(p => p.name)).toEqual(['A', 'B', 'C', 'D']);
  });
});

describe('useCommandBar', () => {
  function createBar() {
    let bar!: ReturnType<typeof useCommandBar>;
    createRoot((dispose) => {
      bar = useCommandBar();
      return dispose;
    });
    return bar;
  }

  it('returns pinned recent pages + alphabetical rest + commands', () => {
    const bar = createBar();
    const results = bar.filteredResults();
    // Mock data: Project Ideas (300), Meeting Notes (200), Daily Notes (100), Reading List (50)
    // Pinned (top 3 by recency): Project Ideas, Meeting Notes, Daily Notes
    // Rest (alphabetical): Reading List
    expect(results[0]).toMatchObject({ type: 'page', label: 'Project Ideas' });
    expect(results[1]).toMatchObject({ type: 'page', label: 'Meeting Notes' });
    expect(results[2]).toMatchObject({ type: 'page', label: 'Daily Notes' });
    expect(results[3]).toMatchObject({ type: 'page', label: 'Reading List' });
    // Then commands
    expect(results[4].type).toBe('command');
    expect(results.length).toBe(4 + BUILT_IN_COMMANDS.length);
  });

  it('filters pages by query', () => {
    const bar = createBar();
    bar.setQuery('note');
    const pages = bar.filteredResults().filter(r => r.type === 'page');
    // Fuzzy: both "Meeting Notes" and "Daily Notes" should match
    expect(pages.length).toBe(2);
    expect(pages.map(p => p.label)).toContain('Meeting Notes');
    expect(pages.map(p => p.label)).toContain('Daily Notes');
  });

  it('filters commands by query', () => {
    const bar = createBar();
    bar.setQuery('binary');
    const commands = bar.filteredResults().filter(r => r.type === 'command');
    expect(commands.length).toBe(1);
    expect(commands[0].id).toBe('export-binary');
  });

  it('returns empty when nothing matches', () => {
    const bar = createBar();
    bar.setQuery('zzzznonexistent');
    expect(bar.filteredResults()).toEqual([]);
  });

  it('finds pages with typos (FLO-389)', () => {
    const bar = createBar();
    bar.setQuery('Projct');
    const pages = bar.filteredResults().filter(r => r.type === 'page');
    expect(pages.length).toBeGreaterThan(0);
    expect(pages.map(p => p.label)).toContain('Project Ideas');
  });

  it('finds commands with typos (FLO-389)', () => {
    const bar = createBar();
    bar.setQuery('bianry');
    const commands = bar.filteredResults().filter(r => r.type === 'command');
    expect(commands.length).toBeGreaterThan(0);
    expect(commands.map(c => c.id)).toContain('export-binary');
  });

  it('navigate("down") wraps from last to first', () => {
    const bar = createBar();
    const total = bar.filteredResults().length;
    bar.setSelectedIndex(total - 1);
    bar.navigate('down');
    expect(bar.selectedIndex()).toBe(0);
  });

  it('navigate("up") wraps from first to last', () => {
    const bar = createBar();
    const total = bar.filteredResults().length;
    bar.setSelectedIndex(0);
    bar.navigate('up');
    expect(bar.selectedIndex()).toBe(total - 1);
  });

  it('getSelection() returns null when no results', () => {
    const bar = createBar();
    bar.setQuery('zzzznonexistent');
    expect(bar.getSelection()).toBeNull();
  });

  it('getSelection() returns correct item at selectedIndex', () => {
    const bar = createBar();
    bar.setSelectedIndex(0);
    const sel = bar.getSelection();
    expect(sel!.label).toBe('Project Ideas'); // most recent
  });

  it('getSelection() returns command item', () => {
    const bar = createBar();
    bar.setSelectedIndex(4);
    const sel = bar.getSelection();
    expect(sel!.type).toBe('command');
    expect(sel!.id).toBe('export-json');
  });

  it('reset() clears query and selectedIndex', () => {
    const bar = createBar();
    bar.setQuery('something');
    bar.setSelectedIndex(2);
    bar.reset();
    expect(bar.query()).toBe('');
    expect(bar.selectedIndex()).toBe(0);
  });
});
