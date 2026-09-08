/**
 * BlockRefList — U3a shared row renderer (FLO-440 slice 3).
 *
 * The component the backlink drawer (and later consumers: FLO-833 search
 * surface, FLO-887 ToC-adjacent) renders rows through. U3a scope: rows
 * (kind dot · crumb · content · age), drawer-wide facet bar (D7), free-text
 * filter, compound sorts (D10c), filtered-empty state, and the explicit
 * navigate affordance (D3: the row BODY stays inert; navigation is a real
 * button routed by the HOST through the navigation funnel — this component
 * never touches panes or navigation itself).
 *
 * U3b (expand-in-place slice + context-radius dial) and U3c (churn
 * clustering) land here later — do not grow them ad hoc.
 *
 * Rows are display-only per output-block-patterns.md §2; the interactive
 * elements are real controls (input/select/button), never focus-managed
 * row bodies.
 */

import { createMemo, createSignal, For, Show } from 'solid-js';
import type { BacklinkGroup } from '../lib/backlinkScope';
import {
  DEFAULT_REF_FILTER,
  DEFAULT_RING,
  applyRefFilter,
  buildFacetChips,
  buildRowModel,
  buildSlice,
  clearFacets,
  crumbEntries,
  midTruncate,
  toggleFacet,
  type BacklinkRowModel,
  type RefFilter,
  type RowDeps,
  type SortMode,
} from '../lib/backlinkRows';

interface BlockRefListProps {
  groups: BacklinkGroup[];
  getBlock: RowDeps['getBlock'];
  pagesContainerId: string | null;
  /** Host resolves panes + routes through lib/navigation.ts. */
  onNavigate: (sourceBlockId: string) => void;
  /** Label for a group target (host already derives these). */
  labelFor: (blockId: string) => string;
}

const KIND_DOT: Record<BacklinkRowModel['kind'], string> = {
  nav_node: '◆',
  content_block: '•',
  leaf_marker: '·',
};

const SORT_LABELS: Array<{ value: SortMode; label: string }> = [
  { value: 'updated', label: 'updated' },
  { value: 'created', label: 'created' },
  { value: 'page', label: 'page' },
];

