/**
 * Search Results View Component
 *
 * Renders search results from search:: handler.
 * Click to navigate, Cmd+Click for horizontal split, Cmd+Shift+Click for vertical.
 *
 * @see docs/handoffs/search-plugin-spec.md
 */

import { For, Show } from 'solid-js';
import type { SearchResultsData, SearchResult, SearchErrorData } from '../../lib/handlers/search';
import { truncateContent } from '../../lib/handlers/search';
import {
  navigateToBlock,
  highlightBlock,
  type SplitDirection,
} from '../../lib/navigation';

// Platform detection (matches keybinds.ts)
const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);

interface SearchResultsViewProps {
  data: SearchResultsData;
  paneId: string;
}

/**
 * Format score as percentage-like display
 */
function formatScore(score: number): string {
  // Tantivy scores vary widely; normalize for display
  if (score >= 1) return score.toFixed(1);
  return (score * 100).toFixed(0) + '%';
}

/**
 * Extract modifier keys from mouse or keyboard event
 */
function getModifiers(e: MouseEvent | KeyboardEvent): { modKey: boolean; shiftKey: boolean } {
  const modKey = isMac ? e.metaKey : e.ctrlKey;
  return { modKey, shiftKey: e.shiftKey };
}

/**
 * Individual search result item
 */
function SearchResultItem(props: {
  result: SearchResult;
  paneId: string;
}) {
  /**
   * Navigate to the result block with optional split based on modifiers
   */
  const navigateToResult = (modifiers: { modKey: boolean; shiftKey: boolean }) => {
    let splitDirection: SplitDirection = 'none';
    if (modifiers.modKey) {
      splitDirection = modifiers.shiftKey ? 'vertical' : 'horizontal';
    }

    const result = navigateToBlock(props.result.blockId, {
      paneId: props.paneId,
      splitDirection,
      highlight: true,
    });

    if (!result.success) {
      console.warn('[SearchResultsView] Navigation failed:', result.error);
    }
  };

  const handleClick = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    navigateToResult(getModifiers(e));
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      navigateToResult(getModifiers(e));
    }
  };

  return (
    <div
      class="search-result-item"
      onClick={handleClick}
      role="button"
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      <div class="search-result-main">
        <Show when={props.result.parentPath}>
          <div class="search-result-path">{props.result.parentPath}</div>
        </Show>
        <div class="search-result-content">
          <Show when={props.result.blockType}>
            <span class={`search-result-type type-${props.result.blockType}`}>
              {props.result.blockType}
            </span>
          </Show>
          <pre class="search-result-text">{truncateContent(props.result.content)}</pre>
        </div>
      </div>
      <div class="search-result-score">
        {formatScore(props.result.score)}
      </div>
    </div>
  );
}

export function SearchResultsView(props: SearchResultsViewProps) {
  const stats = () => {
    const d = props.data;
    return `${d.total} result${d.total !== 1 ? 's' : ''} in ${d.durationMs.toFixed(0)}ms`;
  };

  return (
    <div class="search-results-view">
      <div class="search-results-header">
        <div class="search-results-query">
          <span class="search-query-label">Search:</span>
          <span class="search-query-text">{props.data.query}</span>
        </div>
        <div class="search-results-stats">{stats()}</div>
      </div>

      <Show when={props.data.results.length > 0} fallback={
        <div class="search-results-empty">No results found for "{props.data.query}"</div>
      }>
        <div class="search-results-list">
          <For each={props.data.results}>
            {(result) => (
              <SearchResultItem result={result} paneId={props.paneId} />
            )}
          </For>
        </div>
      </Show>

      <div class="search-results-hint">
        Click to navigate{isMac ? ', Cmd+Click for split' : ', Ctrl+Click for split'}
      </div>
    </div>
  );
}

interface SearchErrorViewProps {
  data: SearchErrorData;
}

export function SearchErrorView(props: SearchErrorViewProps) {
  return (
    <div class="search-error">
      <span class="search-error-icon">!</span>
      <span class="search-error-text">{props.data.error}</span>
    </div>
  );
}
