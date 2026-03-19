/**
 * Navigation API - Global navigation functions for plugins and view components
 *
 * Exposed to handlers via ExecutorActions and directly importable by view components.
 * Wraps existing paneStore/layoutStore/backlinkNavigation functions.
 */

import { paneStore } from '../hooks/usePaneStore';
import { tabStore } from '../hooks/useTabStore';
import { layoutStore } from '../hooks/useLayoutStore';
import { findTabIdByPaneId, navigateToPage as navigateToPageImpl } from '../hooks/useBacklinkNavigation';
import { blockStore } from '../hooks/useBlockStore';
import { paneLinkStore } from '../hooks/usePaneLinkStore';
import { collectLeaves, type PaneLeaf } from './layoutTypes';
import { resolveBlockIdPrefix, BLOCK_ID_PREFIX_RE, type Block } from './blockTypes';

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
  error?: string;
}

// ═══════════════════════════════════════════════════════════════
// PANE LINK RESOLUTION
// ═══════════════════════════════════════════════════════════════

/**
 * Resolve pane link for same-tab navigation only.
 * Returns linkedPaneId if linked and in same tab, otherwise sourcePaneId.
 *
 * This is the call-site resolution pattern (FM #7): callers resolve before
 * entering the navigation funnel, not inside it.
 */
export function resolveSameTabLink(sourcePaneId: string, blockId?: string): string {
  const linked = paneLinkStore.resolveLink(sourcePaneId, blockId);
  if (!linked) return sourcePaneId;
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
    console.warn('[navigation] navigateToBlock: no paneId provided');
    return { success: false, targetPaneId: null, error: 'No paneId provided' };
  }

  let targetPaneId = paneId;

  if (splitDirection) {
    // Find tab for this pane to do split
    const tabId = findTabIdByPaneId(paneId);
    if (!tabId) {
      console.warn('[navigation] Could not find tabId for pane, using current pane');
    } else {
      // Split in requested direction
      const newPaneId = layoutStore.splitPane(tabId, splitDirection, 'outliner');
      if (newPaneId) {
        targetPaneId = newPaneId;
      } else {
        console.warn('[navigation] Split failed, using current pane');
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

  // Scroll to the actual target block (after DOM settles), optionally highlight
  const delay = splitDirection ? 150 : 50;
  scrollAndHighlightWithRetry(blockId, targetPaneId, delay, highlight);

  return { success: true, targetPaneId };
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
    console.warn('[navigation] navigateToPage: no paneId provided');
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

  if (highlight && result.pageId && result.targetPaneId) {
    // Delay for split panes to render
    const delay = splitDirection ? 150 : 50;
    setTimeout(() => {
      highlightBlockInPane(result.pageId!, result.targetPaneId!);
    }, delay);
  }

  return { success: true, targetPaneId: result.targetPaneId };
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
    console.warn('[navigation] scrollToBlock: element not found', { blockId });
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
      console.warn('[navigation] chirp navigate: block not in outline', {
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
    console.warn('[navigation] chirp navigate: block ID prefix did not resolve', {
      target,
      blockCount: blockIds.length,
    });
    return { success: false, targetPaneId, error: 'block not found' };
  }

  // Page navigation fallback
  return navigateToPage(target, {
    paneId: targetPaneId,
    highlight: true,
    splitDirection,
  });
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
      console.warn('[navigation] scrollAndHighlightWithRetry: block not found after max attempts', { blockId, paneId });
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

  // Fallback: find globally (block may be in a different DOM subtree for this pane)
  return document.querySelector(blockSelector);
}

/**
 * Scroll a block into view within a specific pane
 */
function scrollToBlockInPane(blockId: string, paneId: string): void {
  const element = findBlockInPane(blockId, paneId);
  if (element) {
    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } else {
    console.warn('[navigation] scrollToBlockInPane: element not found', { blockId, paneId });
  }
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

  // Scope interaction detection to the pane container that actually has the block.
  // Use the block's own ancestor (handles dual data-pane-id: placeholder + outliner).
  const listenerTarget: EventTarget = element.closest(`[data-pane-id]`) ?? document;

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