export function BlockRefList(props: BlockRefListProps) {
  // Drawer-wide, ephemeral view state — deliberately NOT persisted.
  const [filter, setFilter] = createSignal<RefFilter>(DEFAULT_REF_FILTER);
  // U3b expand-in-place: rowId → ring (DEFAULT_RING = parent+source+children;
  // a crumb-segment index re-roots the slice there, D8). Ephemeral.
  const [expanded, setExpanded] = createSignal<ReadonlyMap<string, number>>(new Map());

  const toggleExpand = (rowId: string) => {
    setExpanded((current) => {
      const next = new Map(current);
      if (next.has(rowId)) next.delete(rowId);
      else next.set(rowId, DEFAULT_RING);
      return next;
    });
  };

  const setRing = (rowId: string, ring: number) => {
    setExpanded((current) => {
      const next = new Map(current);
      if (next.get(rowId) === ring) next.delete(rowId);
      else next.set(rowId, ring);
      return next;
    });
  };

  const deps = (): RowDeps => ({
    getBlock: props.getBlock,
    pagesContainerId: props.pagesContainerId,
  });

  /** Row models per group, built once per (groups, store) change. */
  const groupRows = createMemo(() => props.groups.map((group) => ({
    group,
    rows: group.sourceIds
      .map((id) => buildRowModel(id, deps()))
      .filter((row): row is BacklinkRowModel => row !== null),
  })));

  /** Distinct rows across groups — facet counts are drawer-wide (D7). */
  const allRows = createMemo(() => {
    const seen = new Map<string, BacklinkRowModel>();
    for (const { rows } of groupRows()) {
      for (const row of rows) seen.set(row.id, row);
    }
    return [...seen.values()];
  });

  const facetChips = createMemo(() => buildFacetChips(allRows()));

  const filteredGroups = createMemo(() => groupRows().map(({ group, rows }) => ({
    group,
    total: rows.length,
    rows: applyRefFilter(rows, filter()),
  })));

  const totalShown = createMemo(() => filteredGroups().reduce((n, g) => n + g.rows.length, 0));
  const totalRows = createMemo(() => filteredGroups().reduce((n, g) => n + g.total, 0));
  const filtersActive = () =>
    filter().search !== '' || filter().includes.size > 0 || filter().removes.size > 0;

  const onChipClick = (key: string, shiftKey: boolean) => {
    setFilter((current) => toggleFacet(current, key, shiftKey));
  };

  return (
    <div class="blockref-list">
      <div class="blockref-controls">
        <input
          class="blockref-search"
          type="text"
          placeholder="filter refs…"
          value={filter().search}
          onInput={(e) => setFilter((f) => ({ ...f, search: e.currentTarget.value }))}
        />
        <select
          class="blockref-sort"
          aria-label="Sort backlinks"
          value={filter().sort}
          onChange={(e) => setFilter((f) => ({ ...f, sort: e.currentTarget.value as SortMode }))}
        >
          <For each={SORT_LABELS}>
            {(option) => <option value={option.value}>{option.label}</option>}
          </For>
        </select>
        <button
          class="blockref-sort-dir"
          aria-label={filter().sortAsc ? 'Sort descending' : 'Sort ascending'}
          title="Flip sort direction (primary key only)"
          onClick={() => setFilter((f) => ({ ...f, sortAsc: !f.sortAsc }))}
        >
          {filter().sortAsc ? '↑' : '↓'}
        </button>
        <span class="blockref-count">{totalShown()} of {totalRows()}</span>
      </div>

      <Show when={facetChips().length > 0}>
        <div class="blockref-facets" title="click adds · shift+click removes">
          <For each={facetChips()}>
            {(chip) => (
              <button
                class="blockref-facet-chip"
                classList={{
                  'facet-inc': filter().includes.has(chip.key),
                  'facet-exc': filter().removes.has(chip.key),
                  [`facet-kind-${chip.kind}`]: true,
                }}
                onClick={(e) => onChipClick(chip.key, e.shiftKey)}
              >
                <span class="facet-kind">{chip.kind}</span>
                {chip.label}
                <span class="facet-count">{chip.count}</span>
              </button>
            )}
          </For>
          <Show when={filter().includes.size > 0 || filter().removes.size > 0}>
            <button
              class="blockref-facet-clear"
              onClick={() => setFilter((f) => clearFacets(f))}
            >
              clear
            </button>
          </Show>
        </div>
      </Show>

      {/* Filtered-empty is distinct from true-empty (D6): shown ABOVE the
          group headers so the always-present groups stay legible. */}
      <Show when={filtersActive() && totalShown() === 0}>
        <div class="blockref-filtered-empty">
          <span>no refs match filter</span>
          <button
            class="blockref-facet-clear"
            onClick={() => setFilter(() => ({ ...DEFAULT_REF_FILTER }))}
          >
            clear filters
          </button>
        </div>
      </Show>
      {/* U4: every resolved group renders — the page group is the
          always-present identity even at zero sources (D6). */}
      <For each={filteredGroups()}>
          {({ group, rows, total }) => (
            <>
              <div class="backlink-drawer-group">
                <div class="backlink-drawer-group-header">
                  <span class="backlink-drawer-group-kind">
                    {group.kind === 'focal' ? 'this block' : 'page'}
                  </span>
                  <span class="backlink-drawer-group-label">{props.labelFor(group.targetId)}</span>
                  <span class="backlink-drawer-group-count">
                    {rows.length === total ? total : `${rows.length}/${total}`}
                  </span>
                </div>
                <Show when={total === 0}>
                  <div class="blockref-row-none">no references yet</div>
                </Show>
                <For each={rows}>
                  {(row) => {
                    const ring = () => expanded().get(row.id);
                    const isOpen = () => expanded().has(row.id);
                    const slice = createMemo(() => (isOpen()
                      ? buildSlice(row, ring() ?? DEFAULT_RING, {
                        getBlock: props.getBlock,
                        pagesContainerId: props.pagesContainerId,
                      })
                      : null));
                    return (
                      <div class="blockref-row-wrap">
                        <div class="blockref-row" data-source-block-id={row.id}>
                          <span class={`blockref-kind blockref-kind-${row.kind}`}>{KIND_DOT[row.kind]}</span>
                          <div class="blockref-main">
                            <Show when={row.chain.length > 0}>
                              {/* D8: crumb segments ARE the context dial — each
                                  re-roots the expand-in-place slice at that
                                  ancestor (prototype-proven interaction). */}
                              <div class="blockref-crumb">
                                <For each={crumbEntries(row.chain)}>
                                  {(entry, index) => (
                                    <>
                                      <Show when={index() > 0}>
                                        <span class="blockref-crumb-sep">›</span>
                                      </Show>
                                      <Show
                                        when={!entry.gap}
                                        fallback={<span class="blockref-crumb-sep" title="levels elided">⋯</span>}
                                      >
                                        <button
                                          class="blockref-crumb-seg"
                                          classList={{ 'crumb-live': !entry.gap && ring() === entry.index }}
                                          title={`expand slice rooted at ${!entry.gap ? entry.segment.label : ''}`}
                                          onClick={() => { if (!entry.gap) setRing(row.id, entry.index); }}
                                        >
                                          {/* chain labels are canonical — truncate at render only (D9) */}
                                          {!entry.gap ? midTruncate(entry.segment.label, 28) : ''}
                                        </button>
                                      </Show>
                                    </>
                                  )}
                                </For>
                              </div>
                            </Show>
                            {/* D3: row body inert — no click handler */}
                            <div class="blockref-content">{row.contentLine}</div>
                            <Show when={!isOpen() && row.childPreview !== null}>
                              <div class="blockref-child-preview">
                                └ {row.childPreview}
                                <Show when={row.childCount > 1}>
                                  <span class="blockref-child-more"> +{row.childCount - 1}</span>
                                </Show>
                              </div>
                            </Show>
                          </div>
                          <span
                            class="blockref-age"
                            title={`updated ${new Date(row.updatedAt).toLocaleString()}${row.createdAt ? ` · created ${new Date(row.createdAt).toLocaleString()}` : ''}`}
                          >
                            {row.age}
                          </span>
                          <button
                            class="blockref-expand"
                            classList={{ 'expand-open': isOpen() }}
                            aria-label={isOpen() ? 'Collapse context slice' : 'Expand context in place'}
                            aria-expanded={isOpen()}
                            title="expand in place"
                            onClick={() => toggleExpand(row.id)}
                          >
                            {isOpen() ? '▾' : '▸'}
                          </button>
                          <button
                            class="blockref-nav"
                            aria-label="Navigate to source block"
                            title="Go to source"
                            onClick={() => props.onNavigate(row.id)}
                          >
                            →
                          </button>
                        </div>
                        <Show when={slice()}>
                          {(currentSlice) => (
                            <div class="blockref-slice">
                              <div class="blockref-slice-note">
                                slice rooted at {currentSlice().rootLabel}
                              </div>
                              <For each={currentSlice().lines}>
                                {(line) => (
                                  <div
                                    class={`blockref-slice-line slice-${line.role}`}
                                    style={{ 'margin-left': `${line.depth * 14}px` }}
                                  >
                                    <span class="blockref-slice-bullet">•</span>
                                    <span class="blockref-slice-text">{line.text}</span>
                                  </div>
                                )}
                              </For>
                              <Show when={currentSlice().moreChildren > 0}>
                                <div class="blockref-slice-more">
                                  +{currentSlice().moreChildren} more child{currentSlice().moreChildren === 1 ? '' : 'ren'}
                                </div>
                              </Show>
                            </div>
                          )}
                        </Show>
                      </div>
                    );
                  }}
                </For>
              </div>
            </>
          )}
        </For>
    </div>
  );
}
