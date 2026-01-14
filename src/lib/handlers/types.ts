/**
 * Handler Registry Types
 * 
 * Shared types for the block handler system.
 */

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
  /** Create a new block as sibling after given block */
  createBlockAfter?: (afterId: string) => string;
  /** Update the content of a block */
  updateBlockContent: (id: string, content: string) => void;
  /** Update content from executor (syncs to DOM even when block is focused) */
  updateBlockContentFromExecutor?: (id: string, content: string) => void;
  /** Delete a block */
  deleteBlock?: (id: string) => boolean;
  /** Set the output data on a block (for structured views like daily::) */
  setBlockOutput?: (id: string, output: unknown, outputType: string) => void;
  /** Set the loading status on a block */
  setBlockStatus?: (id: string, status: 'idle' | 'running' | 'complete' | 'error') => void;
  /** Get block by ID (for reading state) */
  getBlock?: (id: string) => unknown;
  /** Get parent block ID (for tree navigation in conversation handler) */
  getParentId?: (id: string) => string | undefined;
  /** Get child block IDs (for tree navigation in conversation handler) */
  getChildren?: (id: string) => string[];
  /** Pane ID for scoping picker queries in split layouts */
  paneId?: string;
  /** Focus a block (for post-execution cursor placement) */
  focusBlock?: (id: string) => void;
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
