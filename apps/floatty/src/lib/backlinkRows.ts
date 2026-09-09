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
import { getPageTitle, getSectionKey } from './pageTitle';
import { parseWikilinkInner } from './wikilinkUtils';

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
  /**
   * `supersedes::<id-or-prefix>` authoring-side lineage marker — overrides
   * the churn heuristics entirely (D10, outline-revisions skill).
   */
  supersedes: string | null;
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
 * Strip `[[..]]` at the label layer — alias links keep the alias text via the
 * CANONICAL split (`parseWikilinkInner`: first top-level pipe, not the last —
 * `[[a|b|c]]` aliases as `b|c` everywhere in the app). Runs to a fixed point
 * so one nesting level per pass unwraps fully.
 */
export function stripWikilinkBrackets(text: string): string {
  let out = text;
  for (let i = 0; i < 4; i++) {
    const next = out.replace(WIKILINK_RE, (_match, inner: string) => {
      const { target, alias } = parseWikilinkInner(inner);
      return alias ?? target;
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

// Composes THE canonical title extractor (pageTitle.ts — Rust parity
// contract): '#2817' stays '#2817', only real heading markers strip.
function canonicalCrumb(content: string): string {
  return stripWikilinkBrackets(getPageTitle(content)).trim();
}

export function crumbLabel(content: string, max = CRUMB_LABEL_MAX): string {
  return midTruncate(canonicalCrumb(content), max);
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
  //
  // The same walk collects EFFECTIVE markers: inheritance is additive by
  // marker type — a block inherits every ancestor marker type it lacks, the
  // nearest ancestor winning per type — the rule the server's
  // InheritanceIndex already applies (`inheritance_index.rs`). A card under
  // `**thursday board** [project::x]` carries `project::x` in the drawer
  // without repeating the pill (Evan, 2026-09-08 — [[FLO-374]] phase 1a).
  const ownMarkers = block.metadata?.markers ?? [];
  const effectiveMarkers = [...ownMarkers];
  const seenTypes = new Set(ownMarkers.map((marker) => marker.markerType));
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
    const ancestorMarkers = ancestor.metadata?.markers ?? [];
    for (const marker of ancestorMarkers) {
      if (!seenTypes.has(marker.markerType)) effectiveMarkers.push(marker);
    }
    for (const marker of ancestorMarkers) seenTypes.add(marker.markerType);
    currentId = ancestor.parentId;
  }

  const facetKeys = new Set<string>();
  if (pageName) facetKeys.add(`page::${pageName}`);
  for (const marker of effectiveMarkers) {
    facetKeys.add(`marker::${marker.markerType}::${marker.value ?? ''}`);
  }
  for (const outlink of block.metadata?.outlinks ?? []) {
    // Same target identity the backlink index canonicalizes with — otherwise
    // [[Design Doc]] and [[design doc]] split into two chips for one target.
    facetKeys.add(`link::${getSectionKey(outlink)}`);
  }

  const firstChild = block.childIds.length > 0 ? deps.getBlock(block.childIds[0]) : null;
  const supersedes = (block.metadata?.markers ?? [])
    .find((marker) => marker.markerType === 'supersedes')?.value ?? null;

  return {
    id: block.id,
    kind: classifyBacklink(block as Block),
    contentLine: block.content.split('\n')[0] ?? '',
    chain,
    childPreview: firstChild ? (firstChild.content.split('\n')[0] ?? '') : null,
    childCount: block.childIds.length,
    supersedes,
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
 * re-roots the slice at that ancestor's chain INDEX, and clicking the live
 * segment again collapses (prototype-proven toggle). D8's "expand-only"
 * means the dial never NAVIGATES — it widens/collapses in place.
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
      || (row.childPreview ?? '').toLowerCase().includes(query)
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

// ═══════════════════════════════════════════════════════════════
// REVISION-CHURN CLUSTERING (U3c — D10 / D10d)
// ═══════════════════════════════════════════════════════════════

/**
 * Same source page + within the window + PROSE-SIMILAR → one cluster fronted
 * by the LATEST revision (D10). The similarity gate is part of the key by
 * measurement (D10d): naive page+target+1h formed 186 clusters on the real
 * outline, 63% false — same-hour changelog lines are often distinct events.
 * Gate: bigram-Dice ≥ 0.5 over a prose-only norm (wikilink spans removed
 * ENTIRELY, marker pills + clock-times stripped, first 300 chars). A
 * link-only row has empty prose and never clusters. Post-gate: 73 clusters,
 * 180 rows folded, all revision-shaped (smoke: revision pair 0.95 ·
 * link-only 0.00 · distinct events 0.27).
 *
 * v1 params (flip-by-feel after real use): window 1h; front = latest.
 * Cluster rank under any sort = its heaviest member — never a sum, which
 * would reward churn. That falls out of clustering the already-sorted list:
 * a cluster sits where its earliest-sorted member sat.
 */
export const CHURN_WINDOW_MS = 3_600_000;
export const CHURN_DICE_MIN = 0.5;
const CHURN_PROSE_CHARS = 300;
const CLOCK_TIME_RE = /\b\d{1,2}:\d{2}(?::\d{2})?\s?(?:[ap]m)?\b/gi;
const MARKER_PILL_RE = /\[[a-z][\w-]*::[^\]]*\]/gi;
const BARE_MARKER_RE = /(?:^|\s)[a-z][\w-]*::\S*/gi;

export interface ChurnCluster {
  /** The LATEST revision (status, not origin). */
  front: BacklinkRowModel;
  /** Older revisions, newest-first. */
  rest: BacklinkRowModel[];
}

/** Prose-only normalization: the D10d similarity surface. */
export function proseNorm(text: string): string {
  let out = text;
  // Remove wikilink spans ENTIRELY (innermost-first so nesting unwinds) —
  // stripping only the brackets left path-stub scaffolding false-clustering.
  for (let i = 0; i < 4; i++) {
    const next = out.replace(WIKILINK_RE, ' ');
    if (next === out) break;
    out = next;
  }
  return out
    .replace(MARKER_PILL_RE, ' ')
    .replace(BARE_MARKER_RE, ' ')
    .replace(CLOCK_TIME_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, CHURN_PROSE_CHARS);
}

function bigrams(text: string): Set<string> {
  const set = new Set<string>();
  for (let i = 0; i < text.length - 1; i++) set.add(text.slice(i, i + 2));
  return set;
}

/** Dice coefficient over character bigrams; empty prose scores 0. */
export function bigramDice(a: string, b: string): number {
  const setA = bigrams(a);
  const setB = bigrams(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let shared = 0;
  for (const gram of setA) if (setB.has(gram)) shared += 1;
  return (2 * shared) / (setA.size + setB.size);
}

function supersedesLink(a: BacklinkRowModel, b: BacklinkRowModel): boolean {
  const aRef = a.supersedes?.trim().toLowerCase();
  const bRef = b.supersedes?.trim().toLowerCase();
  return (!!aRef && b.id.toLowerCase().startsWith(aRef))
    || (!!bRef && a.id.toLowerCase().startsWith(bRef));
}

/**
 * Cluster an already-sorted row list. Output order = order of each
 * cluster's earliest-sorted member (heaviest under the active sort).
 */
export function clusterChurn(rows: readonly BacklinkRowModel[]): ChurnCluster[] {
  const claimed = new Set<string>();
  const clusters: ChurnCluster[] = [];
  const prose = new Map<string, string>();
  const proseOf = (row: BacklinkRowModel): string => {
    let cached = prose.get(row.id);
    if (cached === undefined) {
      cached = proseNorm(row.contentLine);
      prose.set(row.id, cached);
    }
    return cached;
  };

  for (const seed of rows) {
    if (claimed.has(seed.id)) continue;
    const kin: BacklinkRowModel[] = [seed];
    for (const candidate of rows) {
      if (candidate.id === seed.id || claimed.has(candidate.id)) continue;
      if (supersedesLink(seed, candidate)) {
        kin.push(candidate);
        continue;
      }
      if (!seed.pageName || seed.pageName !== candidate.pageName) continue;
      if (Math.abs(seed.updatedAt - candidate.updatedAt) > CHURN_WINDOW_MS) continue;
      if (bigramDice(proseOf(seed), proseOf(candidate)) < CHURN_DICE_MIN) continue;
      kin.push(candidate);
    }
    for (const member of kin) claimed.add(member.id);
    if (kin.length === 1) {
      clusters.push({ front: seed, rest: [] });
      continue;
    }
    kin.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
    clusters.push({ front: kin[0], rest: kin.slice(1) });
  }
  return clusters;
}
