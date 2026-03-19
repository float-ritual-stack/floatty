/**
 * FilterBlockDisplay - Live filter query view
 *
 * Parses children as filter rules and renders matching blocks inline.
 * Subscribes to EventBus for live updates when blocks change.
 *
 * Architecture: Component + EventBus Subscriber (NOT a handler)
 * - Children ARE the filter rules (include, exclude, limit, etc.)
 * - Results render inline, NOT as child blocks
 * - EventBus subscription for live updates with 300ms debounce
 *
 * @see docs/architecture/PATTERN_INTEGRATION_SKETCH.md
 */

import { createSignal, createMemo, createEffect, onCleanup, For, Show } from 'solid-js';
import type { Block } from '../../lib/blockTypes';
import { useWorkspace } from '../../context/WorkspaceContext';
import {
  parseFilterFromChildren,
  executeFilter,
  collectDescendantIds,
  type ParsedFilter,
} from '../../lib/filterParser';
import { blockEventBus, EventFilters } from '../../lib/events';
import { navigateToBlock } from '../../lib/navigation';
import { paneLinkStore } from '../../hooks/usePaneLinkStore';
import { findTabIdByPaneId } from '../../hooks/useBacklinkNavigation';

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

interface FilterBlockDisplayProps {
  block: Block;
  paneId?: string;
}

// ═══════════════════════════════════════════════════════════════
// DEBOUNCE UTILITY
// ═══════════════════════════════════════════════════════════════

const REQUERY_DEBOUNCE_MS = 300;

// ═══════════════════════════════════════════════════════════════
// RESULT CARD
// ═══════════════════════════════════════════════════════════════

