/**
 * Handler Utilities
 * 
 * Shared helper functions used by multiple handlers.
 */

import type { ExecutorActions } from './types';
import type { ParsedBlock } from '../markdownParser';

/**
 * Extract content after handler prefix
 * Used by sh.ts and ai.ts handlers
 */
export function extractContent(content: string, prefixes: string[]): string {
  const trimmed = content.trim();
  for (const prefix of prefixes) {
    if (trimmed.toLowerCase().startsWith(prefix)) {
      return trimmed.slice(prefix.length).trim();
    }
  }
  return trimmed;
}

/**
 * Insert parsed blocks recursively as children of parentId
 * Used by sh.ts and ai.ts for markdown structure output
 */
export function insertParsedBlocks(
  parentId: string,
  blocks: ParsedBlock[],
  actions: ExecutorActions
): void {
  for (const block of blocks) {
    const newId = actions.createBlockInside(parentId);
    actions.updateBlockContent(newId, block.content);

    if (block.children.length > 0) {
      insertParsedBlocks(newId, block.children, actions);
    }
  }
}

/**
 * Insert parsed blocks at TOP (first child position)
 * For handlers like help:: that want most recent output visible without scrolling
 *
 * Top-level blocks are reversed so [A,B,C] appears as A,B,C visually
 * (insert C→top, B→top, A→top = [A,B,C])
 * Children within sections stay in natural reading order.
 */
export function insertParsedBlocksAtTop(
  parentId: string,
  blocks: ParsedBlock[],
  actions: ExecutorActions
): void {
  // Reverse: Insert [A,B,C] as C→top, B→top, A→top = [A,B,C] visual order
  for (const block of [...blocks].reverse()) {
    const newId = actions.createBlockInsideAtTop?.(parentId) ?? actions.createBlockInside(parentId);
    actions.updateBlockContent(newId, block.content);

    // Children insert normally (bottom) - natural reading order within sections
    if (block.children.length > 0) {
      insertParsedBlocks(newId, block.children, actions);
    }
  }
}
