/**
 * Search Results View Component
 *
 * Renders search:: block results with clickable navigation.
 * - Click result → navigate to block (zoom)
 * - Cmd+Click → open in horizontal split
 * - Cmd+Shift+Click → open in vertical split
 */

import { For, Show } from 'solid-js';
import type { SearchResults, SearchHit } from '../../lib/handlers/search';
import { navigateToBlock } from '../../lib/navigation';

interface SearchResultsViewProps {
  data: SearchResults;
  paneId?: string;
}

/**
 * Truncate text with ellipsis
 */
function truncate(text: string, maxLen: number): string {
  // Clean up newlines for display
  const clean = text.replace(/\n/g, ' ').trim();
  if (clean.length <= maxLen) return clean;
  return clean.slice(0, maxLen - 1) + '…';
}

/**
 * Main search results view
 */
export function SearchResultsView(props: SearchResultsViewProps) {
  const handleResultClick = (hit: SearchHit, e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    // Determine split direction from modifiers
    let splitDirection: 'horizontal' | 'vertical' | undefined;
    if (e.metaKey || e.ctrlKey) {
      splitDirection = e.shiftKey ? 'vertical' : 'horizontal';
    }

    navigateToBlock(hit.blockId, {
      paneId: props.paneId,
      splitDirection,
      highlight: true,
    });
  };

  return (
    <div class="search-results-view">
      <div class="search-results-header">
        <span class="search-query">"{props.data.query}"</span>
        <span class="search-stats">
          {props.data.totalHits} results in {props.data.searchTimeMs.toFixed(0)}ms
        </span>
      </div>

      <Show
        when={props.data.hits.length > 0}
        fallback={<div class="search-no-results">No results found</div>}
      >
        <div class="search-results-list">
          <For each={props.data.hits}>
            {(hit) => (
              <div class="search-result-item" onClick={(e) => handleResultClick(hit, e)}>
                <span class="search-result-content">{truncate(hit.content, 100)}</span>
                <Show when={hit.score > 0}>
                  <span class="search-result-score">{(hit.score * 100).toFixed(0)}%</span>
                </Show>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

/**
 * Error view for search failures
 */
export function SearchErrorView(props: { data: { error: string; query?: string } }) {
  return (
    <div class="search-error-view">
      <span class="search-error-icon">⚠️</span>
      <span class="search-error-message">{props.data.error}</span>
    </div>
  );
}
