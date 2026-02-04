/**
 * Search Results View Component (display-only)
 *
 * Renders search:: block results with clickable navigation.
 * - Click result → navigate to block (zoom)
 * - Cmd+Click → open in horizontal split
 * - Cmd+Shift+Click → open in vertical split
 * - Click breadcrumb → expand surrounding context in-place
 *
 * Keyboard navigation is handled by BlockItem's handleOutputBlockKeyDown.
 * Focus stays on the output block wrapper (outputFocusRef) — this component
 * only renders the visual focus state via focusedIdx prop.
 */

import { For, Show, createSignal, createEffect, createMemo } from 'solid-js';
import type { SearchResults, SearchHit } from '../../lib/handlers/search';
import { navigateToBlock } from '../../lib/navigation';
import { blockStore } from '../../hooks/useBlockStore';

interface SearchResultsViewProps {
  data: SearchResults;
  paneId?: string;
  /** ID of the search output block (for originBlockId in navigation) */
  blockId?: string;
  /** Signal accessor for which result is keyboard-focused (-1 = none) */
  focusedIdx?: () => number;
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
 * Build breadcrumb trail by walking parent chain.
 * Returns array of { label, blockId } for clickable segments.
 */
function getBreadcrumbs(blockId: string): { label: string; blockId: string }[] {
  const crumbs: { label: string; blockId: string }[] = [];
  const block = blockStore.getBlock(blockId);
  let current = block?.parentId ? blockStore.getBlock(block.parentId) : undefined;
  while (current) {
    const label = (current.content || '').replace(/\n/g, ' ').trim().slice(0, 30);
    if (label) crumbs.unshift({ label, blockId: current.id });
    current = current.parentId ? blockStore.getBlock(current.parentId) : undefined;
  }
  return crumbs;
}

/**
 * Get surrounding sibling blocks for context expansion.
 * Returns up to `radius` siblings before and after the target.
 */
function getSurroundingContext(blockId: string, radius: number = 2): { before: string[]; after: string[] } {
  const block = blockStore.getBlock(blockId);
  if (!block?.parentId) return { before: [], after: [] };

  const parent = blockStore.getBlock(block.parentId);
  if (!parent?.childIds) return { before: [], after: [] };

  const idx = parent.childIds.indexOf(blockId);
  if (idx === -1) return { before: [], after: [] };

  const before = parent.childIds.slice(Math.max(0, idx - radius), idx)
    .map(id => blockStore.getBlock(id)?.content || '')
    .filter(c => c.trim());
  const after = parent.childIds.slice(idx + 1, idx + 1 + radius)
    .map(id => blockStore.getBlock(id)?.content || '')
    .filter(c => c.trim());

  return { before, after };
}

/**
 * Get children of an ancestor block for breadcrumb peek.
 * Returns child IDs, content, and whether each child is on the ancestor path.
 */
function getAncestorChildren(
  ancestorId: string,
  highlightId: string
): { id: string; content: string; isOnPath: boolean }[] {
  const ancestor = blockStore.getBlock(ancestorId);
  if (!ancestor?.childIds?.length) return [];
  return ancestor.childIds.map(id => {
    const child = blockStore.getBlock(id);
    return {
      id,
      content: (child?.content || '').replace(/\n/g, ' ').trim().slice(0, 80),
      isOnPath: id === highlightId,
    };
  });
}

/**
 * Row types for inline breadcrumb tree expansion.
 * - trail: a flat segment of crumbs with clickable separators
 * - child: a non-on-path sibling item, navigable
 */
type BreadcrumbRow =
  | { type: 'trail'; depth: number; crumbs: { label: string; blockId: string }[]; hasOpenPeek: boolean }
  | { type: 'child'; depth: number; id: string; content: string };

/**
 * Pure recursive row builder for inline breadcrumb tree.
 *
 * Walks the crumb trail, splitting at open peek points into
 * trail rows (on-path continuation) and child rows (siblings).
 */
function buildBreadcrumbRows(
  crumbs: { label: string; blockId: string }[],
  openPeeks: Set<number>,
  fromIdx: number,
  depth: number,
): BreadcrumbRow[] {
  if (fromIdx >= crumbs.length) return [];

  // Find next open peek separator after fromIdx
  // Separator i sits between crumbs[i-1] and crumbs[i], so valid peeks are > fromIdx
  let nextPeek = -1;
  for (let i = fromIdx + 1; i < crumbs.length; i++) {
    if (openPeeks.has(i)) { nextPeek = i; break; }
  }

  if (nextPeek === -1) {
    // No more open peeks — emit remaining trail as one row
    return [{ type: 'trail', depth, crumbs: crumbs.slice(fromIdx), hasOpenPeek: false }];
  }

  const rows: BreadcrumbRow[] = [];

  // Emit trail segment up to the peek point (inclusive of the ancestor)
  rows.push({
    type: 'trail',
    depth,
    crumbs: crumbs.slice(fromIdx, nextPeek),
    hasOpenPeek: true,
  });

  // Get children of the ancestor (crumbs[nextPeek-1]) to show siblings
  const ancestor = crumbs[nextPeek - 1];
  const onPathChild = crumbs[nextPeek];
  const children = getAncestorChildren(ancestor.blockId, onPathChild.blockId);

  for (const child of children) {
    if (child.isOnPath) {
      // On-path child → recurse with remaining trail
      rows.push(...buildBreadcrumbRows(crumbs, openPeeks, nextPeek, depth + 1));
    } else {
      // Sibling → leaf child row
      rows.push({ type: 'child', depth: depth + 1, id: child.id, content: child.content || '(empty)' });
    }
  }

  return rows;
}

function SearchResultItem(props: {
  hit: SearchHit;
  paneId?: string;
  blockId?: string;
  isFocused?: boolean;
  index: number;
}) {
  const [expanded, setExpanded] = createSignal(false);
  // Set of open separator indices (supports multiple concurrent peeks)
  // Separator at position i sits between crumbs[i-1] and crumbs[i]
  const [peekIndices, setPeekIndices] = createSignal<Set<number>>(new Set());

  // Memoize parent chain walk — only recalculates when blockId changes
  const crumbs = createMemo(() => getBreadcrumbs(props.hit.blockId));

  // Memoize context — only computed when expanded
  const ctx = createMemo(() => expanded() ? getSurroundingContext(props.hit.blockId) : null);

  // Build breadcrumb rows from crumbs + open peeks
  const breadcrumbRows = createMemo(() => {
    const crumbList = crumbs();
    const openPeeks = peekIndices();
    if (!crumbList.length) return [];
    return buildBreadcrumbRows(crumbList, openPeeks, 0, 0);
  });

  const handleClick = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    let splitDirection: 'horizontal' | 'vertical' | undefined;
    if (e.metaKey || e.ctrlKey) {
      splitDirection = e.shiftKey ? 'vertical' : 'horizontal';
    }

    navigateToBlock(props.hit.blockId, {
      paneId: props.paneId,
      splitDirection,
      highlight: true,
      originBlockId: props.blockId,
    });
  };

