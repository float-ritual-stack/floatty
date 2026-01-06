/**
 * Smart Paste Handler (FLO-62, FLO-128)
 *
 * Handles clipboard paste with markdown structure parsing.
 * Pasted markdown becomes structured blocks (like sh:: cat output).
 *
 * Fixes:
 * - FLO-62: Rich text causing duplicates → we only read plain text
 * - FLO-128: Markdown should structure like sh:: cat output
 */

import { parseMarkdownTree, hasMarkdownStructure, type ParsedBlock } from './markdownParser';

export interface PasteActions {
  /** Get block by ID */
  getBlock: (id: string) => { content: string; parentId: string | null; childIds: string[] } | undefined;
  /** Create sibling after block */
  createBlockAfter: (id: string) => string;
  /** Create child inside block */
  createBlockInside: (parentId: string) => string;
  /** Update block content */
  updateBlockContent: (id: string, content: string) => void;
}

/**
 * Insert parsed blocks as siblings after targetId
 * Returns ID of last inserted block (for focus)
 */
function insertParsedBlocksAsSiblings(
  afterId: string,
  blocks: ParsedBlock[],
  actions: PasteActions
): string {
  let lastId = afterId;

  for (const block of blocks) {
    const newId = actions.createBlockAfter(lastId);
    actions.updateBlockContent(newId, block.content);
    lastId = newId;

    // Insert children recursively
    if (block.children.length > 0) {
      insertChildBlocks(newId, block.children, actions);
    }
  }

  return lastId;
}

/**
 * Insert parsed blocks as children of parentId
 */
function insertChildBlocks(
  parentId: string,
  blocks: ParsedBlock[],
  actions: PasteActions
): void {
  for (const block of blocks) {
    const newId = actions.createBlockInside(parentId);
    actions.updateBlockContent(newId, block.content);

    if (block.children.length > 0) {
      insertChildBlocks(newId, block.children, actions);
    }
  }
}

/**
 * Handle structured paste from clipboard
 *
 * Behavior:
 * - If current block is empty: first parsed block replaces content, rest are siblings
 * - If current block has content: all parsed blocks become siblings after
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

  // We have structure! Insert blocks
  const currentBlock = actions.getBlock(blockId);
  const isCurrentEmpty = !currentBlock?.content.trim();

  if (isCurrentEmpty && parsed.length > 0) {
    // Current block is empty - use first parsed block as its content
    const first = parsed[0];
    actions.updateBlockContent(blockId, first.content);

    // Insert first block's children inside current block
    if (first.children.length > 0) {
      insertChildBlocks(blockId, first.children, actions);
    }

    // Remaining blocks become siblings after
    if (parsed.length > 1) {
      const lastId = insertParsedBlocksAsSiblings(blockId, parsed.slice(1), actions);
      return { handled: true, focusId: lastId };
    }

    return { handled: true, focusId: blockId };
  } else {
    // Current block has content - all parsed blocks become siblings after
    const lastId = insertParsedBlocksAsSiblings(blockId, parsed, actions);
    return { handled: true, focusId: lastId };
  }
}
