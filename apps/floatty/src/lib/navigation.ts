// ARCHITECTURE: Protected module — see CLAUDE.md "Canonical Paths". All navigation routes through here.
/**
 * Navigation API - Global navigation functions for plugins and view components
 *
 * Exposed to handlers via ExecutorActions and directly importable by view components.
 * Wraps existing paneStore/layoutStore/backlinkNavigation functions.
 */

import { paneStore } from '../hooks/usePaneStore';
import { tabStore } from '../hooks/useTabStore';
import { layoutStore } from '../hooks/useLayoutStore';
import { findTabIdByPaneId } from '../hooks/useLayoutStore';
import { navigateToPage as navigateToPageImpl, findPage, ensurePage } from '../hooks/useBacklinkNavigation';
import { blockStore, type BatchBlockOp } from '../hooks/useBlockStore';
import { paneLinkStore } from '../hooks/usePaneLinkStore';
import { collectLeaves, type PaneLeaf } from './layoutTypes';
import { resolveBlockIdPrefix, BLOCK_ID_PREFIX_RE, type Block } from './blockTypes';
import { parsePathSegments } from './wikilinkUtils';
import { effectiveCreatedAt, matchFuzzy, type MatchCandidate, type MatchRung } from './pathMatcher';
import { createLogger } from './logger';

const logger = createLogger('navigation');

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

export interface NavigateOptions {
  /** Which pane to navigate in (required for most operations) */
  paneId?: string;
  /** Open in split instead of navigating current pane */
  splitDirection?: 'horizontal' | 'vertical';
  /** Briefly highlight the target block */
  highlight?: boolean;
  /** Block where navigation originated (for focus restoration on back navigation) */
  originBlockId?: string;
  /** If true, split is ephemeral (Opt+Click — auto-closes when navigating away) */
  ephemeral?: boolean;
}

export interface NavigateResult {
  success: boolean;
  targetPaneId: string | null;
  focusTargetId?: string | null;
  error?: string;
}

// ═══════════════════════════════════════════════════════════════
// PANE LINK RESOLUTION
// ═══════════════════════════════════════════════════════════════

/**
 * Resolve pane link for same-tab navigation.
 * Returns linkedPaneId if linked and in same tab, otherwise sourcePaneId.
 *
 * This is the call-site resolution pattern (FM #7): callers resolve before
 * entering the navigation funnel, not inside it.
 *
 * Sidebar-hosted sources (FLO-502 pin shelf) have no tab of their own, so
 * the same-tab guard would naively return them to themselves. They short-
 * circuit before the guard: `paneLinkStore.resolveLink` already routes them
 * to `sidebarLinks[activeTab]` (FLO-671 fallback, lifted into the primitive
 * so chirp / deep-link / Cmd+Shift+L all share the same path). The sidebar
 * target is intentionally cross-tab from the sidebar source — accept it.
 */
export function resolveSameTabLink(sourcePaneId: string, blockId?: string): string {
  const linked = paneLinkStore.resolveLink(sourcePaneId, blockId);
  if (!linked) return sourcePaneId;

  // Sidebar source: resolveLink already enforced the FLO-671 sidebar route;
  // the same-tab guard would discard it (sourceTab is null for sidebars).
  const host = paneStore.getPaneHost(sourcePaneId);
  if (host?.kind === 'sidebar') return linked;

  // Tab-hosted source: enforce same-tab semantics.
  // FLO-668 null contract: null sourceTab means the source is not tab-hosted
  // (already covered by the sidebar branch above); null linkedTab means the
  // link target is not tab-hosted — either way, fall back to source.
  const sourceTab = findTabIdByPaneId(sourcePaneId);
  const linkedTab = findTabIdByPaneId(linked);
  return sourceTab && sourceTab === linkedTab ? linked : sourcePaneId;
}

// ═══════════════════════════════════════════════════════════════
// NAVIGATION FUNCTIONS
// ═══════════════════════════════════════════════════════════════

/**
 * Navigate to a block by ID with context.
 *
 * Zooms to an ancestor to show the target with siblings, but never zooms
 * to a root-level block (pages::, etc.) — that would show the entire outline.
 * Falls back to the block itself when ancestors are too shallow.
 *
 * After zoom, scrolls the target into view and briefly highlights it.
 */
