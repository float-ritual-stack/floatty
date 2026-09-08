/**
 * U3a — BlockRefList row models, facets, filter and sorts (FLO-440 slice 3).
 *
 * Pure functions over plain block lookups — no DOM, no stores. The facet
 * model is PORTED from the Apr-30 qmd-graph-explorer prior art per D7
 * (`~/.floatty/artifacts/floatty-qmd-graph-explorer.html`): facet keys are
 * `page::<name>` / `marker::<type>::<value>` / `link::<target>`, click adds
 * an include, shift+click adds an exclude, includes AND together, excludes
 * subtract, counts are computed over the UNFILTERED row set.
 *
 * Truncation rules are D9: strip wikilink brackets at the LABEL layer (so
 * truncation only ever bites prose), middle-truncate keeping identity front
 * and disambiguation back, hashes exempt, chains elide INTERIOR levels.
 *
 * Sorts are D10c compound: the direction toggle flips the PRIMARY key only;
 * updatedAt-desc rides every mode as the fixed tiebreak (applied inside the
 * comparator — `out.reverse()` would flip the tiebreak too).
 */

import type { Block } from './blockTypes';
import { classifyBacklink, type BacklinkKind } from './backlinkClassify';

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

export type SortMode = 'updated' | 'created' | 'page';

export interface RefFilter {
  search: string;
  sort: SortMode;
  /** Flips the PRIMARY comparator only (D10c). false = newest/Z-first. */
  sortAsc: boolean;
  includes: ReadonlySet<string>;
  removes: ReadonlySet<string>;
}

export const DEFAULT_REF_FILTER: RefFilter = {
  search: '',
  sort: 'updated',
  sortAsc: false,
  includes: new Set(),
  removes: new Set(),
};

export interface ChainSegment {
  id: string;
  label: string;
}

export interface BacklinkRowModel {
  /** Source block id. */
  id: string;
  kind: BacklinkKind;
  /** Raw first line of the source block (rendered with CSS ellipsis). */
  contentLine: string;
  /** Display labels for the ancestor chain, rootmost-first, already elided. */
  crumb: string[];
  /**
   * Full ancestor chain rootmost-first, UN-elided, with ids and CANONICAL
   * (un-truncated) labels — the identity/search surface AND the D8 ring
   * targets (crumb segments re-root the expand-in-place slice). Display
   * truncation happens at render; matching never bites truncated text.
   */
  chain: ChainSegment[];
  /**
   * First child's first line — backlinks frequently land on a parent whose
   * payload lives in the children (Evan, 2026-09-08), so one child rides
   * the row even before expanding.
   */
  childPreview: string | null;
  childCount: number;
  age: string;
  updatedAt: number;
  createdAt: number;
  pageName: string | null;
  facetKeys: ReadonlySet<string>;
}

export interface FacetChip {
  key: string;
  kind: 'page' | 'marker' | 'link';
  label: string;
  count: number;
}

export interface RowDeps {
  getBlock: (id: string) => Pick<Block,
    'id' | 'parentId' | 'childIds' | 'content' | 'createdAt' | 'updatedAt' | 'metadata'
  > | null | undefined;
  /** Id of the `pages::` container (crumb stops there; its child = the page). */
  pagesContainerId: string | null;
}

// ═══════════════════════════════════════════════════════════════
// LABELS + TRUNCATION (D9)
// ═══════════════════════════════════════════════════════════════

/** Compact hex-ish identifiers are exempt from truncation (D9). */
const HASH_RE = /^[0-9a-f-]{6,}$/i;
const WIKILINK_RE = /\[\[([^[\]]*)\]\]/g;
const CRUMB_LABEL_MAX = 28;

/**
 * Strip `[[..]]` at the label layer — alias links keep the alias text.
 * Runs to a fixed point so one nesting level per pass unwraps fully.
 */
