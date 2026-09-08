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
 * U3b: expand-in-place slice + crumb-segment ring dial (D4/D8). U3c:
 * revision-churn clustering — a cluster renders its LATEST revision with a
 * `⊟ N rev` chip that unstacks the older ones (D10/D10d).
 *
 * Rows are display-only per output-block-patterns.md §2; the interactive
 * elements are real controls (input/select/button), never focus-managed
 * row bodies.
 */

import { createEffect, createMemo, createSignal, For, on, Show } from 'solid-js';
import { Key } from '@solid-primitives/keyed';
import type { BacklinkGroup } from '../lib/backlinkScope';
import {
  DEFAULT_REF_FILTER,
  DEFAULT_RING,
  applyRefFilter,
  buildFacetChips,
  buildRowModel,
  buildSlice,
  clearFacets,
  clusterChurn,
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

  // U3c: which churn clusters are unstacked (keyed group:frontId). Ephemeral.
  const [churnOpen, setChurnOpen] = createSignal<ReadonlySet<string>>(new Set());
  const toggleChurn = (key: string) => {
    setChurnOpen((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Scope identity: when the group set changes (focus/zoom moved), stale
  // facet selections and ring state from the previous target would silently
  // blank or mis-expand the new target's refs — reset both. on() keeps the
  // effect from tracking anything else (solidjs-patterns.md §7).
  const scopeIdentity = createMemo(() =>
    props.groups.map((group) => `${group.kind}:${group.targetId}`).join('|'));
  createEffect(on(scopeIdentity, (_current, previous) => {
    if (previous === undefined) return;
    setFilter({ ...DEFAULT_REF_FILTER });
    setExpanded(new Map());
    setChurnOpen(new Set());
  }, { defer: true }));

  const deps = (): RowDeps => ({
    getBlock: props.getBlock,
    pagesContainerId: props.pagesContainerId,
  });

  /** Unresolvable source ids render as id-prefix stubs instead of silently
   *  vanishing (index momentarily ahead of the store during sync) — keeps
   *  every count honest against the ⟲ chip. */
  const stubRow = (id: string): BacklinkRowModel => ({
    id,
    kind: 'content_block',
    contentLine: id.slice(0, 8),
    chain: [],
    childPreview: null,
    childCount: 0,
    supersedes: null,
    age: '',
    updatedAt: 0,
    createdAt: 0,
    pageName: null,
    facetKeys: new Set<string>(),
  });

  /** Row models per group, built once per (groups, store) change. */
  const groupRows = createMemo(() => props.groups.map((group) => ({
    group,
    rows: group.sourceIds.map((id) => buildRowModel(id, deps()) ?? stubRow(id)),
  })));

  /** Distinct rows across groups — facet counts are drawer-wide (D7). */
  const allRows = createMemo(() => {
    const seen = new Map<string, BacklinkRowModel>();
    for (const { rows } of groupRows()) {
      for (const row of rows) seen.set(row.id, row);
    }
    return [...seen.values()];
  });

  // Contextual: counts reflect the current filter; would-be-zero chips
  // vanish, active chips always survive so selections can be un-toggled.
  const facetChips = createMemo(() => buildFacetChips(allRows(), filter()));

  const filteredGroups = createMemo(() => groupRows().map(({ group, rows }) => {
    const shown = applyRefFilter(rows, filter());
    return {
      group,
      total: rows.length,
      rows: shown,
      // D10: cluster the SORTED list — a cluster sits where its
      // earliest-sorted (heaviest) member sat.
      clusters: clusterChurn(shown),
    };
  }));

  /** Every visible row's expand key — the expand-all target set. */
  const visibleExpandKeys = createMemo(() => filteredGroups().flatMap((entry) =>
    entry.rows.map((row) => `${entry.group.kind}:${entry.group.targetId}:${row.id}`)));
  const allExpanded = createMemo(() => {
    const keys = visibleExpandKeys();
    return keys.length > 0 && keys.every((key) => expanded().has(key));
  });
  const toggleExpandAll = () => {
    if (allExpanded()) {
      setExpanded(new Map());
      return;
    }
    setExpanded(new Map(visibleExpandKeys().map((key) => [key, DEFAULT_RING])));
  };

  // One deduped row set feeds the n-of-N line — per-group sums double-count
  // a source that references both the focal block and its page.
  const totalShown = createMemo(() => applyRefFilter(allRows(), filter()).length);
  const totalRows = createMemo(() => allRows().length);
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
        <button
          class="blockref-expand-all"
          aria-pressed={allExpanded()}
          title={allExpanded() ? 'Collapse all context slices' : 'Expand all context slices'}
          onClick={toggleExpandAll}
        >
          {allExpanded() ? '▾ all' : '▸ all'}
        </button>
      </div>

      <Show when={facetChips().length > 0}>
        <div class="blockref-facets" title="click adds · shift+click removes">
          {/* Key by facet key: contextual chips rebuild as objects on every
              filter change — reference-keyed <For> would remount every
              button per click (solidjs-patterns.md §1). */}
          <Key each={facetChips()} by={(chip) => chip.key}>
            {(chip) => (
              <button
                class="blockref-facet-chip"
                aria-pressed={filter().includes.has(chip().key) || filter().removes.has(chip().key)}
                classList={{
                  'facet-inc': filter().includes.has(chip().key),
                  'facet-exc': filter().removes.has(chip().key),
                  [`facet-kind-${chip().kind}`]: true,
                }}
                onClick={(e) => onChipClick(chip().key, e.shiftKey)}
              >
                <span class="facet-kind">{chip().kind}</span>
                {chip().label}
                <span class="facet-count">{chip().count}</span>
              </button>
            )}
          </Key>
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
            onClick={() => setFilter((f) => ({ ...f, search: '', includes: new Set(), removes: new Set() }))}
          >
            clear filters
          </button>
        </div>
      </Show>
      {/* U4: every resolved group renders — the page group is the
          always-present identity even at zero sources (D6).
          Key by identity, NOT reference: group wrappers and row models are
          rebuilt objects on every filter/store change — reference-keyed
          <For> remounted every row per recompute, and each remount forced
          WebKit to re-run updateEventRegionsRecursive over the whole
          outline's layer tree (the 2026-09-08 4AM unresponsive-app wedge;
          solidjs-patterns.md §1 / CLAUDE.md Fatal Mistake #2). */}
      <Key each={filteredGroups()} by={(entry) => `${entry.group.kind}:${entry.group.targetId}`}>
          {(entry) => (
            <>
              <div class="backlink-drawer-group">
                <div class="backlink-drawer-group-header">
                  <span class="backlink-drawer-group-kind">
                    {entry().group.kind === 'focal' ? 'this block' : 'page'}
                  </span>
                  <span class="backlink-drawer-group-label">{props.labelFor(entry().group.targetId)}</span>
                  <span class="backlink-drawer-group-count">
                    {entry().rows.length === entry().total ? entry().total : `${entry().rows.length}/${entry().total}`}
                  </span>
                </div>
                <Show when={entry().total === 0}>
                  <div class="blockref-row-none">no references yet</div>
                </Show>
                {/* U3c: clusters, keyed by their front row. A cluster with
                    older revisions shows `⊟ N rev`; unstacking renders the
                    rest as full rows beneath the front. */}
                <Key each={entry().clusters} by={(cluster) => cluster.front.id}>
                  {(cluster) => {
                    const groupKey = () => `${entry().group.kind}:${entry().group.targetId}`;
                    const churnKey = () => `${groupKey()}:${cluster().front.id}`;
                    const isUnstacked = () => churnOpen().has(churnKey());
                    return (
                      <>
                        <RefRow
                          row={cluster().front}
                          groupKey={groupKey()}
                          revisions={cluster().rest.length}
                          churnOpen={isUnstacked()}
                          onToggleChurn={() => toggleChurn(churnKey())}
                          expanded={expanded()}
                          onToggleExpand={toggleExpand}
                          onSetRing={setRing}
                          getBlock={props.getBlock}
                          pagesContainerId={props.pagesContainerId}
                          onNavigate={props.onNavigate}
                        />
                        <Show when={isUnstacked() && cluster().rest.length > 0}>
                          <div class="blockref-churn-stack">
                            <Key each={cluster().rest} by={(older) => older.id}>
                              {(older) => (
                                <RefRow
                                  row={older()}
                                  groupKey={groupKey()}
                                  revisions={0}
                                  churnOpen={false}
                                  onToggleChurn={() => {}}
                                  expanded={expanded()}
                                  onToggleExpand={toggleExpand}
                                  onSetRing={setRing}
                                  getBlock={props.getBlock}
                                  pagesContainerId={props.pagesContainerId}
                                  onNavigate={props.onNavigate}
                                />
                              )}
                            </Key>
                          </div>
                        </Show>
                      </>
                    );
                  }}
                </Key>
              </div>
            </>
          )}
        </Key>
    </div>
  );
}

interface RefRowProps {
  row: BacklinkRowModel;
  groupKey: string;
  /** Older revisions folded behind this row (0 = not a cluster front). */
  revisions: number;
  churnOpen: boolean;
  onToggleChurn: () => void;
  expanded: ReadonlyMap<string, number>;
  onToggleExpand: (expandKey: string) => void;
  onSetRing: (expandKey: string, ring: number) => void;
  getBlock: RowDeps['getBlock'];
  pagesContainerId: string | null;
  onNavigate: (sourceBlockId: string) => void;
}

function RefRow(props: RefRowProps) {
  // Expand state is group-scoped: a source appearing in both the focal and
  // page groups expands independently.
  const expandKey = () => `${props.groupKey}:${props.row.id}`;
  const ring = () => props.expanded.get(expandKey());
  const isOpen = () => props.expanded.has(expandKey());
  const slice = createMemo(() => (isOpen()
    ? buildSlice(props.row, ring() ?? DEFAULT_RING, {
      getBlock: props.getBlock,
      pagesContainerId: props.pagesContainerId,
    })
    : null));

  return (
    <div class="blockref-row-wrap">
      <div class="blockref-row" data-source-block-id={props.row.id}>
        <span class={`blockref-kind blockref-kind-${props.row.kind}`}>{KIND_DOT[props.row.kind]}</span>
        <div class="blockref-main">
          <Show when={props.row.chain.length > 0}>
            {/* D8: crumb segments ARE the context dial — each re-roots the
                expand-in-place slice at that ancestor. Keyed by segment id:
                crumbEntries() allocates fresh objects per rebuild. */}
            <div class="blockref-crumb">
              <Key
                each={crumbEntries(props.row.chain)}
                by={(crumbEntry) => (crumbEntry.gap ? 'gap' : `seg:${crumbEntry.segment.id}`)}
              >
                {(crumbEntry, index) => (
                  <>
                    <Show when={index() > 0}>
                      <span class="blockref-crumb-sep">›</span>
                    </Show>
                    <Show
                      when={!crumbEntry().gap}
                      fallback={<span class="blockref-crumb-sep" title="levels elided">⋯</span>}
                    >
                      <button
                        class="blockref-crumb-seg"
                        classList={{
                          'crumb-live': (() => {
                            const e = crumbEntry();
                            if (e.gap) return false;
                            // DEFAULT_RING roots at the last chain index —
                            // light that segment so dial and slice agree.
                            const effectiveRing = ring() === DEFAULT_RING
                              ? props.row.chain.length - 1
                              : ring();
                            return isOpen() && effectiveRing === e.index;
                          })(),
                        }}
                        title={(() => { const e = crumbEntry(); return e.gap ? '' : `expand slice rooted at ${e.segment.label}`; })()}
                        onClick={() => { const e = crumbEntry(); if (!e.gap) props.onSetRing(expandKey(), e.index); }}
                      >
                        {/* chain labels are canonical — truncate at render only (D9) */}
                        {(() => { const e = crumbEntry(); return e.gap ? '' : midTruncate(e.segment.label, 28); })()}
                      </button>
                    </Show>
                  </>
                )}
              </Key>
            </div>
          </Show>
          {/* D3: row body inert — no click handler */}
          <div class="blockref-content">{props.row.contentLine}</div>
          <Show when={!isOpen() && props.row.childPreview !== null}>
            <div class="blockref-child-preview">
              └ {props.row.childPreview}
              <Show when={props.row.childCount > 1}>
                <span class="blockref-child-more"> +{props.row.childCount - 1}</span>
              </Show>
            </div>
          </Show>
        </div>
        <Show when={props.revisions > 0}>
          <button
            class="blockref-churn"
            classList={{ 'churn-open': props.churnOpen }}
            aria-pressed={props.churnOpen}
            title="near-identical revisions collapsed — click to unstack"
            onClick={props.onToggleChurn}
          >
            ⊟ {props.revisions + 1} rev
          </button>
        </Show>
        <span
          class="blockref-age"
          title={[
            props.row.updatedAt ? `updated ${new Date(props.row.updatedAt).toLocaleString()}` : null,
            props.row.createdAt ? `created ${new Date(props.row.createdAt).toLocaleString()}` : null,
          ].filter(Boolean).join(' · ') || undefined}
        >
          {props.row.age}
        </span>
        <button
          class="blockref-expand"
          classList={{ 'expand-open': isOpen() }}
          aria-label={isOpen() ? 'Collapse context slice' : 'Expand context in place'}
          aria-expanded={isOpen()}
          title="expand in place"
          onClick={() => props.onToggleExpand(expandKey())}
        >
          {isOpen() ? '▾' : '▸'}
        </button>
        <button
          class="blockref-nav"
          aria-label="Navigate to source block"
          title="Go to source"
          onClick={() => props.onNavigate(props.row.id)}
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
            <Key each={currentSlice().lines} by={(line) => `${line.role}:${line.id}`}>
              {(line) => (
                <div
                  class={`blockref-slice-line slice-${line().role}`}
                  style={{ 'margin-left': `${line().depth * 14}px` }}
                >
                  <span class="blockref-slice-bullet">•</span>
                  <span class="blockref-slice-text">{line().text}</span>
                </div>
              )}
            </Key>
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
}