export function navigateToBlock(blockId: string, options: NavigateOptions = {}): NavigateResult {
  const { paneId, splitDirection, highlight, originBlockId } = options;

  if (!paneId) {
    logger.warn('navigateToBlock: no paneId provided');
    return { success: false, targetPaneId: null, error: 'No paneId provided' };
  }

  let targetPaneId = paneId;

  if (splitDirection) {
    // FLO-668 null contract: null → sidebar/floating or deleted pane; split
    // isn't possible, fall back to current pane without splitting.
    const tabId = findTabIdByPaneId(paneId);
    if (!tabId) {
      logger.warn('Could not find tabId for pane, using current pane');
    } else {
      // Split in requested direction
      const newPaneId = layoutStore.splitPane(tabId, splitDirection, 'outliner');
      if (newPaneId) {
        targetPaneId = newPaneId;
      } else {
        logger.warn('Split failed, using current pane');
      }
    }
  }

  // Get the target block to find its parent for context
  const targetBlock = blockStore.getBlock(blockId);

  // Determine zoom target: walk up ancestor chain for context, but don't zoom
  // to root-level blocks (pages::, etc.) — that defeats the purpose of zooming.
  const zoomTarget = pickZoomTarget(blockId, targetBlock);

  // Zoom to context block (zoomTo pushes to nav history so Cmd+[ works)
  // Pass originBlockId so goBack() can restore focus to the search output block
  paneStore.zoomTo(targetPaneId, zoomTarget, { originBlockId });

  // Gap 3 fix: expand ancestors between zoom target and destination block.
  // Without this, collapsed intermediate ancestors hide the target from DOM,
  // causing scrollAndHighlightWithRetry to fail silently.
  expandAncestorsToTarget(blockId, zoomTarget, targetPaneId);

  // Set focus on the target block so it receives DOM focus after zoom
  paneStore.setFocusedBlockId(targetPaneId, blockId);

  // Update active pane so Cmd+J overlay knows where we landed (Gap 6)
  // FLO-668 null contract: null → sidebar/floating; no tab-scoped activePaneId
  // to set, silent no-op is correct.
  const navTabId = findTabIdByPaneId(targetPaneId);
  if (navTabId) {
    layoutStore.setActivePaneId(navTabId, targetPaneId);
  }

  // Scroll to the actual target block (after DOM settles), optionally highlight
  const delay = splitDirection ? 150 : 50;
  scrollAndHighlightWithRetry(blockId, targetPaneId, delay, highlight);

  return { success: true, targetPaneId };
}

// ═══════════════════════════════════════════════════════════════
// PANE SCOPE (FLOOR) — single decision point for in-pane zoom
// ═══════════════════════════════════════════════════════════════
//
// Every zoom trigger (breadcrumb click, ◊ root button, Cmd+Enter zoom-in,
// Escape zoom-out) routes through requestPaneZoom / requestPaneZoomOut instead
// of calling paneStore.zoomTo directly. That direct-call scatter was the
// navigation hydra; this is the one head left. A pane's "floor" (set via
// paneStore.setScope, e.g. by the pin shelf) is the highest block it may zoom
// to. Normal panes have no floor → identical to prior behavior.

/**
 * Is `blockId` the pane-floor or a descendant of it? Walks the parent chain
 * upward; in-scope iff it reaches the floor. O(depth); the `seen` guard defends
 * against malformed cycles.
 */
function isAtOrBelowFloor(blockId: string, floorId: string): boolean {
  let cur: string | null = blockId;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    if (cur === floorId) return true;
    seen.add(cur);
    cur = blockStore.getBlock(cur)?.parentId ?? null;
  }
  return false;
}

/**
 * True when `blockId` is navigable WITHIN `paneId` (no floor, or the floor /
 * below it). Breadcrumb uses this to dim above-floor segments as "leaves this
 * pane" affordances. `null` (◊ / full-tree) is above any floor.
 */
export function isWithinPaneScope(paneId: string, blockId: string | null): boolean {
  const floor = paneStore.getFloor(paneId);
  if (floor === null) return true;
  if (blockId === null) return false;
  return isAtOrBelowFloor(blockId, floor);
}

/**
 * THE single entry for in-pane zoom navigation. Policy:
 *   - in-scope target (no floor, or floor/below) → zoom in-pane (unchanged).
 *   - above-floor target (incl. null/◊ on a floored pane) → ESCAPE: route to
 *     the linked pane if one exists, else no-op (the pane holds at its floor).
 */
export function requestPaneZoom(
  paneId: string,
  targetId: string | null,
  options: { originBlockId?: string } = {}
): void {
  if (isWithinPaneScope(paneId, targetId)) {
    paneStore.zoomTo(paneId, targetId, { originBlockId: options.originBlockId });
    return;
  }

  // Above the floor — escape attempt. Open in the linked pane, or swallow.
  const linkedPane = resolveSameTabLink(paneId, targetId ?? undefined);
  if (linkedPane === paneId) return; // no link → no-op, the pin holds

  if (targetId === null) {
    paneStore.zoomTo(linkedPane, null); // ◊ → linked pane at full tree
  } else {
    navigateToBlock(targetId, { paneId: linkedPane, highlight: true });
  }
}

