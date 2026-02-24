/**
 * Shared fuzzy matching for autocomplete (wikilinks + command bar).
 *
 * Uses fuse.js for typo-tolerant filtering.
 * Client-side only — small dataset (page names), no HTTP latency.
 *
 * FLO-389
 */

import Fuse from 'fuse.js';

/**
 * Fuzzy filter for arrays. Returns items sorted by match quality when
 * query is non-empty, or all items unchanged when query is empty.
 *
 * Works with both plain string arrays (omit `keys`) and object arrays
 * (provide `keys` to specify which fields to search).
 */
export function fuzzyFilter<T>(
  items: T[],
  query: string,
  opts: { keys?: string[]; threshold?: number } = {}
): T[] {
  if (!query) return items;

  const fuse = new Fuse(items, {
    ...(opts.keys ? { keys: opts.keys } : {}),
    threshold: opts.threshold ?? 0.4,
    includeScore: true,
    ignoreLocation: true,
  });

  return fuse.search(query).map(r => r.item);
}
