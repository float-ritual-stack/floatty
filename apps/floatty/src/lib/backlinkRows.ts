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

export interface BacklinkRowModel {
  /** Source block id. */
  id: string;
  kind: BacklinkKind;
  /** Raw first line of the source block (rendered with CSS ellipsis). */
  contentLine: string;
  /** Display labels for the ancestor chain, rootmost-first, already elided. */
  crumb: string[];
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

export function crumbLabel(content: string, max = CRUMB_LABEL_MAX): string {
  const firstLine = (content.split('\n')[0] ?? '').replace(/^#+\s*/, '');
  const stripped = stripWikilinkBrackets(firstLine).trim();
  return midTruncate(stripped, max);
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

  // Ancestor labels rootmost-first; stop at the pages:: container. Track the
  // nearest page (direct child of the container) for the page:: facet.
  const visited = new Set<string>([sourceId]);
  const labels: string[] = [];
  let pageName: string | null = null;
  let currentId = block.parentId;
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const ancestor = deps.getBlock(currentId);
    if (!ancestor) break;
    if (deps.pagesContainerId !== null && ancestor.id === deps.pagesContainerId) break;
    const label = crumbLabel(ancestor.content);
    labels.unshift(label);
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

  return {
    id: block.id,
    kind: classifyBacklink(block as Block),
    contentLine: block.content.split('\n')[0] ?? '',
    crumb: elideChain(labels),
    age: formatAge(now - (block.updatedAt || block.createdAt || now)),
    updatedAt: block.updatedAt ?? 0,
    createdAt: block.createdAt ?? 0,
    pageName,
    facetKeys,
  };
}

// ═══════════════════════════════════════════════════════════════
// FACETS (D7 — ported semantics)
// ═══════════════════════════════════════════════════════════════

/** Counts over the UNFILTERED rows; sorted count-desc then label. */
export function buildFacetChips(rows: readonly BacklinkRowModel[]): FacetChip[] {
  const chips = new Map<string, FacetChip>();
  for (const row of rows) {
    for (const key of row.facetKeys) {
      const existing = chips.get(key);
      if (existing) {
        existing.count += 1;
        continue;
      }
      const [kind, ...rest] = key.split('::');
      chips.set(key, {
        key,
        kind: kind as FacetChip['kind'],
        label: rest.join('::'),
        count: 1,
      });
    }
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
      || row.crumb.some((segment) => segment.toLowerCase().includes(query)),
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
