/**
 * Navigation API - Global navigation functions for plugins and view components
 *
 * Exposed to handlers via ExecutorActions and directly importable by view components.
 * Wraps existing paneStore/layoutStore/backlinkNavigation functions.
 */

import { paneStore } from '../hooks/usePaneStore';
import { layoutStore } from '../hooks/useLayoutStore';
import { findTabIdByPaneId, navigateToPage as navigateToPageImpl } from '../hooks/useBacklinkNavigation';
import { blockStore } from '../hooks/useBlockStore';
import { paneLinkStore } from '../hooks/usePaneLinkStore';
import { collectLeaves, type PaneLeaf } from './layoutTypes';
import { resolveBlockIdPrefix, BLOCK_ID_PREFIX_RE } from './blockTypes';

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
}

export interface NavigateResult {
  success: boolean;
  targetPaneId: string | null;
  error?: string;
}

// ═══════════════════════════════════════════════════════════════
// NAVIGATION FUNCTIONS
// ═══════════════════════════════════════════════════════════════

/**
 * Navigate to a block by ID with context (zoom to parent to show siblings)
 *
 * By default, zooms to the parent block so the target is visible with its siblings.
 * If the block has no parent (root level), zooms to the block itself.
 *
 * @param blockId - Target block ID
 * @param options - Navigation options
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

  // Determine zoom target: parent for context, or block itself if no parent
  let zoomTarget = blockId;
  if (targetBlock?.parentId) {
    // Check if parent also has a parent (give more context for nested blocks)
    const parentBlock = blockStore.getBlock(targetBlock.parentId);
    if (parentBlock?.parentId) {
      // Zoom to grandparent for even more context
      zoomTarget = parentBlock.parentId;
    } else {
      // Zoom to parent
      zoomTarget = targetBlock.parentId;
    }
  }

  // Zoom to context block (zoomTo pushes to nav history so Cmd+[ works)
  // Pass originBlockId so goBack() can restore focus to the search output block
  paneStore.zoomTo(targetPaneId, zoomTarget, { originBlockId });

  // Set focus on the target block so it receives DOM focus after zoom
  paneStore.setFocusedBlockId(targetPaneId, blockId);

  // Scroll to and highlight the actual target block (after DOM settles)
  if (highlight) {
    // Longer delay for splits to allow new pane to render
    const delay = splitDirection ? 150 : 50;
    setTimeout(() => {
      scrollToBlockInPane(blockId, targetPaneId);
      highlightBlockInPane(blockId, targetPaneId);
    }, delay);
  }

  return { success: true, targetPaneId };
}

/**
 * Navigate to a page by name (find or create under pages::)
 *
 * @param pageName - Target page name
 * @param options - Navigation options
 */
export function navigateToPage(pageName: string, options: NavigateOptions = {}): NavigateResult {
  const { paneId, splitDirection, highlight } = options;

  if (!paneId) {
    console.warn('[navigation] navigateToPage: no paneId provided');
    return { success: false, targetPaneId: null, error: 'No paneId provided' };
  }

  // Use existing implementation from useBacklinkNavigation
  const result = navigateToPageImpl(
    pageName,
    paneId,
    splitDirection ?? 'none',
    false // ephemeral
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
// HELPERS
// ═══════════════════════════════════════════════════════════════

/**
 * Find a block element within a specific pane
 */
function findBlockInPane(blockId: string, paneId: string): Element | null {
  // First try to find the pane container
  const paneContainer = document.querySelector(`[data-pane-id="${CSS.escape(paneId)}"]`);
  if (paneContainer) {
    return paneContainer.querySelector(`[data-block-id="${CSS.escape(blockId)}"]`);
  }
  // Fallback to global search if pane not found
  return document.querySelector(`[data-block-id="${CSS.escape(blockId)}"]`);
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

/** Track current highlight cleanup function */
let currentHighlightCleanup: (() => void) | null = null;

/**
 * Highlight a block in a specific pane until user interaction or max timeout.
 * Only one block can be highlighted at a time.
 */
function highlightBlockInPane(blockId: string, paneId: string): void {
  // Clean up any existing highlight first
  if (currentHighlightCleanup) {
    currentHighlightCleanup();
    currentHighlightCleanup = null;
  }

  const element = findBlockInPane(blockId, paneId);
  if (!element) return;

  element.classList.add('block-highlight');

  // Create cleanup function
  const cleanup = () => {
    element.classList.remove('block-highlight');
    document.removeEventListener('click', onInteraction);
    document.removeEventListener('keydown', onInteraction);
    clearTimeout(maxTimeout);
    if (currentHighlightCleanup === cleanup) {
      currentHighlightCleanup = null;
    }
  };

  // Remove highlight on any user interaction
  const onInteraction = () => cleanup();

  // Add listeners (capture phase to catch early)
  document.addEventListener('click', onInteraction, { once: true });
  document.addEventListener('keydown', onInteraction, { once: true });

  // Safety timeout (30s max)
  const maxTimeout = setTimeout(cleanup, 30000);

  currentHighlightCleanup = cleanup;
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
 */
function findFallbackOutlinerPane(excludePaneId: string): string | null {
  const tabId = findTabIdByPaneId(excludePaneId);
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
    if (currentHighlightCleanup) {
      currentHighlightCleanup();
      currentHighlightCleanup = null;
    }
  });
}
