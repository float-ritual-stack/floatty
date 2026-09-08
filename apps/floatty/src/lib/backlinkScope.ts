/**
 * U4 — drawer scope stack (design doc §U4).
 *
 * Resolves "what groups does this pane's drawer show" from
 * (zoomedRootId, focusedBlockId). Pure function over the U1 backlink index
 * plus plain block lookups — unit-testable without DOM.
 *
 * Rules (all from the design doc):
 * - Nearest page ancestor → page group, ALWAYS present at any zoom depth.
 * - Focused/zoomed block with its own inbound → focal group FIRST (D2).
 * - Groups are keyed by resolved target block id and deduped on that key;
 *   when the focal candidate IS the page block, the page group wins because
 *   it is the always-present identity.
 */

import type { BacklinkIndex } from './backlinkIndex';

export interface BacklinkScopeBlock {
  id: string;
  parentId: string | null;
}

export interface BacklinkGroup {
  kind: 'focal' | 'page';
  targetId: string;
  sourceIds: string[];
}

export interface ResolveBacklinkScopeArgs {
  zoomedRootId: string | null;
  focusedBlockId: string | null;
  /** Id of the `pages::` container block (null when it doesn't exist yet). */
  pagesContainerId: string | null;
  index: BacklinkIndex;
  getBlock: (id: string) => BacklinkScopeBlock | null | undefined;
}

/**
 * Walk self → ancestors and return the first block that is a direct child of
 * the `pages::` container (the client-side definition of "a page").
 * Cycle-guarded; a broken parent chain resolves to null.
 */
export function nearestPageId(
  startId: string,
  pagesContainerId: string | null,
  getBlock: ResolveBacklinkScopeArgs['getBlock'],
): string | null {
  if (!pagesContainerId) return null;
  const visited = new Set<string>();
  let currentId: string | null = startId;
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const block = getBlock(currentId);
    if (!block) return null;
    if (block.parentId === pagesContainerId) return block.id;
    currentId = block.parentId;
  }
  return null;
}

export function resolveBacklinkScope(args: ResolveBacklinkScopeArgs): BacklinkGroup[] {
  // Attention anchor: the focused block when there is one, else the zoom root.
  const anchorId = args.focusedBlockId ?? args.zoomedRootId;
  const pageId = anchorId
    ? nearestPageId(anchorId, args.pagesContainerId, args.getBlock)
    : null;

  const groups: BacklinkGroup[] = [];
  const seen = new Set<string>();

  // Focal candidates in attention order. A candidate that resolves to the
  // page itself is skipped — the page group below owns that identity.
  for (const candidateId of [args.focusedBlockId, args.zoomedRootId]) {
    if (!candidateId || candidateId === pageId || seen.has(candidateId)) continue;
    if (!args.getBlock(candidateId)) continue;
    const sourceIds = args.index.referencing(candidateId);
    if (sourceIds.length === 0) continue;
    seen.add(candidateId);
    groups.push({ kind: 'focal', targetId: candidateId, sourceIds });
  }

  if (pageId) {
    groups.push({ kind: 'page', targetId: pageId, sourceIds: args.index.referencing(pageId) });
  }

  return groups;
}