/**
 * Escape / zoom-out, scope-clamped. Targets the pane's floor: `null` for normal
 * panes (full tree, unchanged), the floor block for pinned panes (clamp — never
 * above). Already at the floor → zoomTo guards same-value → no-op. Both
 * behaviors fall out of one call; no separate pin branch.
 */
export function requestPaneZoomOut(paneId: string): void {
  requestPaneZoom(paneId, paneStore.getFloor(paneId));
}

/**
 * Navigate to a page by name (find or create under pages::)
 *
 * @param pageName - Target page name
 * @param options - Navigation options
 */
export function navigateToPage(pageName: string, options: NavigateOptions = {}): NavigateResult {
  const { paneId, splitDirection, highlight, originBlockId, ephemeral } = options;

  if (!paneId) {
    logger.warn('navigateToPage: no paneId provided');
    return { success: false, targetPaneId: null, error: 'No paneId provided' };
  }

  // Use existing implementation from useBacklinkNavigation
  const result = navigateToPageImpl(
    pageName,
    paneId,
    splitDirection ?? 'none',
    ephemeral ?? false,
    originBlockId ? { originBlockId } : undefined
  );

  if (!result.success) {
    return { success: false, targetPaneId: null, error: result.error };
  }

  // Focus first child so keyboard works immediately after navigation
  if (result.focusTargetId && result.targetPaneId) {
    paneStore.setFocusedBlockId(result.targetPaneId, result.focusTargetId);
  }

  // Update active pane so Cmd+J overlay knows where we landed (Gap 6)
  if (result.targetPaneId) {
    // FLO-668 null contract: null → sidebar/floating; no tab-scoped
    // activePaneId to set, silent no-op is correct.
    const navTabId = findTabIdByPaneId(result.targetPaneId);
    if (navTabId) {
      layoutStore.setActivePaneId(navTabId, result.targetPaneId);
    }
  }

  if (highlight && result.pageId && result.targetPaneId) {
    // Delay for split panes to render
    const delay = splitDirection ? 150 : 50;
    setTimeout(() => {
      highlightBlockInPane(result.pageId!, result.targetPaneId!);
    }, delay);
  }

  return { success: true, targetPaneId: result.targetPaneId, focusTargetId: result.focusTargetId };
}

/**
 * Scroll a block into view without changing zoom
 *
 * @param blockId - Target block ID
 */
export function scrollToBlock(blockId: string): void {
  const element = document.querySelector(`[data-block-id="${CSS.escape(blockId)}"]`);
  if (element) {
    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } else {
    logger.warn('scrollToBlock: element not found', { blockId });
  }
}

// ═══════════════════════════════════════════════════════════════
// CHIRP NAVIGATE (unified handler for iframe → outline navigation)
// ═══════════════════════════════════════════════════════════════

export interface ChirpNavigateOptions {
  type?: 'block' | 'page' | 'wikilink';
  sourcePaneId: string;
  sourceBlockId?: string;
  splitDirection?: 'horizontal' | 'vertical';
  originBlockId?: string;
}

/**
 * Unified navigation handler for chirp protocol messages.
 *
 * Used by both EvalOutput (eval:: iframes via postMessage) and DoorHost
 * (door views via onNavigate callback). Single codepath for:
 * - Block ID resolution (full UUID or hex prefix)
 * - Block existence validation (don't zoom to nonexistent blocks)
 * - Hex prefix guard (don't create pages for block ID lookalikes)
 * - Page navigation fallback
 * - Pane link resolution
 */
export function handleChirpNavigate(target: string, opts: ChirpNavigateOptions): NavigateResult {
  const { type, sourcePaneId, sourceBlockId, splitDirection, originBlockId } = opts;

  if (!target) {
    return { success: false, targetPaneId: null, error: 'empty target' };
  }

  // Resolve target pane through link chain
  const targetPaneId = paneLinkStore.resolveLink(sourcePaneId, sourceBlockId) ?? sourcePaneId;

  // Block ID resolution: full UUID or hex prefix
  const blockIds = Object.keys(blockStore.blocks);
  const resolvedId = resolveBlockIdPrefix(target, blockIds);

  if (resolvedId || type === 'block') {
    const effectiveId = resolvedId ?? target;

    // Existence check: block must actually be in this outline
    const block = blockStore.getBlock(effectiveId);
    if (!block) {
      logger.warn('chirp navigate: block not in outline', {
        target: effectiveId,
        blockCount: blockIds.length,
      });
      return { success: false, targetPaneId, error: 'block not found in outline' };
    }

    return navigateToBlock(effectiveId, {
      paneId: targetPaneId,
      highlight: true,
      splitDirection,
      originBlockId,
    });
  }

  // Guard: hex prefix that didn't resolve → never create page for block ID lookalikes
  if (BLOCK_ID_PREFIX_RE.test(target)) {
    logger.warn('chirp navigate: block ID prefix did not resolve', {
      target,
      blockCount: blockIds.length,
    });
    return { success: false, targetPaneId, error: 'block not found' };
  }

  // Multi-segment path address (ADR-008 D2/D3): [[page > section > block]]
  // descendant-selector navigation. Single-segment targets fall through to the
  // page find-or-create fallback below (unchanged). targetPaneId is already
  // link-resolved above (funnel doctrine: pane resolution at the call site).
  const pathSegments = parsePathSegments(target);
  if (pathSegments.length > 1) {
    return navigateWikilinkPath(pathSegments, {
      paneId: targetPaneId,
      highlight: true,
      splitDirection,
      originBlockId,
    });
  }

  // Page navigation fallback
  return navigateToPage(target, {
    paneId: targetPaneId,
    highlight: true,
    splitDirection,
  });
}

