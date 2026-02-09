/**
 * Handler Utilities
 *
 * Shared helper functions used by multiple handlers.
 */

import type { ExecutorActions } from './types';
import type { ParsedBlock } from '../markdownParser';

/**
 * Find existing output child block by prefix (for idempotent re-run).
 * Used by backup::, info::, and other child-output pattern handlers.
 */
export function findOutputChild(parentId: string, actions: ExecutorActions, prefix: string): string | null {
  if (!actions.getBlock) return null;

  const parent = actions.getBlock(parentId) as { childIds?: string[] };
  if (!parent || !parent.childIds) return null;

  for (const childId of parent.childIds) {
    const child = actions.getBlock(childId) as { outputType?: string };
    if (child?.outputType?.startsWith(prefix)) {
      return childId;
    }
  }
  return null;
}

/**
 * Format bytes as human-readable string.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Format ISO timestamp as relative time string.
 */
export function formatRelativeTime(isoString: string | null): string {
  if (!isoString) return 'never';

  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMs < 0) {
    const futureMins = Math.abs(diffMins);
    if (futureMins < 60) return `in ${futureMins}m`;
    return `in ${Math.floor(futureMins / 60)}h ${futureMins % 60}m`;
  }

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ${diffMins % 60}m ago`;
  return `${diffDays}d ago`;
}

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
