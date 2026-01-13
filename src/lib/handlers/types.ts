/**
 * Handler Registry Types
 *
 * Shared types for the block handler system.
 */

import type { SplitDirection, BlockNavigationResult, NavigationResult } from '../navigation';

// ═══════════════════════════════════════════════════════════════
// EXECUTOR ACTIONS
// ═══════════════════════════════════════════════════════════════

/**
 * Actions available to handlers for block manipulation
 * Unifies ExecutorActions and DailyExecutorActions patterns
 */
export interface ExecutorActions {
  /** Create a new block as the last child of parentId */
  createBlockInside: (parentId: string) => string;
  /** Create a new block as the first child of parentId */
  createBlockInsideAtTop?: (parentId: string) => string;
  /** Update the content of a block */
  updateBlockContent: (id: string, content: string) => void;
  /** Delete a block */
  deleteBlock?: (id: string) => boolean;
  /** Set the output data on a block (for structured views like daily::) */
  setBlockOutput?: (id: string, output: unknown, outputType: string) => void;
  /** Set the loading status on a block */
  setBlockStatus?: (id: string, status: 'idle' | 'running' | 'complete' | 'error') => void;
  /** Get block by ID (for reading state) */
  getBlock?: (id: string) => unknown;
  /** Pane ID for scoping picker queries in split layouts */
  paneId?: string;

  // ═══════════════════════════════════════════════════════════════
  // NAVIGATION (for search::, pick::, and result views)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Navigate to a block by ID.
   * Zooms the pane to show the block. Optionally creates a split.
   */
  navigateToBlock?: (
    blockId: string,
    options?: { splitDirection?: SplitDirection; highlight?: boolean; ephemeral?: boolean }
  ) => BlockNavigationResult;

  /**
   * Navigate to a page by name.
   * Creates the page if it doesn't exist.
   */
  navigateToPage?: (
    pageName: string,
    options?: { splitDirection?: SplitDirection; ephemeral?: boolean }
  ) => NavigationResult;

  /**
   * Scroll a block into view without changing zoom.
   * Returns true if block was found.
   */
  scrollToBlock?: (blockId: string) => boolean;

  /**
   * Highlight a block with brief animation.
   */
  highlightBlock?: (blockId: string) => void;
}

// ═══════════════════════════════════════════════════════════════
// BLOCK HANDLER INTERFACE
// ═══════════════════════════════════════════════════════════════

/**
 * Handler for executable block types (sh::, ai::, daily::, door::, etc.)
 */
export interface BlockHandler {
  /** Prefixes that trigger this handler (e.g., ['sh::', 'term::']) */
  prefixes: string[];
  
  /** Execute the block content and handle output */
  execute: (blockId: string, content: string, actions: ExecutorActions) => Promise<void>;
}