// ═══════════════════════════════════════════════════════════════
// PATH ADDRESSING (ADR-008 — [[page > section > block]] navigation)
// ═══════════════════════════════════════════════════════════════
//
// Client-side twin of the server's walk_descendants (ADR-008 Decision 5):
// a walk of the LOCAL Y.Doc so navigation works offline / fast-boot. Parity
// with the server is by shared fixture corpus (`__fixtures__/path-grammar.json`
// roundtrip section), same governance as findPage ↔ PageNameIndex.
//
// CLICKS ARE mkdir-p (ADR-008 Decision 3, rewritten): a multi-segment path
// click fuzzy-resolves its frontier as far as reality goes, then CREATES the
// unresolved tail exactly-as-written (a direct-child chain), then navigates to
// the destination. Every click succeeds — there is no miss state and no notice.
// `resolveWikilinkPath` stays a pure read (it still reports `unresolvedTail`);
// the create side lives entirely in `navigateWikilinkPath` + `createPathTail`.

/**
 * Cap on descendants examined per segment step. Mirrors the get_subtree DFS cap
 * (1000) and sits above expansionPolicy's EXPANSION_SIZE_CAP (500) — a path walk
 * reads more of the tree than an expand does. A subtree larger than this
 * truncates the candidate set; breadth-first order keeps the shallowest
 * descendants (the ones depth-proximity would prefer anyway).
 */
const PATH_DESCENDANT_CAP = 1000;

/**
 * Resolution of a multi-segment wikilink path against the local block store.
 *
 * `blockId` is the DEEPEST block that resolved — the page for a pure page hit,
 * a descendant for deeper hits, or `null` when even segment 1 (the page) did
 * not resolve. `resolvedDepth` counts matched segments (0 = page miss);
 * `unresolvedTail` is the segments that did NOT resolve (ADR-008 D3 notice
 * payload).
 */
export interface PathResolution {
  blockId: string | null;
  resolvedDepth: number;
  unresolvedTail: string[];
}

/** A descendant candidate scored against one path segment. */
interface ScoredDescendant {
  block: Block;
  rung: MatchRung;
  depth: number;
}

/**
 * Deterministic total order — is `a` a strictly better segment match than `b`?
 *   1. rung — lower (stronger) fuzzy rung wins.
 *   2. depth — shallower descendant (closer to the running match) wins.
 *   3. recency — newer `updatedAt` wins.
 *   4. final tie — oldest `createdAt` wins.
 * Rung comes from the matcher (owned ladder); composing depth × recency across
 * candidates is the walker's job, sanctioned by pathMatcher's module header
 * ("cross-level scoring is stage-2's job, not the matcher's"). A non-strict
 * "beats" keeps the first-encountered (breadth-first) candidate on a full tie.
 */
function beatsBest(a: ScoredDescendant, b: ScoredDescendant): boolean {
  if (a.rung !== b.rung) return a.rung < b.rung;
  if (a.depth !== b.depth) return a.depth < b.depth;
  if (a.block.updatedAt !== b.block.updatedAt) return a.block.updatedAt > b.block.updatedAt;
  return effectiveCreatedAt(a.block.createdAt) < effectiveCreatedAt(b.block.createdAt);
}

/**
 * Among all descendants of `rootId`, pick the single best match for `segment`
 * under `beatsBest`, or null when no descendant matches any rung. Walks the
 * subtree breadth-first (shallowest first) with a `seen` cycle-guard and a
 * `PATH_DESCENDANT_CAP` bound. Each candidate's rung comes from the matcher
 * (`matchFuzzy` over a singleton) so the fuzzy ladder stays owned by pathMatcher.
 */
