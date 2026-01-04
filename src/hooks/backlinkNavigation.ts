/**
 * backlinkNavigation - Handles [[wikilink]] click navigation
 *
 * Logic:
 * 1. Search blockStore for a root block matching the target (as heading)
 * 2. If missing: create new root block with "# Target" content
 * 3. Zoom the pane to that block
 *
 * This module encapsulates all navigation logic for wikilinks,
 * keeping components (BlockItem, BlockDisplay) focused on rendering.
 *
 * Note: This exports pure functions, not hooks. Named without "use" prefix
 * to follow React/SolidJS naming conventions.
 */

import type { Block } from '../lib/blockTypes';
import { WIKILINK_PATTERN } from '../lib/inlineParser';

interface BacklinkNavigationOptions {
  blockStore: {
    blocks: Record<string, Block>;
    rootIds: string[];
    createBlockAfterWithContent: (afterId: string, content: string) => string;
  };
  paneStore: {
    setZoomedRoot: (paneId: string, blockId: string | null) => void;
    setFocusedBlockId: (paneId: string, blockId: string | null) => void;
  };
}

/**
 * Find a block that matches the given target title.
 * Matches against:
 * - Exact content match
 * - Heading with matching text (# Target, ## Target, etc.)
 */
function findBlockByTitle(
  blocks: Record<string, Block>,
  rootIds: string[],
  target: string
): Block | null {
  const normalizedTarget = target.trim().toLowerCase();

  // First, check root blocks for heading matches
  for (const rootId of rootIds) {
    const block = blocks[rootId];
    if (!block) continue;

    const content = block.content.trim();
    const contentLower = content.toLowerCase();

    // Exact match
    if (contentLower === normalizedTarget) {
      return block;
    }

    // Heading match: strip leading # characters and compare
    const headingMatch = content.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const headingText = headingMatch[2].trim().toLowerCase();
      if (headingText === normalizedTarget) {
        return block;
      }
    }
  }

  // Then search all blocks (not just roots) for matches
  for (const block of Object.values(blocks)) {
    if (!block) continue;

    const content = block.content.trim();
    const contentLower = content.toLowerCase();

    // Exact match
    if (contentLower === normalizedTarget) {
      return block;
    }

    // Heading match
    const headingMatch = content.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const headingText = headingMatch[2].trim().toLowerCase();
      if (headingText === normalizedTarget) {
        return block;
      }
    }
  }

  return null;
}

/**
 * Create a new root block for the given target.
 * Creates it as a heading: "# Target"
 * Uses atomic createBlockAfterWithContent for single Yjs transaction.
 */
function createPageBlock(
  blockStore: BacklinkNavigationOptions['blockStore'],
  target: string
): string {
  // Find the last root block to append after
  const lastRootId = blockStore.rootIds[blockStore.rootIds.length - 1];

  if (lastRootId) {
    // Single atomic transaction: create block with content
    return blockStore.createBlockAfterWithContent(lastRootId, `# ${target}`);
  }

  // Fallback: if no roots exist, this shouldn't happen but handle gracefully
  return '';
}

/**
 * Navigate to a wikilink target.
 * - Finds existing block matching target, or creates one
 * - Zooms the pane to that block
 * - Sets focus to the block
 *
 * @param target - The wikilink target text (e.g., "My Page")
 * @param paneId - The pane to navigate within
 * @param options - Block and pane stores
 * @returns The block ID that was navigated to (or empty string on failure)
 */
export function navigateToWikilink(
  target: string,
  paneId: string,
  options: BacklinkNavigationOptions
): string {
  const { blockStore, paneStore } = options;

  // Find existing block
  let targetBlock = findBlockByTitle(blockStore.blocks, blockStore.rootIds, target);

  // Create new block if not found
  if (!targetBlock) {
    const newId = createPageBlock(blockStore, target);
    if (newId) {
      targetBlock = blockStore.blocks[newId];
    }
  }

  if (!targetBlock) {
    console.warn(`[BacklinkNavigation] Failed to find or create block for "${target}"`);
    return '';
  }

  // Zoom to the block
  paneStore.setZoomedRoot(paneId, targetBlock.id);
  paneStore.setFocusedBlockId(paneId, targetBlock.id);

  return targetBlock.id;
}

/**
 * Find all blocks that contain wikilinks pointing to the given target.
 * Used for rendering "Linked References" (backlinks).
 *
 * @param blocks - All blocks from the store
 * @param target - The page title to find references to
 * @returns Array of blocks containing links to the target
 */
export function findBacklinks(
  blocks: Record<string, Block>,
  target: string
): Block[] {
  // TODO: O(n) full scan - consider building reverse index for large documents
  // See https://github.com/float-file/floatty/issues/XXX for optimization tracking
  const normalizedTarget = target.trim().toLowerCase();
  const backlinks: Block[] = [];

  for (const block of Object.values(blocks)) {
    if (!block) continue;

    // Extract all wikilink targets from this block using shared pattern
    const matches = [...block.content.matchAll(WIKILINK_PATTERN)];

    for (const match of matches) {
      const linkTarget = match[1].trim().toLowerCase();
      if (linkTarget === normalizedTarget) {
        backlinks.push(block);
        break; // Only add the block once even if it has multiple links to target
      }
    }
  }

  return backlinks;
}

/**
 * Extract the title from a block (for backlink display).
 * Strips heading markers if present.
 */
export function getBlockTitle(block: Block): string {
  const content = block.content.trim();

  // Check for heading pattern
  const headingMatch = content.match(/^(#{1,6})\s+(.+)$/);
  if (headingMatch) {
    return headingMatch[2].trim();
  }

  return content;
}