export function stripWikilinkBrackets(text: string): string {
  let out = text;
  for (let i = 0; i < 4; i++) {
    const next = out.replace(WIKILINK_RE, (_match, inner: string) => {
      const pipe = inner.lastIndexOf('|');
      return pipe >= 0 ? inner.slice(pipe + 1).trim() : inner;
    });
    if (next === out) break;
    out = next;
  }
  return out;
}

/** Middle-truncate: identity front, disambiguation back; hashes exempt. */
export function midTruncate(text: string, max: number): string {
  if (text.length <= max || HASH_RE.test(text)) return text;
  const front = Math.ceil((max - 1) * 0.6);
  const back = max - 1 - front;
  return `${text.slice(0, front)}…${text.slice(text.length - back)}`;
}

function canonicalCrumb(content: string): string {
  const firstLine = (content.split('\n')[0] ?? '').replace(/^#+\s*/, '');
  return stripWikilinkBrackets(firstLine).trim();
}

export function crumbLabel(content: string, max = CRUMB_LABEL_MAX): string {
  return midTruncate(canonicalCrumb(content), max);
}

/**
 * Chain elision ≠ segment truncation (D9): long chains drop INTERIOR levels
 * (⋯), keeping the root and the leaf-adjacent tail.
 */
export function elideChain(labels: string[], maxLevels = 3): string[] {
  if (labels.length <= maxLevels) return labels;
  return [labels[0], '⋯', ...labels.slice(labels.length - (maxLevels - 1))];
}

// ═══════════════════════════════════════════════════════════════
// AGE
// ═══════════════════════════════════════════════════════════════

const AGE_STEPS: Array<[number, string]> = [
  [60_000, 'now'],
  [3_600_000, 'm'],
  [86_400_000, 'h'],
  [604_800_000, 'd'],
  [2_592_000_000, 'w'],
  [31_536_000_000, 'mo'],
];

export function formatAge(deltaMs: number, now = 0): string {
  const delta = Math.max(0, deltaMs - now);
  if (delta < AGE_STEPS[0][0]) return 'now';
  for (let i = 1; i < AGE_STEPS.length; i++) {
    if (delta < AGE_STEPS[i][0]) {
      return `${Math.floor(delta / AGE_STEPS[i - 1][0])}${AGE_STEPS[i][1]}`;
    }
  }
  return `${Math.floor(delta / AGE_STEPS[AGE_STEPS.length - 1][0])}y`;
}

// ═══════════════════════════════════════════════════════════════
// ROW MODEL
// ═══════════════════════════════════════════════════════════════

export function buildRowModel(
  sourceId: string,
  deps: RowDeps,
  now = Date.now(),
): BacklinkRowModel | null {
  const block = deps.getBlock(sourceId);
  if (!block) return null;

  // Ancestor chain rootmost-first; stop at the pages:: container. Track the
  // nearest page (direct child of the container) for the page:: facet.
  const visited = new Set<string>([sourceId]);
  const chain: ChainSegment[] = [];
  let pageName: string | null = null;
  let currentId = block.parentId;
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const ancestor = deps.getBlock(currentId);
    if (!ancestor) break;
    if (deps.pagesContainerId !== null && ancestor.id === deps.pagesContainerId) break;
    const label = canonicalCrumb(ancestor.content);
    chain.unshift({ id: ancestor.id, label });
    if (deps.pagesContainerId !== null && ancestor.parentId === deps.pagesContainerId) {
      pageName = label;
    }
    currentId = ancestor.parentId;
  }

  const facetKeys = new Set<string>();
  if (pageName) facetKeys.add(`page::${pageName}`);
  for (const marker of block.metadata?.markers ?? []) {
    facetKeys.add(`marker::${marker.markerType}::${marker.value ?? ''}`);
  }
  for (const outlink of block.metadata?.outlinks ?? []) {
    facetKeys.add(`link::${outlink}`);
  }

  const firstChild = block.childIds.length > 0 ? deps.getBlock(block.childIds[0]) : null;

  return {
    id: block.id,
    kind: classifyBacklink(block as Block),
    contentLine: block.content.split('\n')[0] ?? '',
    crumb: elideChain(chain.map((segment) => midTruncate(segment.label, CRUMB_LABEL_MAX))),
    chain,
    childPreview: firstChild ? (firstChild.content.split('\n')[0] ?? '') : null,
    childCount: block.childIds.length,
    age: formatAge(now - (block.updatedAt || block.createdAt || now)),
    updatedAt: block.updatedAt ?? 0,
    createdAt: block.createdAt ?? 0,
    pageName,
    facetKeys,
  };
}