function selectBestDescendant(segment: string, rootId: string): Block | null {
  const rootBlock = blockStore.getBlock(rootId);
  if (!rootBlock) return null;

  let best: ScoredDescendant | null = null;
  const seen = new Set<string>([rootId]);
  const queue: Array<{ id: string; depth: number }> = rootBlock.childIds.map((id) => ({
    id,
    depth: 1,
  }));
  let examined = 0;

  while (queue.length > 0 && examined < PATH_DESCENDANT_CAP) {
    const { id, depth } = queue.shift()!;
    if (seen.has(id)) continue; // cycle guard (malformed tree)
    seen.add(id);
    const block = blockStore.getBlock(id);
    if (!block) continue;
    examined++;

    const candidate: MatchCandidate = { content: block.content, createdAt: block.createdAt };
    const match = matchFuzzy(segment, [candidate]);
    if (match) {
      const scored: ScoredDescendant = { block, rung: match.rung, depth };
      if (best === null || beatsBest(scored, best)) best = scored;
    }

    for (const childId of block.childIds) {
      if (!seen.has(childId)) queue.push({ id: childId, depth: depth + 1 });
    }
  }

  return best?.block ?? null;
}

/**
 * Client-side walk of the local Y.Doc for a [[page > section > block]] path
 * (ADR-008 Decision 5, READ mode). Segment 1 is a PAGE — resolved via the
 * existing `findPage` predicate (exact, case-insensitive, oldest-createdAt
 * wins, same as the server's PageNameIndex). Segments 2+ are DESCENDANT
 * selectors that may skip levels: each resolves against the full subtree of
 * the running match.
 *
 * Per-segment selection is greedy single-best ("v1 auto-picks top" — no picker;
 * that arrives with alias:: in stage 3). On any segment miss the walk stops and
 * reports the deepest block reached. Pure over the module-level blockStore (like
 * findPage / pickZoomTarget) — no navigation side effects; the funnel wiring is
 * `navigateWikilinkPath`.
 */
export function resolveWikilinkPath(segments: string[]): PathResolution {
  if (segments.length === 0) {
    return { blockId: null, resolvedDepth: 0, unresolvedTail: [] };
  }

  // Segment 1 — always a page (ADR-008 D1). Reuse the existing page predicate.
  const page = findPage(segments[0]);
  if (!page) {
    return { blockId: null, resolvedDepth: 0, unresolvedTail: segments.slice() };
  }

  let current: Block = page;
  let resolvedDepth = 1;

  for (let i = 1; i < segments.length; i++) {
    const next = selectBestDescendant(segments[i], current.id);
    if (!next) break; // miss — `current` is the deepest resolved block
    current = next;
    resolvedDepth++;
  }

  return {
    blockId: current.id,
    resolvedDepth,
    unresolvedTail: segments.slice(resolvedDepth),
  };
}

/**
 * Navigate a multi-segment wikilink path (ADR-008 D2/D3 — mkdir-p). Resolves the
 * frontier via `resolveWikilinkPath`, then:
 *
 *   1. FULL RESOLUTION (no tail) → land on the resolved block, no creation.
 *   2. SEGMENT-1 MISS (page miss) → create the page via the existing
 *      find-or-create path (`ensurePage`, the same `createPage` single-segment
 *      clicks use), then scaffold segments 2+ under it.
 *   3. PARTIAL MISS → scaffold the unresolved tail under the deepest resolved
 *      block.
 *
 * The tail is created exactly-as-written as a direct-child chain in ONE batch
 * transaction (`createPathTail`, origin 'user' → single undo step, normal Y.Doc
 * + sync flow). Then `navigateToBlock` lands on the DESTINATION (the deepest —
 * last-created — segment) with zoom-with-context + highlight, identical to the
 * full-resolution path. Every click succeeds; there is no miss return and no
 * notice — the junk-page-"a > b" behavior is retired, replaced by real
 * scaffolding.
 *
 * ID-THREADING (ADR-008 doctrine): the destination is reached by threading the
 * ids the create APIs HAND BACK (`ensurePage` → page block; `createPathTail` →
 * batch top-level id descended via `childIds` to the leaf) — never by
 * re-resolving a just-written segment by name. See `createPathTail`.
 *
 * Fuzzy-FOUND segments are not re-created: `resolveWikilinkPath`'s ladder
 * absorbs case/markdown/marker variance, so re-clicking a path that already
 * exists resolves fully (branch 1) and scaffolds nothing (idempotent).
 *
 * `paneId` MUST be pre-resolved by the caller (funnel doctrine: pane link
 * resolution at the call site, not inside the funnel).
 */
