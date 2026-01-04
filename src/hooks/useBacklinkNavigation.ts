/**
 * useBacklinkNavigation - Navigation logic for [[wikilinks]] and pages:: container
 *
 * Architecture: Pages live under a `pages::` container block
 * - Direct children of `pages::` are "pages"
 * - [[Page Name]] navigates to matching page (creates if missing)
 * - Case-insensitive matching
 *
 * Usage:
 *   const nav = useBacklinkNavigation();
 *   nav.navigateToPage('Target Page', paneId, openInNewSplit);
 *   // tabId is derived automatically from paneId
 */

import { blockStore } from './useBlockStore';
import { paneStore } from './usePaneStore';
import { layoutStore } from './useLayoutStore';
import { collectPaneIds } from '../lib/layoutTypes';
import type { Block } from '../lib/blockTypes';

const PAGES_PREFIX = 'pages::';

/**
 * Strip heading prefix (# ## ### etc) from a string.
 * Used for case-insensitive page matching.
 *
 * Examples:
 *   "# My Page" → "My Page"
 *   "### Deep" → "Deep"
 *   "No prefix" → "No prefix"
 */
function stripHeadingPrefix(content: string): string {
  return content.replace(/^#+\s*/, '');
}

/**
 * Find the tabId that contains a given paneId.
 * Searches all layouts in layoutStore.
 * Returns null if pane not found in any tab.
 */
export function findTabIdByPaneId(paneId: string): string | null {
  const layouts = layoutStore.layouts;

  for (const [tabId, layout] of Object.entries(layouts)) {
    const paneIds = collectPaneIds(layout.root);
    if (paneIds.includes(paneId)) {
      return tabId;
    }
  }

  return null;
}

/**
 * Find the pages:: container block.
 * Searches root-level blocks for one starting with "pages::"
 */
export function findPagesContainer(): Block | null {
  const { blocks, rootIds } = blockStore;

  for (const rootId of rootIds) {
    const block = blocks[rootId];
    if (block && block.content.toLowerCase().startsWith(PAGES_PREFIX.toLowerCase())) {
      return block;
    }
  }

  return null;
}

/**
 * Find a page by name within the pages:: container.
 * Case-insensitive comparison on page title (block content).
 * Heading prefixes (# ## ###) are stripped before comparison.
 *
 * @param pageName - The page name to search for
 * @returns The matching page block, or null if not found
 */
export function findPage(pageName: string): Block | null {
  const pagesContainer = findPagesContainer();
  if (!pagesContainer) return null;

  const normalizedName = stripHeadingPrefix(pageName.trim()).toLowerCase();
  const { blocks } = blockStore;

  for (const childId of pagesContainer.childIds) {
    const child = blocks[childId];
    if (child) {
      const childName = stripHeadingPrefix(child.content.trim()).toLowerCase();
      if (childName === normalizedName) {
        return child;
      }
    }
  }

  return null;
}

/**
 * Extract all wikilink targets from content, including nested ones.
 * Uses bracket counting for proper nesting support.
 *
 * For `[[outer [[inner]]]]`, returns: ["outer [[inner]]", "inner"]
 * This enables backlinks to both the outer and inner targets.
 */
function extractAllWikilinkTargets(content: string): string[] {
  const targets: string[] = [];

  // Find all top-level wikilinks using bracket counting
  let i = 0;
  while (i < content.length - 1) {
    const openIdx = content.indexOf('[[', i);
    if (openIdx === -1) break;

    // Find matching close with bracket counting
    let depth = 0;
    let j = openIdx;
    let endIdx = -1;

    while (j < content.length - 1) {
      const twoChars = content.slice(j, j + 2);
      if (twoChars === '[[') {
        depth++;
        j += 2;
      } else if (twoChars === ']]') {
        depth--;
        j += 2;
        if (depth === 0) {
          endIdx = j;
          break;
        }
      } else {
        j++;
      }
    }

    if (endIdx === -1) {
      // Unbalanced - skip this [[
      i = openIdx + 2;
      continue;
    }

    // Extract inner content (strip outer [[ ]])
    const inner = content.slice(openIdx + 2, endIdx - 2);

    // Parse for alias (top-level pipe only)
    let target = inner;
    let pipeDepth = 0;
    for (let k = 0; k < inner.length - 1; k++) {
      const tc = inner.slice(k, k + 2);
      if (tc === '[[') {
        pipeDepth++;
        k++;
      } else if (tc === ']]') {
        pipeDepth--;
        k++;
      } else if (inner[k] === '|' && pipeDepth === 0) {
        target = inner.slice(0, k);
        break;
      }
    }

    if (target.trim()) {
      targets.push(target.trim());

      // Recursively extract from the target (for nested wikilinks)
      const nestedTargets = extractAllWikilinkTargets(target);
      targets.push(...nestedTargets);
    }

    i = endIdx;
  }

  return targets;
}

/**
 * Get all backlinks (blocks that reference a page via [[wikilink]]).
 * Used for LinkedReferences display.
 *
 * Supports nested wikilinks: `[[outer [[inner]]]]` creates backlinks
 * to both "outer [[inner]]" and "inner".
 *
 * @param pageName - The page name to find references to (may include heading prefix)
 * @returns Array of blocks that contain [[pageName]] (case-insensitive)
 */
export function findBacklinks(pageName: string): Block[] {
  const { blocks } = blockStore;
  // Strip heading prefix since links use bare names like [[My Page]]
  const normalizedName = stripHeadingPrefix(pageName.trim()).toLowerCase();

  const backlinks: Block[] = [];

  for (const block of Object.values(blocks)) {
    // Skip the page itself (we don't want self-references)
    const blockName = stripHeadingPrefix(block.content.trim()).toLowerCase();
    if (blockName === normalizedName) continue;

    // Extract all wikilink targets (including nested)
    const targets = extractAllWikilinkTargets(block.content);

    // Check if any target matches the page we're looking for
    for (const target of targets) {
      if (target.toLowerCase() === normalizedName) {
        backlinks.push(block);
        break; // Only add each block once
      }
    }
  }

  return backlinks;
}

/**
 * Create the pages:: container block if it doesn't exist.
 * Returns the existing or newly created container.
 */
function ensurePagesContainer(): string {
  const existing = findPagesContainer();
  if (existing) return existing.id;

  // Create at root level via blockStore methods (Y.Doc transactions internally)
  const { rootIds } = blockStore;

  let containerId: string;
  if (rootIds.length > 0) {
    // Create after last root block
    containerId = blockStore.createBlockAfter(rootIds[rootIds.length - 1]);
  } else {
    // Empty workspace - create initial block
    containerId = blockStore.createInitialBlock();
  }

  if (containerId) {
    blockStore.updateBlockContent(containerId, PAGES_PREFIX);
  }

  return containerId;
}

/**
 * Create a new page under the pages:: container.
 * Page content is prefixed with `# ` so it renders as a heading when zoomed.
 *
 * @param pageName - The page title (becomes block content with `# ` prefix)
 * @returns The ID of the newly created page block
 */
function createPage(pageName: string): string {
  const containerId = ensurePagesContainer();

  // Create as child of pages:: container
  const pageId = blockStore.createBlockInside(containerId);
  if (pageId) {
    // Add heading prefix for visual styling when zoomed
    const pageContent = `# ${pageName}`;
    blockStore.updateBlockContent(pageId, pageContent);
  }

  return pageId;
}

export interface NavigationResult {
  success: boolean;
  pageId: string | null;
  /** ID of the block to focus (first child of page, created if needed) */
  focusTargetId: string | null;
  created: boolean;
  error?: string;
}

/** Split direction for page navigation */
export type SplitDirection = 'none' | 'horizontal' | 'vertical';

/**
 * Navigate to a page by name.
 *
 * - If page exists under pages::, zoom to it
 * - If page doesn't exist, create it under pages:: then zoom
 * - If pages:: doesn't exist, create it first
 * - splitDirection controls pane behavior:
 *   - 'none': navigate in current pane
 *   - 'horizontal': split side-by-side (Cmd+Click)
 *   - 'vertical': split above/below (Cmd+Shift+Click)
 *
 * @param pageName - The target page name
 * @param paneId - The current pane ID (tabId derived automatically)
 * @param splitDirection - How to split the pane (default: 'none')
 */
export function navigateToPage(
  pageName: string,
  paneId: string,
  splitDirection: SplitDirection = 'none'
): NavigationResult {
  console.log('[navigateToPage] Called:', { pageName, paneId, splitDirection });

  // Normalize page name
  const normalizedName = pageName.trim();
  if (!normalizedName) {
    return { success: false, pageId: null, created: false, error: 'Empty page name' };
  }

  // Find or create the page
  let page = findPage(normalizedName);
  const created = !page;

  if (!page) {
    const pageId = createPage(normalizedName);
    if (!pageId) {
      return { success: false, pageId: null, created: false, error: 'Failed to create page' };
    }
    page = blockStore.getBlock(pageId);
    if (!page) {
      return { success: false, pageId: null, created: false, error: 'Created page not found' };
    }
  }

  // Determine target pane
  let targetPaneId = paneId;

  if (splitDirection !== 'none') {
    // Derive tabId from paneId for split operation
    const tabId = findTabIdByPaneId(paneId);
    if (!tabId) {
      console.warn('[BacklinkNavigation] Could not find tabId for pane, using current pane');
    } else {
      // Split in requested direction
      const newPaneId = layoutStore.splitPane(tabId, splitDirection, 'outliner');
      if (newPaneId) {
        targetPaneId = newPaneId;
      } else {
        console.warn('[BacklinkNavigation] Split failed, using current pane');
      }
    }
  }

  // Zoom to the page
  paneStore.setZoomedRoot(targetPaneId, page.id);

  // Determine focus target: first child (create if needed)
  let focusTargetId: string | null = null;

  // Re-fetch page to get updated childIds (in case we just created it)
  const currentPage = blockStore.getBlock(page.id);
  if (currentPage) {
    if (currentPage.childIds.length > 0) {
      // Focus first child
      focusTargetId = currentPage.childIds[0];
    } else {
      // Create empty child for typing
      focusTargetId = blockStore.createBlockInside(page.id);
    }
  }

  return {
    success: true,
    pageId: page.id,
    focusTargetId,
    created,
  };
}

/**
 * Hook-style export for use in components.
 * Returns navigation functions bound to the stores.
 */
export function useBacklinkNavigation() {
  return {
    findPagesContainer,
    findPage,
    findBacklinks,
    navigateToPage,
  };
}
