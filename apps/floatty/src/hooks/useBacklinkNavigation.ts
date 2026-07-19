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
import { layoutStore, findTabIdByPaneId } from './useLayoutStore';
import { extractAllWikilinkTargets } from '../lib/wikilinkUtils';
import type { Block } from '../lib/blockTypes';
import { createLogger } from '../lib/logger';

const logger = createLogger('BacklinkNavigation');

const PAGES_PREFIX = 'pages::';

// getPageTitle moved to lib/pageTitle.ts (leaf module — no store imports)
// so useSyncedYDoc's twin reconcile can share it without an import cycle.
// Imported (not just re-exported: `export ... from` doesn't bind locally
// and this module uses it) and re-exported to keep existing importers
// working; full doc + parity contract live at the definition.
import { getPageTitle } from '../lib/pageTitle';
export { getPageTitle };

/**
 * Find a root-level container block whose trimmed content exactly matches
 * the given prefix (e.g., `pages::`, `pinned::`). Returns null if no such
 * container exists.
 *
 * Shared helper — callers should use this rather than iterating
 * `blockStore.rootIds` + `blockStore.blocks` inline.
 */
export function findRootBlockByPrefix(prefix: string): Block | null {
  const { blocks, rootIds } = blockStore;

  for (const rootId of rootIds) {
    const block = blocks[rootId];
    if (block && block.content.trim() === prefix) {
      return block;
    }
  }

  return null;
}

/**
 * Find the pages:: container block.
 * Searches root-level blocks for one starting with "pages::"
 */
export function findPagesContainer(): Block | null {
  return findRootBlockByPrefix(PAGES_PREFIX);
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

  const normalizedName = getPageTitle(pageName.trim()).toLowerCase();
  const { blocks } = blockStore;

  // Collision contract (matches the server PageNameIndex tie-break): when
  // duplicate pages share a name, the OLDEST block by createdAt wins — not
  // childIds position. First-match diverged from the server's resolution, so
  // the two sides could route the same [[wikilink]] to different twins
  // (quirk-audit 2026-07-09, cluster F "split-brain resolution").
  let oldest: Block | null = null;
  for (const childId of pagesContainer.childIds) {
    const child = blocks[childId];
    if (child) {
      const childName = getPageTitle(child.content.trim()).toLowerCase();
      if (childName === normalizedName) {
        if (!oldest || (child.createdAt ?? Infinity) < (oldest.createdAt ?? Infinity)) {
          oldest = child;
        }
      }
    }
  }

  return oldest;
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
  const normalizedName = getPageTitle(pageName.trim()).toLowerCase();

  const backlinks: Block[] = [];

  for (const block of Object.values(blocks)) {
    // Fast path: a block with no '[[' can never be a backlink. At
    // measurement time (2026-06-12) only ~3k of ~25.7k blocks carried
    // outlinks, so this gate skips the page-title normalization and
    // bracket-counting parse for the overwhelming majority. This memo
    // re-runs on any block change while a page is zoomed — per-block
    // cost is what keeps the main thread responsive.
    if (!block.content.includes('[[')) continue;

    // Skip the page itself (we don't want self-references)
    const blockName = getPageTitle(block.content.trim()).toLowerCase();
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

/**
 * Find-or-create a page under `pages::`, returning the page BLOCK.
 *
 * The find-or-create half of `navigateToPage` without the navigation side
 * effects (no zoom, no empty focus-child creation). Used by the multi-segment
 * path-click mkdir-p scaffold (ADR-008 Decision 3) to materialize a missing
 * segment-1 page before creating the tail under it — the same `createPage`
 * single-segment clicks use, so a date-shaped name (`2026-07-20`) lands a page
 * that `findPage` / the daily-note resolver later match by title.
 *
 * ID-threading (ADR-008 doctrine): on the create branch the block is returned
 * via `getBlock(createPage(...))` — the id `createPage` HANDS BACK — never a
 * `findPage(name)` re-resolve after the write. The pre-create `findPage` is the
 * idempotency guard (existing page wins, oldest-createdAt), not a post-write
 * lookup.
 */
export function ensurePage(pageName: string): Block | null {
  const existing = findPage(pageName);
  if (existing) return existing;
  const pageId = createPage(pageName);
  return pageId ? blockStore.getBlock(pageId) ?? null : null;
}

export interface NavigationResult {
  success: boolean;
  pageId: string | null;
  /** ID of the block to focus (first child of page, created if needed) */
  focusTargetId: string | null;
  /** The pane where navigation occurred (new pane if split, else source pane) */
  targetPaneId: string | null;
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
 * - ephemeral (FLO-136): if true, pane is preview-only until pinned
 *
 * @param pageName - The target page name
 * @param paneId - The current pane ID (tabId derived automatically)
 * @param splitDirection - How to split the pane (default: 'none')
 * @param ephemeral - Create ephemeral/preview pane (default: false)
 * @param options.originBlockId - FLO-211: Block where navigation started (for focus restoration)
 */
export function navigateToPage(
  pageName: string,
  paneId: string,
  splitDirection: SplitDirection = 'none',
  ephemeral: boolean = false,
  options?: { originBlockId?: string }
): NavigationResult {
  // Normalize page name
  const normalizedName = pageName.trim();
  if (!normalizedName) {
    return { success: false, pageId: null, focusTargetId: null, targetPaneId: null, created: false, error: 'Empty page name' };
  }

  // Find or create the page
  let page = findPage(normalizedName);
  const created = !page;

  if (!page) {
    const pageId = createPage(normalizedName);
    if (!pageId) {
      return { success: false, pageId: null, focusTargetId: null, targetPaneId: null, created: false, error: 'Failed to create page' };
    }
    page = blockStore.getBlock(pageId);
    if (!page) {
      return { success: false, pageId: null, focusTargetId: null, targetPaneId: null, created: false, error: 'Created page not found' };
    }
  }

  // Determine target pane
  let targetPaneId = paneId;

  if (splitDirection !== 'none') {
    // Derive tabId from paneId for split operation.
    // FLO-668 null contract: null → sidebar/floating or deleted pane; no tab
    // to split within, fall back to current pane without splitting.
    const tabId = findTabIdByPaneId(paneId);
    if (!tabId) {
      logger.warn('Could not find tabId for pane, using current pane');
    } else {
      // Split in requested direction (FLO-136: pass ephemeral flag)
      const newPaneId = layoutStore.splitPane(tabId, splitDirection, 'outliner', ephemeral);
      if (newPaneId) {
        targetPaneId = newPaneId;
      } else {
        logger.warn('Split failed, using current pane');
      }
    }
  }

  // FLO-211: Use unified zoomTo API for consistent history behavior
  // New split panes get skipHistory (empty history by design)
  // Pass originBlockId for focus restoration on back navigation
  paneStore.zoomTo(targetPaneId, page.id, {
    skipHistory: splitDirection !== 'none',
    originBlockId: options?.originBlockId,
  });

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
    targetPaneId,
    created,
  };
}

