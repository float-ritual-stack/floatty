/**
 * Shared fuzzy matching for autocomplete (wikilinks + command bar).
 *
 * Uses fuse.js for typo-tolerant filtering.
 * Client-side only — small dataset (page names), no HTTP latency.
 *
 * FLO-389
 */

import Fuse from 'fuse.js';

// Fuse builds a search index at construction — rebuilding it on every
// keystroke while [[ autocomplete is open was O(items) per key press
// (quirk-audit cluster D). Cache instances keyed by the items array's
// IDENTITY (callers pass memo-produced arrays that are replaced, never
// mutated, when the underlying data changes) plus an options signature.
// WeakMap: entries die with their arrays, so no HMR/leak concerns.
const fuseCache = new WeakMap<object, Map<string, Fuse<unknown>>>();

/**
 * Fuzzy filter for arrays. Returns items sorted by match quality when
 * query is non-empty, or all items unchanged when query is empty.
 *
 * Works with both plain string arrays (omit `keys`) and object arrays
 * (provide `keys` to specify which fields to search).
 *
 * NOTE: `items` must be treated as immutable — the Fuse index is cached by
 * array identity, so in-place mutation would serve stale results. All
 * current callers pass freshly-derived arrays from memos.
 */
export function fuzzyFilter<T>(
  items: T[],
  query: string,
  opts: { keys?: string[]; threshold?: number } = {}
): T[] {
  if (!query) return items;

  const optsKey = `${opts.keys?.join(',') ?? ''}|${opts.threshold ?? 0.4}`;
  let byOpts = fuseCache.get(items);
  if (!byOpts) {
    byOpts = new Map();
    fuseCache.set(items, byOpts);
  }
  let fuse = byOpts.get(optsKey) as Fuse<T> | undefined;
  if (!fuse) {
    fuse = new Fuse(items, {
      ...(opts.keys ? { keys: opts.keys } : {}),
      threshold: opts.threshold ?? 0.4,
      includeScore: true,
      ignoreLocation: true,
    });
    byOpts.set(optsKey, fuse as Fuse<unknown>);
  }

  return fuse.search(query).map(r => r.item);
}