export function navigateWikilinkPath(
  segments: string[],
  options: NavigateOptions = {}
): NavigateResult {
  const { paneId, splitDirection, highlight, originBlockId } = options;

  if (!paneId) {
    logger.warn('navigateWikilinkPath: no paneId provided');
    return { success: false, targetPaneId: null, error: 'No paneId provided' };
  }

  const resolution = resolveWikilinkPath(segments);

  // Determine the parent under which to scaffold the unresolved tail, and the
  // tail segments themselves. mkdir-p: segment-1 miss creates the page (the
  // scaffold parent); a partial miss scaffolds under the deepest resolved block.
  let parentId: string;
  let tail: string[];

  if (resolution.blockId === null) {
    // Segment 1 (the page) missed → create the page, thread its id (never a
    // findPage-by-name re-resolve after the write). Tail is segments 2+.
    const page = ensurePage(segments[0]);
    if (!page) {
      logger.warn('path mkdir-p: page create failed', { path: segments.join(' > ') });
      return { success: false, targetPaneId: paneId, error: 'path page create failed' };
    }
    parentId = page.id;
    tail = segments.slice(1);
  } else if (resolution.unresolvedTail.length > 0) {
    // Partial miss → scaffold the tail under the deepest resolved block.
    parentId = resolution.blockId;
    tail = resolution.unresolvedTail;
  } else {
    // Full resolution — land on the resolved block, no creation.
    return navigateToBlock(resolution.blockId, {
      paneId,
      highlight: highlight ?? true,
      splitDirection,
      originBlockId,
    });
  }

  // Defensive: a single-segment call whose page was just created has an empty
  // tail — nothing to scaffold, land on the parent (the page). Multi-segment
  // callers (parsePathSegments length > 1 guard) never hit this.
  const destinationId = tail.length === 0 ? parentId : createPathTail(parentId, tail);
  if (!destinationId) {
    logger.warn('path mkdir-p: tail scaffold failed', {
      path: segments.join(' > '),
      parentId,
      tail,
    });
    return { success: false, targetPaneId: paneId, error: 'path tail create failed' };
  }

  return navigateToBlock(destinationId, {
    paneId,
    highlight: highlight ?? true,
    splitDirection,
    originBlockId,
  });
}

/**
 * Scaffold `tail` as a direct-child chain under `parentId` in ONE batch
 * transaction, returning the DESTINATION (deepest) block id. Content is the
 * segment text exactly-as-written; each segment is the sole child of the
 * previous (mkdir-p direct-child semantics — no level skipping on the write
 * side, ADR-008 D2). Origin 'user' → tracked by the UndoManager, so the whole
 * chain is a single undo step and syncs like any user edit.
 *
 * The batch API returns only top-level ids, so the destination is reached by
 * descending `childIds[0]` `tail.length - 1` times from the created top block —
 * pure id-threading over the ids the write handed back (each created block has
 * exactly one child, so `childIds[0]` is unambiguous), never a name re-resolve.
 */
function createPathTail(parentId: string, tail: string[]): string | null {
  // Nested BatchBlockOp: tail[0] > tail[1] > ... (each a child of the previous).
  let op: BatchBlockOp = { content: tail[tail.length - 1] };
  for (let i = tail.length - 2; i >= 0; i--) {
    op = { content: tail[i], children: [op] };
  }

  const created = blockStore.batchCreateBlocksInside(parentId, [op], 'user');
  if (created.length === 0) return null;

  let destinationId = created[0];
  for (let i = 1; i < tail.length; i++) {
    const childId = blockStore.getBlock(destinationId)?.childIds[0];
    if (!childId) return null; // fresh chain guarantees one child per level
    destinationId = childId;
  }
  return destinationId;
}

// ═══════════════════════════════════════════════════════════════
// ZOOM TARGET SELECTION
// ═══════════════════════════════════════════════════════════════

/**
 * Pick the best zoom target for navigating to a block.
 *
 * Walks up the ancestor chain to give context (show target with siblings),
 * but stops before landing on a root-level block. Zooming to root or to
 * container blocks like pages:: defeats the purpose — you'd see the entire
 * outline instead of focused context.
 *
 * Heuristic: go up at most 2 levels, but never zoom to a root block.
 */
function pickZoomTarget(blockId: string, targetBlock: Block | null): string {
  if (!targetBlock?.parentId) {
    // Block is root-level or not found — zoom to itself
    return blockId;
  }

  const rootIds = new Set(blockStore.rootIds);

  // Parent exists and is not root → candidate
  const parentBlock = blockStore.getBlock(targetBlock.parentId);
  if (!parentBlock) return blockId;

  if (rootIds.has(targetBlock.parentId)) {
    // Parent IS a root block (e.g., pages::) — zoom to target itself
    return blockId;
  }

  // Try grandparent for more context
  if (parentBlock.parentId) {
    if (rootIds.has(parentBlock.parentId)) {
      // Grandparent is root — stop at parent (one level below root)
      return targetBlock.parentId;
    }
    // Grandparent is not root — zoom to grandparent
    return parentBlock.parentId;
  }

  // Parent has no parent (shouldn't happen if parent isn't root, but guard)
  return targetBlock.parentId;
}

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════

