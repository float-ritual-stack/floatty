/**
 * Smart Paste Handler (FLO-62, FLO-128, FLO-322)
 *
 * Handles clipboard paste with markdown structure parsing.
 * Pasted markdown becomes structured blocks (like sh:: cat output).
 *
 * FLO-322: Uses batch block creation (single Y.Doc transaction)
 * to avoid N×2 transactions for N-block paste.
 *
 * Fixes:
 * - FLO-62: Rich text causing duplicates → we only read plain text
 * - FLO-128: Markdown should structure like sh:: cat output
 * - FLO-322: Batch transaction for bulk paste performance
 */

import { parseMarkdownTree, hasMarkdownStructure, type ParsedBlock } from './markdownParser';
import type { BatchBlockOp } from '../hooks/useBlockStore';

/** Actions needed for structured paste. */
export interface PasteActions {
  /** Get block by ID */
  getBlock: (id: string) => { content: string; parentId: string | null; childIds: string[] } | undefined;
  /** Update block content */
  updateBlockContent: (id: string, content: string) => void;
  /** Batch create blocks as siblings after a block (single transaction) */
  batchCreateBlocksAfter: (afterId: string, ops: BatchBlockOp[]) => string[];
  /** Batch create blocks as children of a block (single transaction) */
  batchCreateBlocksInside: (parentId: string, ops: BatchBlockOp[]) => string[];
}

/**
 * Convert ParsedBlock tree to BatchBlockOp tree.
 * Pure transformation — no side effects.
 */
function parsedToOps(blocks: ParsedBlock[]): BatchBlockOp[] {
  return blocks.map(block => ({
    content: block.content,
    children: block.children.length > 0 ? parsedToOps(block.children) : undefined,
  }));
}

/**
 * Handle structured paste from clipboard
 *
 * Behavior:
 * - If current block is empty: first parsed block replaces content, rest are siblings
 * - If current block has content: all parsed blocks become siblings after
 *
 * FLO-322: All block creation happens in a single Y.Doc transaction via batch API.
 * Undo (Cmd+Z) removes entire paste in one step.
 *
 * @returns Object with handled flag and optional focusId for cursor placement
 */
export function handleStructuredPaste(
  blockId: string,
  clipboardText: string,
  actions: PasteActions
): { handled: boolean; focusId?: string } {
  // Skip if empty or whitespace only
  const trimmed = clipboardText.trim();
  if (!trimmed) {
    return { handled: false };
  }

  // Only structure if content has markdown patterns (headings, lists)
  // Plain multi-line text should paste normally
  if (!hasMarkdownStructure(trimmed)) {
    return { handled: false };
  }

  // Parse markdown structure
  const parsed = parseMarkdownTree(trimmed);

  // If no blocks or single flat block, let browser handle it
  if (parsed.length === 0) {
    return { handled: false };
  }

  // Single block with no children = just text, let browser handle
  if (parsed.length === 1 && parsed[0].children.length === 0) {
    return { handled: false };
  }

  // We have structure! Insert blocks via batch API (single Y.Doc transaction)
  const currentBlock = actions.getBlock(blockId);
  const isCurrentEmpty = !currentBlock?.content.trim();

  if (isCurrentEmpty && parsed.length > 0) {
    // Current block is empty - use first parsed block as its content
    const first = parsed[0];
    actions.updateBlockContent(blockId, first.content);

    // Insert first block's children inside current block (batch)
    if (first.children.length > 0) {
      actions.batchCreateBlocksInside(blockId, parsedToOps(first.children));
    }

    // Remaining blocks become siblings after (batch)
    if (parsed.length > 1) {
      const ops = parsedToOps(parsed.slice(1));
      const createdIds = actions.batchCreateBlocksAfter(blockId, ops);
      const lastId = createdIds.length > 0 ? createdIds[createdIds.length - 1] : blockId;
      return { handled: true, focusId: lastId };
    }

    return { handled: true, focusId: blockId };
  } else {
    // Current block has content - all parsed blocks become siblings after (batch)
    const ops = parsedToOps(parsed);
    const createdIds = actions.batchCreateBlocksAfter(blockId, ops);
    const lastId = createdIds.length > 0 ? createdIds[createdIds.length - 1] : blockId;
    return { handled: true, focusId: lastId };
  }
}
