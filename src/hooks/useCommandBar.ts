/**
 * useCommandBar - Pure state hook for command palette (⌘K)
 *
 * Unified list: pages (goto) + built-in commands (export, etc.)
 * Pages sorted by recency (updatedAt desc), then alphabetical.
 * No Y.Doc mutations — read-only page list + filtering.
 *
 * FLO-276
 */

import { createSignal, createMemo, createEffect, on } from 'solid-js';
import { blockStore } from './useBlockStore';
import { getPageNamesWithTimestamps } from './useWikilinkAutocomplete';
import { isMac } from '../lib/keybinds';
import { fuzzyFilter } from '../lib/fuzzyFilter';

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

export type ResultItemType = 'page' | 'command';

export interface ResultItem {
  type: ResultItemType;
  label: string;
  /** For commands: unique action ID. For pages: same as label. */
  id: string;
  /** Optional keyboard shortcut hint for display */
  shortcut?: string;
  /** FLO-400: True when this is a typed-text item that doesn't match an existing page */
  isCreate?: boolean;
}

// ═══════════════════════════════════════════════════════════════
// BUILT-IN COMMANDS
// ═══════════════════════════════════════════════════════════════

const mod = isMac ? '⌘' : 'Ctrl+';
const shift = isMac ? '⇧' : 'Shift+';

export const BUILT_IN_COMMANDS: ResultItem[] = [
  { type: 'command', id: 'export-json',     label: 'Export JSON',     shortcut: `${mod}${shift}J` },
  { type: 'command', id: 'export-binary',   label: 'Export Binary',   shortcut: `${mod}${shift}B` },
  { type: 'command', id: 'export-markdown', label: 'Export Markdown', shortcut: `${mod}${shift}M` },
  { type: 'command', id: 'link-pane',       label: 'Link Pane',       shortcut: `${mod}L` },
  { type: 'command', id: 'focus-pane',      label: 'Focus Pane',      shortcut: `${mod}J` },
  { type: 'command', id: 'toggle-dim',      label: 'Toggle Pane Dimming' },
  { type: 'command', id: 'unlink-pane',     label: 'Unlink Pane' },
  { type: 'command', id: 'unlink-all',      label: 'Unlink All Panes' },
  { type: 'command', id: 'copy-block-id',   label: 'Copy Block ID' },
  { type: 'command', id: 'go-home',         label: 'Home (Top of Document)' },
  { type: 'command', id: 'go-today',        label: "Today's Daily Note" },
  { type: 'command', id: 'sidebar-swap',    label: 'Sidebar: Swap Side' },
  { type: 'command', id: 'sidebar-link',   label: 'Sidebar: Link to Pane', shortcut: `${mod}L` },
  { type: 'command', id: 'switch-outline', label: 'Switch Outline' },
];

// ═══════════════════════════════════════════════════════════════
// SORTING & FILTERING
// ═══════════════════════════════════════════════════════════════

/**
 * Sort pages: pin top N most recent, then rest alphabetical.
 * "2-3 recent at top, then the rest of the list normally."
 */
export const PINNED_RECENT_COUNT = 3;

export function sortPages(
  pages: { name: string; updatedAt: number }[],
  pinnedCount: number = PINNED_RECENT_COUNT
): { name: string; updatedAt: number }[] {
  if (pages.length <= pinnedCount) {
    // Everything fits in "recent" — just sort by recency
    return [...pages].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  const byRecency = [...pages].sort((a, b) => b.updatedAt - a.updatedAt);
  const pinned = byRecency.slice(0, pinnedCount);
  const rest = byRecency.slice(pinnedCount).sort((a, b) => a.name.localeCompare(b.name));
  return [...pinned, ...rest];
}

function filterPages(
  pages: { name: string; updatedAt: number }[],
  query: string
): { name: string; updatedAt: number }[] {
  return fuzzyFilter(pages, query, { keys: ['name'] });
}

function filterCommands(commands: ResultItem[], query: string): ResultItem[] {
  return fuzzyFilter(commands, query, { keys: ['label'] });
}

// ═══════════════════════════════════════════════════════════════
// HOOK
// ═══════════════════════════════════════════════════════════════

export function useCommandBar() {
  const [query, setQuery] = createSignal('');
  const [selectedIndex, setSelectedIndex] = createSignal(0);

  // Pages sorted by recency
  const sortedPages = createMemo(() =>
    sortPages(getPageNamesWithTimestamps(blockStore))
  );

  // Unified results: typed text first (FLO-400), then fuzzy pages, then commands
  const filteredResults = createMemo((): ResultItem[] => {
    const q = query();
    const commands = filterCommands(BUILT_IN_COMMANDS, q);

    if (!q) {
      // No query — show all pages sorted, then commands
      const pages = sortedPages()
        .map((p): ResultItem => ({ type: 'page', id: p.name, label: p.name }));
      return [...pages, ...commands];
    }

    // FLO-400: Prepend typed text at position 0
    const qLower = q.toLowerCase();
    const exactPage = sortedPages().find(p => p.name.toLowerCase() === qLower);
    const canonicalName = exactPage ? exactPage.name : q;

    // Fuzzy filter pages, remove exact match duplicate
    const fuzzyPages = filterPages(sortedPages(), q)
      .filter(p => p.name.toLowerCase() !== qLower)
      .map((p): ResultItem => ({ type: 'page', id: p.name, label: p.name }));

    const typedTextItem: ResultItem = {
      type: 'page',
      id: canonicalName,
      label: canonicalName,
      isCreate: !exactPage,
    };

    // FLO-466: When query matches command names, surface commands above pages.
    // Commands first so Enter selects the command, not a create-page action.
    if (commands.length > 0) {
      return [...commands, typedTextItem, ...fuzzyPages];
    }
    return [typedTextItem, ...fuzzyPages];
  });

  // Reset selection when query changes (on() prevents dependency leak)
  createEffect(on(query, () => setSelectedIndex(0), { defer: true }));

  // Clamp selectedIndex when filtered list shrinks
  createEffect(on(filteredResults, (results) => {
    if (selectedIndex() >= results.length && results.length > 0) {
      setSelectedIndex(results.length - 1);
    }
  }, { defer: true }));

  function navigate(direction: 'up' | 'down') {
    const results = filteredResults();
    if (results.length === 0) return;

    const maxIdx = results.length - 1;
    if (direction === 'down') {
      setSelectedIndex(i => i >= maxIdx ? 0 : i + 1);
    } else {
      setSelectedIndex(i => i <= 0 ? maxIdx : i - 1);
    }
  }

  function getSelection(): ResultItem | null {
    const results = filteredResults();
    if (results.length === 0) return null;
    const idx = Math.min(selectedIndex(), results.length - 1);
    return results[idx];
  }

  function reset() {
    setQuery('');
    setSelectedIndex(0);
  }

  return {
    query,
    setQuery,
    selectedIndex,
    setSelectedIndex,
    filteredResults,
    navigate,
    getSelection,
    reset,
  };
}