// ═══════════════════════════════════════════════════════════════
// EXPAND-IN-PLACE SLICE (U3b — D4/D8, ported from backlinks-live)
// ═══════════════════════════════════════════════════════════════

/**
 * Ring semantics from the live prototype: `DEFAULT_RING` (-1) is the D4
 * slice — immediate parent + source + children; a crumb segment click
 * re-roots the slice at that ancestor's chain INDEX (D8: the crumb IS the
 * context-radius dial; it only ever widens — expand-only).
 */
export const DEFAULT_RING = -1;
/** Children shown inside a slice (prototype-proven cap). */
export const SLICE_CHILD_CAP = 4;

export interface SliceLine {
  id: string;
  text: string;
  depth: number;
  role: 'ancestor' | 'source' | 'child';
}

export interface Slice {
  rootLabel: string;
  lines: SliceLine[];
  /** Children beyond the cap. */
  moreChildren: number;
}

export function buildSlice(
  row: Pick<BacklinkRowModel, 'id' | 'chain'>,
  ring: number,
  deps: RowDeps,
): Slice {
  const start = ring >= 0 ? Math.min(ring, Math.max(0, row.chain.length - 1)) : Math.max(0, row.chain.length - 1);
  const levels = row.chain.slice(start);
  const lines: SliceLine[] = levels.map((segment, index) => ({
    id: segment.id,
    text: deps.getBlock(segment.id)?.content.split('\n')[0] ?? segment.label,
    depth: index,
    role: 'ancestor' as const,
  }));

  const source = deps.getBlock(row.id);
  lines.push({
    id: row.id,
    // Wrapped at render (pre-line, unclamped) — 600 chars ≈ a healthy
    // paragraph or two before the drawer would drown.
    text: source ? source.content.slice(0, 600) : row.id.slice(0, 8),
    depth: levels.length,
    role: 'source',
  });

  const childIds = source?.childIds ?? [];
  for (const childId of childIds.slice(0, SLICE_CHILD_CAP)) {
    const child = deps.getBlock(childId);
    lines.push({
      id: childId,
      text: child ? (child.content.split('\n')[0] ?? '') : childId.slice(0, 8),
      depth: levels.length + 1,
      role: 'child',
    });
  }

  return {
    rootLabel: levels.length > 0 ? levels[0].label : 'root',
    lines,
    moreChildren: Math.max(0, childIds.length - SLICE_CHILD_CAP),
  };
}

/**
 * Render-side crumb elision that PRESERVES ring targets: chains longer than
 * four segments keep the root + last three, with an inert gap marker
 * (prototype shape). Each entry carries the chain index for `data-ring`.
 */
export type CrumbEntry = { gap: true } | { gap?: false; index: number; segment: ChainSegment };

export function crumbEntries(chain: ChainSegment[], maxSegments = 4): CrumbEntry[] {
  if (chain.length <= maxSegments) {
    return chain.map((segment, index) => ({ index, segment }));
  }
  const tail = chain.slice(chain.length - (maxSegments - 1));
  return [
    { index: 0, segment: chain[0] },
    { gap: true },
    ...tail.map((segment, offset) => ({
      index: chain.length - (maxSegments - 1) + offset,
      segment,
    })),
  ];
}

// ═══════════════════════════════════════════════════════════════
// FACETS (D7 — ported semantics)
// ═══════════════════════════════════════════════════════════════

