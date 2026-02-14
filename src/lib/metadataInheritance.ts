/**
 * Metadata Inheritance — Additive marker inheritance through block hierarchy
 *
 * Pure functions that compute "effective metadata" for a block by walking
 * its ancestor chain and merging markers additively. This is a derived
 * computation (Redux-selector-style), NOT stored in Y.Doc.
 *
 * Design decisions:
 * - Markers are inherited additively (parent + child markers merge)
 * - Deduplication by markerType::value compound key
 * - Outlinks, isStub, extractedAt are block-local only (NOT inherited)
 * - No caching — recomputed on demand (only used in agent context, not render path)
 */

import type { Block } from './blockTypes';
import type { BlockMetadata } from '../generated/BlockMetadata';
import type { Marker } from '../generated/Marker';

/**
 * Compute effective metadata for a block by walking its ancestor chain
 * and merging markers additively. Markers are deduped by type+value.
 *
 * Child markers override parent markers with the same type+value key
 * (last-write-wins as we walk root → self).
 *
 * @param blockId - The block to compute effective metadata for
 * @param getBlock - Lookup function (from blockStore.getBlock)
 * @returns Merged metadata with inherited markers + block-local outlinks/isStub
 */
export function computeEffectiveMetadata(
  blockId: string,
  getBlock: (id: string) => Block | undefined
): BlockMetadata {
  // Walk ancestor chain: collect [root, ..., parent, self]
  const chain: Block[] = [];
  let current = getBlock(blockId);
  while (current) {
    chain.unshift(current); // Prepend so root is first
    current = current.parentId ? getBlock(current.parentId) : undefined;
  }

  // Merge markers additively — dedup by markerType::value
  const seen = new Map<string, Marker>();
  for (const block of chain) {
    for (const marker of block.metadata?.markers ?? []) {
      const key = markerKey(marker);
      seen.set(key, marker);
    }
  }

  // Block-local fields from self only
  const self = getBlock(blockId);
  return {
    markers: Array.from(seen.values()),
    outlinks: self?.metadata?.outlinks ?? [],
    isStub: self?.metadata?.isStub ?? false,
    extractedAt: self?.metadata?.extractedAt ?? null,
  };
}

/**
 * Create a deduplication key for a marker.
 * Two markers with the same type and value are considered identical.
 */
export function markerKey(marker: Marker): string {
  return `${marker.markerType}::${marker.value ?? ''}`;
}

/**
 * Compute the set of new markers that don't already exist on a block.
 * Used by the agent to avoid writing duplicate markers.
 *
 * @param existing - Current markers on the block
 * @param proposed - New markers the agent wants to add
 * @returns Only the markers from `proposed` that aren't in `existing`
 */
export function findNewMarkers(
  existing: Marker[],
  proposed: Marker[]
): Marker[] {
  const existingKeys = new Set(existing.map(markerKey));
  return proposed.filter(m => !existingKeys.has(markerKey(m)));
}
