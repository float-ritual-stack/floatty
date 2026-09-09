/**
 * `[create_block:: [[target]]]` redirect (query-views track, brief F — FLO-947).
 *
 * A `query::` block is a standing query; blocks the user adds "to the board"
 * need a real home. STATE.md decision: the home is the query's `create_block`
 * target when given, else the query block itself (a real child, shown once in
 * place by the projection). This module is the pure half of that redirect —
 * `useBlockInput` consults it once, at the `determineKeyAction` seam, for every
 * "append an empty block" Enter inside a `query::` subtree.
 *
 * Resolution is read-only and rides the wikilink ladder the backlink index
 * already owns (`BacklinkIndex.canonicalTargetKey`: page name → full id →
 * compact id → unique hex prefix) — the same ladder `queryEval.ts` uses for
 * `under:`. An unresolvable target NEVER creates a page: the caller falls
 * back to creating in place and `QueryBlockDisplay` shows the warning.
 *
 * Nested `query::` blocks: the NEAREST query ancestor decides, whether or not
 * it declares `create_block` — its subtree is its home, so an outer query's
 * redirect must not reach through it.
 */

import { parseBlockType } from './blockTypes';
import { parseQuery } from './queryPredicate';

export interface CreateRedirectBlock {
  id: string;
  parentId: string | null;
  content: string;
}

export interface QueryCreateDeps {
  getBlock: (id: string) => CreateRedirectBlock | null | undefined;
  /** `BacklinkIndex.canonicalTargetKey` — the read-only wikilink ladder. */
  canonicalTargetKey: (rawTarget: string) => string | null;
}

export interface CreateRedirect {
  /** The nearest `query::` ancestor (or the block itself) that owns the redirect. */
  queryBlockId: string;
  /** The raw `[create_block:: …]` value, wikilink brackets stripped. */
  target: string;
  /** Resolved block id, or null when unresolvable → create in place. */
  targetId: string | null;
}

/** Guards a malformed parent chain; real outlines are nowhere near this deep. */
const MAX_ANCESTOR_WALK = 64;

/**
 * Self → ancestors: the first block whose content is a `query::` line.
 * Cycle-guarded and capped; null when there is none.
 */
export function findNearestQueryBlock(
  blockId: string,
  getBlock: QueryCreateDeps['getBlock'],
): CreateRedirectBlock | null {
  const visited = new Set<string>();
  let currentId: string | null = blockId;
  while (currentId && !visited.has(currentId) && visited.size < MAX_ANCESTOR_WALK) {
    visited.add(currentId);
    const block = getBlock(currentId);
    if (!block) return null;
    if (parseBlockType(block.content) === 'query') return block;
    currentId = block.parentId;
  }
  return null;
}

/**
 * Resolve a `create_block` target to an EXISTING block id. Page names come
 * back from the ladder as the page's block id; an unknown page name comes
 * back as `page:<key>` (the index's unresolved marker) and is rejected here
 * so nothing is ever created from a read.
 */
export function resolveCreateBlockTarget(
  rawTarget: string,
  deps: QueryCreateDeps,
): string | null {
  const target = rawTarget.trim();
  if (!target) return null;
  const key = deps.canonicalTargetKey(target);
  if (key === null || key.startsWith('page:')) return null;
  return deps.getBlock(key) ? key : null;
}

/**
 * The redirect for a block being created next to / under `blockId`.
 * Null when no `query::` ancestor exists or the nearest one declares no
 * `create_block` — creation then proceeds exactly as before.
 */
export function resolveCreateTarget(
  blockId: string,
  deps: QueryCreateDeps,
): CreateRedirect | null {
  const queryBlock = findNearestQueryBlock(blockId, deps.getBlock);
  if (!queryBlock) return null;
  const target = parseQuery(queryBlock.content).options.createBlock;
  if (!target) return null;
  return {
    queryBlockId: queryBlock.id,
    target,
    targetId: resolveCreateBlockTarget(target, deps),
  };
}

export type RevealPlan =
  | { kind: 'expand'; ancestors: string[] }
  | { kind: 'navigate' };

/**
 * How to bring a redirected block on screen. Inside the pane's zoom scope
 * (or with no zoom at all) the ancestor chain — target-first, stopping
 * before the zoom root, the shape `computeExpansion({ trigger: 'navigate' })`
 * takes — gets expanded and the block is focused in place, so the board
 * stays visible. Outside the scope the navigation funnel takes over.
 */
export function planRedirectReveal(
  blockId: string,
  zoomedRootId: string | null,
  getBlock: QueryCreateDeps['getBlock'],
): RevealPlan {
  const ancestors: string[] = [];
  const visited = new Set<string>([blockId]);
  let currentId = getBlock(blockId)?.parentId ?? null;
  while (currentId && !visited.has(currentId) && ancestors.length < MAX_ANCESTOR_WALK) {
    if (currentId === zoomedRootId) return { kind: 'expand', ancestors };
    visited.add(currentId);
    ancestors.push(currentId);
    currentId = getBlock(currentId)?.parentId ?? null;
  }
  return zoomedRootId === null ? { kind: 'expand', ancestors } : { kind: 'navigate' };
}