/**
 * CONTEXTUAL facet chips (Evan, 2026-09-08 — evolves the D7 port): counts
 * are computed over the rows passing the CURRENT filter, so each chip shows
 * the result count you would get by clicking it. Because includes AND
 * together, a key's occurrence count within the filtered set IS exactly its
 * would-be result count — chips that would return zero simply never appear.
 *
 * Active keys (both includes and excludes) are always kept visible — an
 * exclude's conditional count is 0 by construction, but the user needs the
 * chip to un-toggle it; same when the filter has over-narrowed to nothing.
 *
 * Called without a filter this degrades to the original unconditional
 * counts (DEFAULT_REF_FILTER passes every row through).
 */
export function buildFacetChips(
  rows: readonly BacklinkRowModel[],
  filter: RefFilter = DEFAULT_REF_FILTER,
): FacetChip[] {
  const chips = new Map<string, FacetChip>();
  const add = (key: string, count: number) => {
    const [kind, ...rest] = key.split('::');
    chips.set(key, {
      key,
      kind: kind as FacetChip['kind'],
      label: rest.join('::'),
      count,
    });
  };

  const base = applyRefFilter(rows, filter);
  for (const row of base) {
    for (const key of row.facetKeys) {
      const existing = chips.get(key);
      if (existing) existing.count += 1;
      else add(key, 1);
    }
  }

  for (const activeKey of [...filter.includes, ...filter.removes]) {
    if (!chips.has(activeKey)) add(activeKey, 0);
  }

  return [...chips.values()].sort(
    (a, b) => b.count - a.count || a.label.localeCompare(b.label),
  );
}

/**
 * Prior-art toggle interplay: click=include (clears an exclude on the same
 * key), shift+click=exclude (clears an include); clicking an active state
 * clears it.
 */
export function toggleFacet(filter: RefFilter, key: string, exclude: boolean): RefFilter {
  const includes = new Set(filter.includes);
  const removes = new Set(filter.removes);
  if (exclude) {
    if (removes.has(key)) {
      removes.delete(key);
    } else {
      removes.add(key);
      includes.delete(key);
    }
  } else if (includes.has(key)) {
    includes.delete(key);
  } else {
    includes.add(key);
    removes.delete(key);
  }
  return { ...filter, includes, removes };
}

export function clearFacets(filter: RefFilter): RefFilter {
  return { ...filter, includes: new Set(), removes: new Set() };
}

// ═══════════════════════════════════════════════════════════════
// FILTER + SORT
// ═══════════════════════════════════════════════════════════════

export function applyRefFilter(
  rows: readonly BacklinkRowModel[],
  filter: RefFilter,
): BacklinkRowModel[] {
  let out = [...rows];
  if (filter.search) {
    const query = filter.search.toLowerCase();
    out = out.filter((row) =>
      row.contentLine.toLowerCase().includes(query)
      || (row.pageName ?? '').toLowerCase().includes(query)
      || row.chain.some((segment) => segment.label.toLowerCase().includes(query)),
    );
  }
  if (filter.includes.size || filter.removes.size) {
    out = out.filter((row) => {
      for (const include of filter.includes) {
        if (!row.facetKeys.has(include)) return false;
      }
      for (const remove of filter.removes) {
        if (row.facetKeys.has(remove)) return false;
      }
      return true;
    });
  }
  return sortRows(out, filter.sort, filter.sortAsc);
}

/**
 * D10c: `flip` applies INSIDE the primary comparator; the updatedAt-desc
 * tiebreak (and the id tiebreak for full determinism) never flips.
 */
export function sortRows(
  rows: BacklinkRowModel[],
  sort: SortMode,
  sortAsc: boolean,
): BacklinkRowModel[] {
  const flip = sortAsc ? -1 : 1;
  const primary = (a: BacklinkRowModel, b: BacklinkRowModel): number => {
    switch (sort) {
      case 'created': return b.createdAt - a.createdAt;
      case 'page': return (b.pageName ?? '').localeCompare(a.pageName ?? '');
      case 'updated':
      default: return b.updatedAt - a.updatedAt;
    }
  };
  return rows.sort(
    (a, b) => flip * primary(a, b)
      || b.updatedAt - a.updatedAt
      || a.id.localeCompare(b.id),
  );
}
