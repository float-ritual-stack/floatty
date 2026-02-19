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

import { useCommandBar, sortPages, BUILT_IN_COMMANDS } from './useCommandBar';

describe('sortPages', () => {
  it('sorts by updatedAt descending', () => {
    const pages = [
      { name: 'A', updatedAt: 100 },
      { name: 'B', updatedAt: 300 },
      { name: 'C', updatedAt: 200 },
    ];
    const sorted = sortPages(pages);
    expect(sorted.map(p => p.name)).toEqual(['B', 'C', 'A']);
  });

  it('alphabetical tiebreak when same updatedAt', () => {
    const pages = [
      { name: 'Zebra', updatedAt: 100 },
      { name: 'Alpha', updatedAt: 100 },
      { name: 'Mango', updatedAt: 100 },
    ];
    const sorted = sortPages(pages);
    expect(sorted.map(p => p.name)).toEqual(['Alpha', 'Mango', 'Zebra']);
  });

  it('does not mutate original array', () => {
    const pages = [
      { name: 'B', updatedAt: 100 },
      { name: 'A', updatedAt: 200 },
    ];
    sortPages(pages);
    expect(pages[0].name).toBe('B'); // unchanged
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

  it('returns pages sorted by recency + commands', () => {
    const bar = createBar();
    const results = bar.filteredResults();
    // Pages sorted: Project Ideas (300), Meeting Notes (200), Daily Notes (100), Reading List (50)
    expect(results[0]).toMatchObject({ type: 'page', label: 'Project Ideas' });
    expect(results[1]).toMatchObject({ type: 'page', label: 'Meeting Notes' });
    expect(results[2]).toMatchObject({ type: 'page', label: 'Daily Notes' });
    expect(results[3]).toMatchObject({ type: 'page', label: 'Reading List' });
    // Then commands
    expect(results[4].type).toBe('command');
    expect(results.length).toBe(4 + BUILT_IN_COMMANDS.length);
  });

  it('filters pages by substring', () => {
    const bar = createBar();
    bar.setQuery('note');
    const pages = bar.filteredResults().filter(r => r.type === 'page');
    // Meeting Notes (200) before Daily Notes (100) by recency
    expect(pages.map(p => p.label)).toEqual(['Meeting Notes', 'Daily Notes']);
  });

  it('filters commands by substring', () => {
    const bar = createBar();
    bar.setQuery('binary');
    const commands = bar.filteredResults().filter(r => r.type === 'command');
    expect(commands.length).toBe(1);
    expect(commands[0].id).toBe('export-binary');
  });

  it('returns only commands when no pages match', () => {
    const bar = createBar();
    bar.setQuery('export');
    const results = bar.filteredResults();
    expect(results.every(r => r.type === 'command')).toBe(true);
    expect(results.length).toBe(3);
  });

  it('returns empty when nothing matches', () => {
    const bar = createBar();
    bar.setQuery('zzzznonexistent');
    expect(bar.filteredResults()).toEqual([]);
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
