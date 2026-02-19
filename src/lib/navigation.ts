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

  console.log('[navigation] navigateToBlock:', {
    blockId,
    zoomTarget,
    paneId: targetPaneId,
    split: !!splitDirection
  });

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

// HMR cleanup: clear highlight state on module reload
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    if (currentHighlightCleanup) {
      currentHighlightCleanup();
      currentHighlightCleanup = null;
    }
  });
}
