/**
 * Navigation API - Centralized navigation functions for handlers and views
 *
 * This module exposes navigation primitives for:
 * - Handlers (search::, pick::) to navigate to results
 * - View components (SearchResultsView) to handle click-to-navigate
 * - Any code that needs to navigate without direct store access
 *
 * Design: Global module pattern (Option C from spec)
 * Navigation is inherently global (affects pane state), so export functions
 * that can be imported directly rather than threading through props/context.
 *
 * @see docs/handoffs/search-plugin-spec.md for architecture rationale
 */

import { paneStore } from '../hooks/usePaneStore';
import { layoutStore } from '../hooks/useLayoutStore';
import { blockStore } from '../hooks/useBlockStore';
import {
  navigateToPage as backlinkNavigateToPage,
  findTabIdByPaneId,
  type NavigationResult,
  type SplitDirection,
} from '../hooks/useBacklinkNavigation';

export type { NavigationResult, SplitDirection };

/**
 * Options for navigating to a block
 */
export interface NavigateToBlockOptions {
  /** Pane to navigate in. Required for split operations. */
  paneId: string;
  /** Split direction. If set, creates new pane for navigation. */
  splitDirection?: SplitDirection;
  /** Whether to highlight the block briefly after navigation */
  highlight?: boolean;
  /** Whether the new split should be ephemeral (preview mode) */
  ephemeral?: boolean;
}

/**
 * Options for navigating to a page
 */
export interface NavigateToPageOptions {
  /** Pane to navigate in. Required. */
  paneId: string;
  /** Split direction. If set, creates new pane for navigation. */
  splitDirection?: SplitDirection;
  /** Whether the new split should be ephemeral (preview mode) */
  ephemeral?: boolean;
}

/**
 * Result of a block navigation operation
 */
export interface BlockNavigationResult {
  success: boolean;
  /** The pane where navigation occurred (may be new if split) */
  targetPaneId: string | null;
  /** Block ID that was navigated to */
  blockId: string | null;
  error?: string;
}

/**
 * Navigate to a specific block by ID.
 *
 * Behavior:
 * - Zooms the pane to show the block and its subtree
 * - Optionally creates a split pane for the navigation
 * - Optionally highlights the block with a brief animation
 *
 * @param blockId - The block to navigate to
 * @param options - Navigation options
 * @returns Result with success status and target pane
 */
export function navigateToBlock(
  blockId: string,
  options: NavigateToBlockOptions
): BlockNavigationResult {
  const { paneId, splitDirection = 'none', highlight = false, ephemeral = false } = options;

  // Validate block exists
  const block = blockStore.getBlock(blockId);
  if (!block) {
    return {
      success: false,
      targetPaneId: null,
      blockId: null,
      error: `Block not found: ${blockId}`,
    };
  }

  let targetPaneId = paneId;

  // Handle split if requested
  if (splitDirection !== 'none') {
    const tabId = findTabIdByPaneId(paneId);
    if (!tabId) {
      console.warn('[navigation] Could not find tabId for pane, using current pane');
    } else {
      const newPaneId = layoutStore.splitPane(tabId, splitDirection, 'outliner', ephemeral);
      if (newPaneId) {
        targetPaneId = newPaneId;
      } else {
        console.warn('[navigation] Split failed, using current pane');
      }
    }
  }

  // Zoom to the block (makes it the root of the pane view)
  paneStore.setZoomedRoot(targetPaneId, blockId);

  // Highlight if requested
  if (highlight) {
    // Delay to ensure DOM is updated after zoom
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        highlightBlock(blockId, targetPaneId);
      });
    });
  }

  return {
    success: true,
    targetPaneId,
    blockId,
  };
}

/**
 * Navigate to a page by name.
 *
 * Wraps the existing useBacklinkNavigation.navigateToPage() function
 * to provide a consistent API with navigateToBlock().
 *
 * @param pageName - The page name to navigate to
 * @param options - Navigation options
 * @returns Navigation result
 */
export function navigateToPage(
  pageName: string,
  options: NavigateToPageOptions
): NavigationResult {
  const { paneId, splitDirection = 'none', ephemeral = false } = options;
  return backlinkNavigateToPage(pageName, paneId, splitDirection, ephemeral);
}

/**
 * Scroll a block into view and optionally highlight it.
 *
 * Unlike navigateToBlock(), this does NOT zoom - it just scrolls
 * to make the block visible in the current view. Useful for:
 * - Jumping to search results without changing zoom level
 * - Highlighting a referenced block
 *
 * @param blockId - The block to scroll to
 * @param paneId - Optional pane to scope the search (for split layouts)
 * @returns true if block was found and scrolled to
 */
export function scrollToBlock(blockId: string, paneId?: string): boolean {
  // Build selector - scope to pane if provided
  const selector = paneId
    ? `[data-pane-id="${CSS.escape(paneId)}"] [data-block-id="${CSS.escape(blockId)}"]`
    : `[data-block-id="${CSS.escape(blockId)}"]`;

  const element = document.querySelector(selector);
  if (!element) {
    return false;
  }

  element.scrollIntoView({ behavior: 'smooth', block: 'center' });
  return true;
}

/**
 * Highlight a block with a brief animation.
 *
 * Adds a CSS class that triggers a highlight animation, then removes it.
 * Used for visual feedback after navigation.
 *
 * @param blockId - The block to highlight
 * @param paneId - Optional pane to scope the search
 */
export function highlightBlock(blockId: string, paneId?: string): void {
  const selector = paneId
    ? `[data-pane-id="${CSS.escape(paneId)}"] [data-block-id="${CSS.escape(blockId)}"]`
    : `[data-block-id="${CSS.escape(blockId)}"]`;

  const element = document.querySelector(selector);
  if (!element) return;

  // Scroll into view first
  element.scrollIntoView({ behavior: 'smooth', block: 'center' });

  // Add highlight class (CSS handles animation)
  element.classList.add('block-highlight');

  // Remove after animation completes (matches CSS duration)
  setTimeout(() => {
    element.classList.remove('block-highlight');
  }, 1500);
}

/**
 * Get the active pane ID for a tab.
 * Utility for handlers that need to know the current pane.
 */
export function getActivePaneId(tabId: string): string | null {
  return layoutStore.getActivePaneId(tabId);
}

/**
 * Find which tab contains a given pane.
 * Re-export for convenience.
 */
export { findTabIdByPaneId };