  const toggleExpand = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setExpanded(!expanded());
  };

  /**
   * Toggle a separator peek. The separatorIdx is the global index
   * in the crumbs array (between crumbs[idx-1] and crumbs[idx]).
   */
  const togglePeek = (separatorIdx: number, e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const next = new Set(peekIndices());
    if (next.has(separatorIdx)) next.delete(separatorIdx); else next.add(separatorIdx);
    setPeekIndices(next);
  };

  /**
   * Compute the global crumb index for a crumb within a trail row.
   * Trail rows have a slice of the original crumbs array — we match by blockId
   * to recover the original index for separator toggle.
   */
  const getGlobalCrumbIndex = (crumb: { blockId: string }): number => {
    const allCrumbs = crumbs();
    return allCrumbs.findIndex(c => c.blockId === crumb.blockId);
  };

  return (
    <div
      class="search-result-item"
      id={`search-hit-${props.index}`}
      role="option"
      aria-selected={props.isFocused ?? false}
      classList={{ 'search-result-expanded': expanded(), 'search-result-focused': props.isFocused ?? false }}
    >
      {/* Inline breadcrumb tree */}
      <Show when={crumbs().length > 0}>
        <div class="search-result-breadcrumbs">
          <For each={breadcrumbRows()}>
            {(row) => {
              if (row.type === 'trail') {
                return (
                  <div
                    class="search-breadcrumb-line"
                    style={{ 'padding-left': `${row.depth * 12}px` }}
                  >
                    <For each={row.crumbs}>
                      {(crumb, i) => {
                        const globalIdx = getGlobalCrumbIndex(crumb);
                        return (
                          <>
                            <Show when={i() > 0}>
                              <span
                                class="search-breadcrumb-sep"
                                classList={{ 'search-breadcrumb-sep-active': peekIndices().has(globalIdx) }}
                                onClick={[togglePeek, globalIdx]}
                                title="Peek siblings"
                              >
                                ▸
                              </span>
                            </Show>
                            <span
                              class="search-breadcrumb-segment"
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                navigateToBlock(crumb.blockId, { paneId: props.paneId, highlight: true, originBlockId: props.blockId });
                              }}
                            >
                              {crumb.label}
                            </span>
                          </>
                        );
                      }}
                    </For>
                    {/* Trailing glyph: ▾ if peek is open, ▸ for the next separator if available */}
                    <Show when={row.hasOpenPeek && row.crumbs.length > 0}>
                      {(() => {
                        const lastCrumb = row.crumbs[row.crumbs.length - 1];
                        const peekIdx = getGlobalCrumbIndex(lastCrumb) + 1;
                        return (
                          <span
                            class="search-breadcrumb-sep search-breadcrumb-sep-active"
                            onClick={[togglePeek, peekIdx]}
                            title="Close peek"
                          >
                            ▾
                          </span>
                        );
                      })()}
                    </Show>
                    <Show when={!row.hasOpenPeek && row.crumbs.length > 0}>
                      {(() => {
                        const lastCrumb = row.crumbs[row.crumbs.length - 1];
                        const lastGlobalIdx = getGlobalCrumbIndex(lastCrumb);
                        const nextIdx = lastGlobalIdx + 1;
                        // Only show trailing ▸ if there's a next crumb to peek into
                        return (
                          <Show when={nextIdx < crumbs().length}>
                            <span
                              class="search-breadcrumb-sep"
                              onClick={[togglePeek, nextIdx]}
                              title="Peek siblings"
                            >
                              ▸
                            </span>
                          </Show>
                        );
                      })()}
                    </Show>
                  </div>
                );
              }
              // child row
              return (
                <div
                  class="search-breadcrumb-line search-breadcrumb-child"
                  style={{ 'padding-left': `${row.depth * 12}px` }}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    navigateToBlock(row.id, { paneId: props.paneId, highlight: true, originBlockId: props.blockId });
                  }}
                >
                  <span class="search-breadcrumb-child-arrow">▸</span>
                  <span class="search-breadcrumb-child-label">{row.content}</span>
                </div>
              );
            }}
          </For>
        </div>
      </Show>

      {/* Main result row */}
      <div class="search-result-row" onClick={handleClick}>
        <span class="search-result-content">{truncate(props.hit.content, expanded() ? 300 : 100)}</span>
        <div class="search-result-actions">
          <Show when={props.hit.score > 0}>
            <span class="search-result-score">{(props.hit.score * 100).toFixed(0)}%</span>
          </Show>
          <span
            class="search-result-expand-btn"
            onClick={toggleExpand}
            aria-label={expanded() ? 'Collapse context' : 'Show more context'}
            title={expanded() ? 'Less' : 'More context'}
          >
            {expanded() ? '▴' : '▾'}
          </span>
        </div>
      </div>

      {/* Expanded context: surrounding siblings */}
      <Show when={ctx()}>
        {(ctxData) => (
          <div class="search-result-context">
            <For each={ctxData().before}>
              {(text) => (
                <div class="search-context-line search-context-before">
                  {truncate(text, 120)}
                </div>
              )}
            </For>
            <div class="search-context-line search-context-match">
              {truncate(props.hit.content, 300)}
            </div>
            <For each={ctxData().after}>
              {(text) => (
                <div class="search-context-line search-context-after">
                  {truncate(text, 120)}
                </div>
              )}
            </For>
          </div>
        )}
      </Show>
    </div>
  );
}

/**
 * Main search results view (display-only)
 *
 * Keyboard navigation is handled by BlockItem's handleOutputBlockKeyDown.
 * Focus stays on outputFocusRef (the output block wrapper) — this view
 * only renders visual state via the focusedIdx prop.
 */
export function SearchResultsView(props: SearchResultsViewProps) {
  let listRef: HTMLDivElement | undefined;

  const getFocusedIdx = () => props.focusedIdx?.() ?? -1;

  // Scroll focused result into view
  createEffect(() => {
    const idx = getFocusedIdx();
    if (idx >= 0 && listRef) {
      const items = listRef.querySelectorAll('.search-result-item');
      items[idx]?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    }
  });

  return (
    <div
      class="search-results-view"
      ref={listRef}
      role="listbox"
      aria-label={`Search results for "${props.data.query}"`}
      aria-activedescendant={getFocusedIdx() >= 0 ? `search-hit-${getFocusedIdx()}` : undefined}
    >
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
            {(hit, i) => (
              <SearchResultItem
                hit={hit}
                paneId={props.paneId}
                blockId={props.blockId}
                isFocused={getFocusedIdx() === i()}
                index={i()}
              />
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