function FilterResultCard(props: { block: Block; paneId?: string }) {
  const handleClick = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    // Determine split direction from modifiers
    let splitDirection: 'horizontal' | 'vertical' | undefined;
    if (e.metaKey || e.ctrlKey) {
      splitDirection = e.shiftKey ? 'vertical' : 'horizontal';
    }

    // FLO-378: Resolve pane link at call site (FM #7)
    let targetPaneId = props.paneId;
    if (!splitDirection && targetPaneId) {
      const linkedPaneId = paneLinkStore.resolveLink(targetPaneId);
      if (linkedPaneId) {
        const sourceTab = findTabIdByPaneId(targetPaneId);
        const linkedTab = findTabIdByPaneId(linkedPaneId);
        if (sourceTab && sourceTab === linkedTab) {
          targetPaneId = linkedPaneId;
        }
      }
    }

    navigateToBlock(props.block.id, {
      paneId: targetPaneId,
      splitDirection,
      highlight: true,
    });
  };

  // Truncate content for display
  const displayContent = () => {
    const content = props.block.content.replace(/\n/g, ' ').trim();
    return content.length > 80 ? content.slice(0, 79) + '…' : content;
  };

  // Extract marker badges for display
  const badges = createMemo(() => {
    const markers = props.block.metadata?.markers ?? [];
    // Show up to 3 markers as badges
    return markers.slice(0, 3).map((m) => ({
      type: m.markerType,
      value: m.value,
    }));
  });

  return (
    <div
      class="filter-result-item"
      onClick={handleClick}
      title="Click to navigate, Cmd+Click for split"
    >
      <span class="filter-result-content">{displayContent()}</span>
      <Show when={badges().length > 0}>
        <div class="filter-result-badges">
          <For each={badges()}>
            {(badge) => (
              <span class="filter-badge" data-type={badge.type}>
                {badge.type}
                <Show when={badge.value}>
                  <span class="filter-badge-value">::{badge.value}</span>
                </Show>
              </span>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════

export function FilterBlockDisplay(props: FilterBlockDisplayProps) {
  const { blockStore } = useWorkspace();
  const [results, setResults] = createSignal<Block[]>([]);
  const [lastQueryTime, setLastQueryTime] = createSignal<number>(0);
  const [resultsCollapsed, setResultsCollapsed] = createSignal(false);

  // Get children of this filter block to parse as rules
  const getChildren = () => {
    const block = blockStore.getBlock(props.block.id);
    if (!block) return [];
    return block.childIds
      .map((id) => blockStore.getBlock(id))
      .filter((b): b is Block => b !== undefined);
  };

  // Parse filter from children
  const filter = createMemo<ParsedFilter>(() => {
    const children = getChildren();
    return parseFilterFromChildren(children);
  });

  // IDs to exclude from filter results (the filter block and its children)
  const excludeIds = createMemo(() => {
    return collectDescendantIds(props.block, blockStore.getBlock);
  });

  // Check if we have valid filter rules (not just unrecognized text)
  const hasValidRules = createMemo(() => {
    const f = filter();
    return f.rules.length > 0;
  });

  // Execute filter query
  const runQuery = () => {
    // Don't query if no valid rules - prevents showing "all blocks" as results
    if (!hasValidRules()) {
      setResults([]);
      setLastQueryTime(0);
      return;
    }

    const startTime = performance.now();
    const allBlocks = Object.values(blockStore.blocks);
    const matches = executeFilter(filter(), allBlocks, excludeIds());
    setResults(matches);
    setLastQueryTime(performance.now() - startTime);
  };

  // Initial query
  createEffect(() => {
    // Access filter() to track dependency
    filter();
    runQuery();
  });

  // Subscribe to EventBus for live updates
  createEffect(() => {
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const debouncedRequery = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        runQuery();
      }, REQUERY_DEBOUNCE_MS);
    };

    const subId = blockEventBus.subscribe(
      () => {
        debouncedRequery();
      },
      {
        filter: EventFilters.any(
          EventFilters.creates(),
          EventFilters.updates(),
          EventFilters.deletes()
        ),
        priority: 50,
        name: `filter-${props.block.id}`,
      }
    );

    onCleanup(() => {
      if (debounceTimer) clearTimeout(debounceTimer);
      blockEventBus.unsubscribe(subId);
    });
  });

  // Count of each rule type for display
  const ruleStats = createMemo(() => {
    const f = filter();
    const includes = f.rules.filter((r) => r.operator === 'include').length;
    const excludes = f.rules.filter((r) => r.operator === 'exclude').length;
    return { includes, excludes, limit: f.limit, combinator: f.combinator };
  });

  return (
    <div class="filter-block-display">
      {/* Header with stats */}
      <div class="filter-header">
        <span class="filter-stats">
          <Show when={hasValidRules()}>
            <button
              class="filter-collapse-toggle"
              onClick={() => setResultsCollapsed(!resultsCollapsed())}
              title={resultsCollapsed() ? 'Expand results' : 'Collapse results'}
              aria-label={resultsCollapsed() ? 'Expand results' : 'Collapse results'}
              aria-expanded={!resultsCollapsed()}
            >
              {resultsCollapsed() ? '▶' : '▼'}
            </button>
          </Show>
          {results().length} results
          <Show when={lastQueryTime() > 0}>
            <span class="filter-time"> ({lastQueryTime().toFixed(0)}ms)</span>
          </Show>
        </span>
        <span class="filter-rules-summary">
          <Show when={ruleStats().includes > 0}>
            <span class="filter-rule-count include">
              {ruleStats().includes} include{ruleStats().combinator === 'any' ? ' (OR)' : ''}
            </span>
          </Show>
          <Show when={ruleStats().excludes > 0}>
            <span class="filter-rule-count exclude">{ruleStats().excludes} exclude</span>
          </Show>
          <Show when={ruleStats().limit}>
            <span class="filter-rule-count limit">limit {ruleStats().limit}</span>
          </Show>
        </span>
      </div>

      {/* Errors */}
      <Show when={filter().errors.length > 0}>
        <div class="filter-errors">
          <For each={filter().errors}>
            {(err) => (
              <div class="filter-error">
                <span class="filter-error-icon">⚠️</span>
                <span class="filter-error-content">{err.content}</span>
                <span class="filter-error-msg">{err.error}</span>
              </div>
            )}
          </For>
        </div>
      </Show>

      {/* Results */}
      <Show when={!resultsCollapsed()}>
        <Show
          when={results().length > 0}
          fallback={
            <Show when={filter().rules.length > 0}>
              <div class="filter-no-results">No blocks match this filter</div>
            </Show>
          }
        >
          <div class="filter-results-list">
            <For each={results()}>
              {(block) => <FilterResultCard block={block} paneId={props.paneId} />}
            </For>
          </div>
        </Show>
      </Show>

      {/* Empty state when no rules */}
      <Show when={filter().rules.length === 0 && filter().errors.length === 0}>
        <div class="filter-empty-state">
          <p>Add child blocks to define filter rules:</p>
          <code>include(marker::pattern)</code>
          <code>exclude(status::archived)</code>
          <code>limit(20)</code>
        </div>
      </Show>
    </div>
  );
}