/**
 * Expand collapsed ancestors between a zoom target and a destination block.
 *
 * After zooming to an ancestor, intermediate blocks between the zoom target
 * and the actual destination may be collapsed. This walks from destination
 * up to (but not including) the zoom target, expanding each ancestor so
 * the destination block renders in the DOM.
 *
 * Cap at 10 levels to prevent runaway expansion (matches expandAncestors cap).
 */
function expandAncestorsToTarget(blockId: string, zoomTargetId: string, paneId: string): void {
  if (blockId === zoomTargetId) return;
  const MAX_LEVELS = 10;
  let current = blockStore.getBlock(blockId);
  let levels = 0;
  while (current?.parentId && current.parentId !== zoomTargetId && levels < MAX_LEVELS) {
    // Expand the parent so its children (including our path) are visible
    paneStore.setCollapsed(paneId, current.parentId, false);
    current = blockStore.getBlock(current.parentId);
    levels++;
  }
}

/**
 * Scroll to and highlight a block after zoom settles.
 *
 * Problem: zoomTo() triggers SolidJS re-render. If we find the element too early,
 * we highlight a stale DOM node that gets replaced by the re-render. Double-rAF
 * ensures we wait for SolidJS to finish its reactive updates and the browser to
 * paint, then we find the FRESH element. Retries handle cases where the block
 * tree takes longer to render (large subtrees, lazy loading).
 */
function scrollAndHighlightWithRetry(blockId: string, paneId: string, initialDelay: number, highlight = true): void {
  // Per-pane cancellation: newer navigation in same pane supersedes this retry chain
  const token = Symbol(blockId);
  pendingRetryTokenByPaneId.set(paneId, token);

  let attempts = 0;
  const maxAttempts = 6;

  function tryScrollAndHighlight() {
    // Cancelled by newer navigation in this pane
    if (pendingRetryTokenByPaneId.get(paneId) !== token) return;

    attempts++;
    const element = findBlockInPane(blockId, paneId);
    if (element) {
      element.scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (highlight) {
        highlightBlockInPane(blockId, paneId);
      } else {
        // Clear any stale highlight from previous navigation in this pane
        highlightCleanupByPaneId.get(paneId)?.();
        highlightCleanupByPaneId.delete(paneId);
      }
      // Clean up token on success
      if (pendingRetryTokenByPaneId.get(paneId) === token) {
        pendingRetryTokenByPaneId.delete(paneId);
      }
    } else if (attempts < maxAttempts) {
      // Block not in DOM yet — wait another frame
      requestAnimationFrame(() => {
        if (pendingRetryTokenByPaneId.get(paneId) !== token) return;
        setTimeout(tryScrollAndHighlight, 16);
      });
    } else {
      logger.warn('scrollAndHighlightWithRetry: block not found after max attempts', { blockId, paneId });
      // Clean up token on exhaustion
      if (pendingRetryTokenByPaneId.get(paneId) === token) {
        pendingRetryTokenByPaneId.delete(paneId);
      }
    }
  }

  // Wait for initial delay, then double-rAF to let SolidJS render + browser paint
  setTimeout(() => {
    if (pendingRetryTokenByPaneId.get(paneId) !== token) return;
    requestAnimationFrame(() => {
      if (pendingRetryTokenByPaneId.get(paneId) !== token) return;
      requestAnimationFrame(tryScrollAndHighlight);
    });
  }, initialDelay);
}

/**
 * Find a block element within a specific pane.
 *
 * Searches all elements with matching data-pane-id (there can be multiple:
 * the pane-layout-leaf placeholder AND the outliner container). Falls back
 * to global search if pane-scoped search fails.
 */
function findBlockInPane(blockId: string, paneId: string): Element | null {
  const blockSelector = `[data-block-id="${CSS.escape(blockId)}"]`;

  // Try all pane containers with this ID (placeholder + outliner may both exist)
  const paneContainers = document.querySelectorAll(`[data-pane-id="${CSS.escape(paneId)}"]`);
  for (const container of paneContainers) {
    const block = container.querySelector(blockSelector);
    if (block) return block;
  }

  // No global fallback — returning null lets the retry loop handle unrendered blocks.
  // A global querySelector would match the block in the wrong pane in multi-pane layouts.
  return null;
}

/** Track highlight cleanup per pane (supports concurrent highlights in multi-pane) */
const highlightCleanupByPaneId = new Map<string, () => void>();

/** Per-pane cancellation tokens for retry loops — newer navigation supersedes stale retries */
const pendingRetryTokenByPaneId = new Map<string, symbol>();

