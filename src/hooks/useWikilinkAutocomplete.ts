/**
 * useWikilinkAutocomplete - Inline autocomplete for [[wikilinks]]
 *
 * Detects [[ trigger in contentEditable, shows filtered page suggestions,
 * handles keyboard navigation and selection.
 *
 * FLO-376: Pure frontend, no Y.Doc schema changes.
 */

import { createSignal } from 'solid-js';
import { findPagesContainer, getPageTitle } from './useBacklinkNavigation';
import type { BlockStoreInterface } from '../context/WorkspaceContext';
import { fuzzyFilter } from '../lib/fuzzyFilter';

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

export interface AutocompleteSuggestion {
  name: string;
  /** Whether this matches an existing page (case-insensitive) */
  exists: boolean;
}

export interface AutocompleteState {
  /** Text typed after [[ */
  query: string;
  /** Character offset where [[ starts in the block content */
  startOffset: number;
  /** Filtered page name suggestions (typed text first, then fuzzy matches) */
  suggestions: AutocompleteSuggestion[];
  /** Currently highlighted suggestion index */
  selectedIndex: number;
  /** Position rect for popup placement */
  anchorRect: DOMRect;
}

// ═══════════════════════════════════════════════════════════════
// PURE LOGIC (testable without DOM)
// ═══════════════════════════════════════════════════════════════

/**
 * Detect [[ trigger before cursor position.
 * Returns query text and start offset, or null if no active trigger.
 */
export function detectWikilinkTrigger(
  content: string,
  offset: number
): { query: string; startOffset: number } | null {
  const before = content.slice(0, offset);
  const lastOpen = before.lastIndexOf('[[');
  if (lastOpen === -1) return null;

  // Check for ]] between [[ and cursor — means wikilink is already closed
  const between = before.slice(lastOpen + 2);
  if (between.includes(']]')) return null;

  return { query: between, startOffset: lastOpen };
}

/**
 * Get all page names from the pages:: container.
 * Strips heading prefix (# ) from page content.
 */
export function getPageNames(blockStore: BlockStoreInterface): string[] {
  const container = findPagesContainer();
  if (!container) return [];

  return container.childIds
    .map(id => blockStore.blocks[id])
    .filter(Boolean)
    .map(b => getPageTitle(b.content));
}

/**
 * Get page names with updatedAt timestamps for recency sorting.
 */
export function getPageNamesWithTimestamps(blockStore: BlockStoreInterface): { name: string; updatedAt: number }[] {
  const container = findPagesContainer();
  if (!container) return [];

  return container.childIds
    .map(id => blockStore.blocks[id])
    .filter(Boolean)
    .map(b => ({
      name: getPageTitle(b.content),
      updatedAt: b.updatedAt ?? 0,
    }));
}

import { PINNED_RECENT_COUNT } from './useCommandBar';

/**
 * Sort page names: pin top N most recent, rest alphabetical.
 * Mirrors sortPages() from useCommandBar but for the string[] interface.
 */

export function sortPageNames(
  pages: { name: string; updatedAt: number }[]
): string[] {
  if (pages.length <= PINNED_RECENT_COUNT) {
    return [...pages].sort((a, b) => b.updatedAt - a.updatedAt).map(p => p.name);
  }

  const byRecency = [...pages].sort((a, b) => b.updatedAt - a.updatedAt);
  const pinned = byRecency.slice(0, PINNED_RECENT_COUNT).map(p => p.name);
  const rest = byRecency.slice(PINNED_RECENT_COUNT).sort((a, b) => a.name.localeCompare(b.name)).map(p => p.name);
  return [...pinned, ...rest];
}

/**
 * Filter page names by query (fuzzy match via fuse.js).
 * Empty query returns all pages in pinned-recent order.
 * Non-empty query returns fuzzy match-score order. FLO-389.
 */
export function filterSuggestions(pages: string[], query: string): string[] {
  return fuzzyFilter(pages, query);
}

/**
 * Build autocomplete suggestions with typed text prepended at position 0.
 * Deduplicates: if typed text case-insensitively matches a fuzzy result, it's removed from fuzzy section.
 * FLO-400
 */
