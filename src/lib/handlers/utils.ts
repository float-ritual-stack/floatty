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