/**
 * Highlight a block in a specific pane. Stays visible until the user interacts
 * within that pane (click or keypress), then fades out over 2s. This handles
 * the "squirrel" case — cmd-click several links, highlights persist until you
 * actually engage with each pane. Safety timeout at 60s.
 */
function highlightBlockInPane(blockId: string, paneId: string): void {
  // Clean up any existing highlight in this pane (other panes keep theirs)
  const existingCleanup = highlightCleanupByPaneId.get(paneId);
  if (existingCleanup) {
    existingCleanup();
    highlightCleanupByPaneId.delete(paneId);
  }

  const element = findBlockInPane(blockId, paneId);
  if (!element) return;

  element.classList.add('block-highlight');

  // Scope interaction detection to the outliner container, not the block itself.
  // BlockItem stamps data-pane-id on every .block-item, so closest('[data-pane-id]')
  // would resolve to the block — clicks elsewhere in the pane wouldn't clear highlight.
  const listenerTarget: EventTarget =
    element.closest(`.outliner-container[data-pane-id]`)
    ?? document.querySelector(`.outliner-container[data-pane-id="${CSS.escape(paneId)}"]`)
    ?? document;

  let fadeTimeout: ReturnType<typeof setTimeout> | null = null;

  const cleanup = () => {
    element.classList.remove('block-highlight');
    element.classList.remove('block-highlight-fade');
    listenerTarget.removeEventListener('click', onPaneInteraction);
    listenerTarget.removeEventListener('keydown', onPaneInteraction);
    if (fadeTimeout) clearTimeout(fadeTimeout);
    clearTimeout(safetyTimeout);
    if (highlightCleanupByPaneId.get(paneId) === cleanup) {
      highlightCleanupByPaneId.delete(paneId);
    }
  };

  // When user interacts within this pane, start fade-out
  const onPaneInteraction = () => {
    listenerTarget.removeEventListener('click', onPaneInteraction);
    listenerTarget.removeEventListener('keydown', onPaneInteraction);
    // Transition to fade-out class, then remove after animation
    element.classList.add('block-highlight-fade');
    fadeTimeout = setTimeout(cleanup, 2000);
  };

  listenerTarget.addEventListener('click', onPaneInteraction, { once: true });
  listenerTarget.addEventListener('keydown', onPaneInteraction, { once: true });

  // Safety timeout (60s — long enough for squirrel moments)
  const safetyTimeout = setTimeout(cleanup, 60000);

  highlightCleanupByPaneId.set(paneId, cleanup);
}

// ═══════════════════════════════════════════════════════════════
// PANE TARGETING (FLO-223 R9)
// ═══════════════════════════════════════════════════════════════

/**
 * Resolve the target outliner pane for cross-pane navigation.
 *
 * Resolution chain:
 * 1. Block link (block→pane) — specific block override
 * 2. Pane link (pane→pane) — "anything from this pane goes there"
 * 3. Last-focused outliner fallback — activePaneId if it's an outliner, else first outliner
 *
 * Pane links enable chaining: A→B, B→C means nav from A goes to B, nav from B goes to C.
 */
export function resolveTargetPane(sourcePaneId: string, blockId?: string): string | null {
  // 1-2. Check block link, then pane link
  const linked = paneLinkStore.resolveLink(sourcePaneId, blockId);
  if (linked) return linked;
  // 3. Fallback: find an outliner pane that isn't the source
  return findFallbackOutlinerPane(sourcePaneId);
}

/**
 * Find an outliner pane to navigate, preferring the active pane.
 * When excludePaneId is empty/unknown, searches the active tab.
 */
function findFallbackOutlinerPane(excludePaneId: string): string | null {
  // Try to find the tab by pane ID; fall back to active tab for no-hint case
  const tabId = findTabIdByPaneId(excludePaneId) ?? tabStore.activeTabId() ?? null;
  if (!tabId) return null;
  const layout = layoutStore.layouts[tabId];
  if (!layout) return null;

  const leaves = collectLeaves(layout.root);
  const otherOutliners = leaves.filter(
    (l: PaneLeaf) => l.leafType === 'outliner' && l.id !== excludePaneId
  );

  if (otherOutliners.length === 0) return null;

  // Prefer the active pane if it's among the candidates
  if (otherOutliners.some((l: PaneLeaf) => l.id === layout.activePaneId)) {
    return layout.activePaneId;
  }

  return otherOutliners[0].id;
}

// HMR cleanup: clear highlight state on module reload
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    for (const cleanup of highlightCleanupByPaneId.values()) {
      cleanup();
    }
    highlightCleanupByPaneId.clear();
    pendingRetryTokenByPaneId.clear();
  });
}