export function buildSuggestionsWithTypedText(
  pages: string[],
  query: string,
): AutocompleteSuggestion[] {
  if (!query) {
    return pages.map(name => ({ name, exists: true }));
  }

  const queryLower = query.toLowerCase();
  const canonicalPage = pages.find(p => p.toLowerCase() === queryLower);
  const canonicalName = canonicalPage ?? query;

  // Fuzzy filter, then remove exact match duplicate
  const fuzzyResults = fuzzyFilter(pages, query)
    .filter(p => p.toLowerCase() !== queryLower);

  const typedTextItem: AutocompleteSuggestion = { name: canonicalName, exists: !!canonicalPage };
  const fuzzyItems: AutocompleteSuggestion[] = fuzzyResults.map(name => ({ name, exists: true }));

  return [typedTextItem, ...fuzzyItems];
}

// ═══════════════════════════════════════════════════════════════
// HOOK
// ═══════════════════════════════════════════════════════════════

/**
 * FLO-322: pageNames is now a singleton Accessor from WorkspaceContext.
 * Previously each BlockItem created its own identical memo (N×M recomputation).
 */
export function useWikilinkAutocomplete(pageNames: () => string[]) {
  const [state, setState] = createSignal<AutocompleteState | null>(null);

  /**
   * Check for [[ trigger after content/cursor changes.
   * Called from updateContentFromDom in BlockItem.
   */
  function checkTrigger(content: string, cursorOffset: number, contentRef: HTMLElement) {
    const trigger = detectWikilinkTrigger(content, cursorOffset);

    if (!trigger) {
      if (state()) setState(null);
      return;
    }

    // Get cursor rect for popup positioning
    const selection = window.getSelection();
    if (!selection || !selection.rangeCount) {
      if (state()) {
        console.debug('[useWikilinkAutocomplete] Dismissing: no selection or range');
        setState(null);
      }
      return;
    }

    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();

    // If rect is zero-sized (collapsed range), fall back to contentRef position
    const anchorRect = rect.width === 0 && rect.height === 0
      ? contentRef.getBoundingClientRect()
      : rect;

    const suggestions = buildSuggestionsWithTypedText(pageNames(), trigger.query);

    // Preserve selectedIndex if the previously selected item is still in the filtered list
    const prev = state();
    let selectedIndex = 0;
    if (prev && prev.suggestions.length > 0) {
      const prevName = prev.suggestions[prev.selectedIndex]?.name;
      const preserved = suggestions.findIndex(s => s.name === prevName);
      if (preserved !== -1) selectedIndex = preserved;
    }

    setState({
      query: trigger.query,
      startOffset: trigger.startOffset,
      suggestions,
      selectedIndex,
      anchorRect,
    });
  }

  /** Move selection up/down */
  function navigate(direction: 'up' | 'down') {
    const current = state();
    if (!current || current.suggestions.length === 0) return;

    const maxIdx = current.suggestions.length - 1;
    let newIdx: number;

    if (direction === 'down') {
      newIdx = current.selectedIndex >= maxIdx ? 0 : current.selectedIndex + 1;
    } else {
      newIdx = current.selectedIndex <= 0 ? maxIdx : current.selectedIndex - 1;
    }

    setState({ ...current, selectedIndex: newIdx });
  }

  /**
   * Get selected suggestion info for text replacement.
   * Returns the page name and offsets needed to replace text.
   */
  function getSelection(): { pageName: string; startOffset: number } | null {
    const current = state();
    if (!current || current.suggestions.length === 0) return null;

    const idx = Math.min(current.selectedIndex, current.suggestions.length - 1);
    return {
      pageName: current.suggestions[idx].name,
      startOffset: current.startOffset,
    };
  }

  /** Set selected index directly (for mouse hover) */
  function setSelectedIndex(idx: number) {
    const current = state();
    if (!current) return;
    setState({ ...current, selectedIndex: idx });
  }

  /** Close popup */
  function dismiss() {
    setState(null);
  }

  /** Check if autocomplete is currently open */
  function isOpen(): boolean {
    return state() !== null;
  }

  return {
    state,
    checkTrigger,
    navigate,
    setSelectedIndex,
    getSelection,
    dismiss,
    isOpen,
  };
}
