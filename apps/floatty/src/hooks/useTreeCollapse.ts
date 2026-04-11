/**
 * useTreeCollapse - Progressive expand/collapse operations for Outliner
 *
 * FLO-66: ⌘E / ⌘⇧E progressive expand/collapse
 * Uses "set to depth" model - each level sets the view state, not incremental
 */

import { batch, type Accessor } from 'solid-js';
import { countDescendantsToDepth } from '../lib/expansionPolicy';

interface UseTreeCollapseParams {
  blockStore: {
    blocks: Record<string, { childIds: string[] }>;
    rootIds: string[];
  };
  paneStore: {
    setCollapsed: (paneId: string, blockId: string, collapsed: boolean) => void;
  };
  paneId: string;
  zoomedRootId: Accessor<string | null>;
  focusedBlockId: Accessor<string | null>;
  setFocusedBlockId: (id: string | null) => void;
  getVisibleBlockIds: Accessor<string[]>;
  getAncestors: (blockId: string) => string[];
  getContainerRef: () => HTMLDivElement | undefined;
}

export function useTreeCollapse(params: UseTreeCollapseParams) {
  const {
    blockStore: store,
    paneStore,
    paneId,
    zoomedRootId,
    focusedBlockId,
    setFocusedBlockId,
    getVisibleBlockIds,
    getAncestors,
    getContainerRef,
  } = params;

  // Get max depth from a scope root (used for "collapse all")
  const getMaxDepthFrom = (rootId: string | null): number => {
    let maxDepth = 0;
    const roots = rootId ? [rootId] : (zoomedRootId() ? [zoomedRootId()!] : store.rootIds);

    const walk = (id: string, depth: number) => {
      const block = store.blocks[id];
      if (!block) return;
      if (block.childIds.length > 0) {
        maxDepth = Math.max(maxDepth, depth);
        for (const childId of block.childIds) {
          walk(childId, depth + 1);
        }
      }
    };

    for (const id of roots) {
      walk(id, 1);
    }
    return maxDepth;
  };

  /**
   * Expand blocks to a certain depth (collapse deeper, expand shallower)
   * depth=1 means show only direct children
   * depth=2 means grandchildren visible
   * depth=Infinity means expand all
   */
  const expandToDepth = (scopeRootId: string | null, depth: number) => {
    const roots = scopeRootId ? [scopeRootId] : (zoomedRootId() ? [zoomedRootId()!] : store.rootIds);

    // Size cap: if expanding beyond depth 1 would reveal too many blocks, fall back to depth 1
    let effectiveDepth = depth;
    if (depth > 1) {
      const blockStoreView = { blocks: store.blocks, rootIds: store.rootIds };
      for (const rootId of roots) {
        const count = countDescendantsToDepth(rootId, depth, blockStoreView);
        if (count === 'over_cap') {
          effectiveDepth = 1;
          break;
        }
      }
    }

    const walk = (id: string, currentDepth: number) => {
      const block = store.blocks[id];
      if (!block || block.childIds.length === 0) return;

      const shouldCollapse = currentDepth > effectiveDepth;
      paneStore.setCollapsed(paneId, id, shouldCollapse);

      for (const childId of block.childIds) {
        walk(childId, currentDepth + 1);
      }
    };

    batch(() => {
      for (const rootId of roots) {
        walk(rootId, 1);
      }
    });
  };

  /**
   * Collapse blocks at and below a certain depth
   * depth=1 means collapse all level-1 nodes
   * depth=2 means collapse level-2, etc.
   */
  const collapseToDepth = (scopeRootId: string | null, depth: number) => {
    const roots = scopeRootId ? [scopeRootId] : (zoomedRootId() ? [zoomedRootId()!] : store.rootIds);

    const walk = (id: string, currentDepth: number) => {
      const block = store.blocks[id];
      if (!block || block.childIds.length === 0) return;

      const shouldCollapse = currentDepth >= depth;
      paneStore.setCollapsed(paneId, id, shouldCollapse);

      for (const childId of block.childIds) {
        walk(childId, currentDepth + 1);
      }
    };

    batch(() => {
      for (const rootId of roots) {
        walk(rootId, 1);
      }
    });
  };

  /**
   * FLO-211: Expand all ancestors of a block to make it visible.
   * Used to restore focus to a previously-visible block after back/forward navigation.
   */
  const expandAncestors = (blockId: string, maxLevels: number = 10) => {
    const ancestors = getAncestors(blockId);
    const capped = ancestors.slice(0, maxLevels);
    batch(() => {
      for (const ancestorId of capped) {
        paneStore.setCollapsed(paneId, ancestorId, false);
      }
    });
  };

  /**
   * After expand/collapse, ensure focus is on a visible block
   * If current focused block is hidden, find nearest visible ancestor
   */
  const ensureVisibleFocus = () => {
    const currentFocused = focusedBlockId();
    const visibleIds = getVisibleBlockIds();
    const visibleSet = new Set(visibleIds);
    const containerRef = getContainerRef();

    // If current focus is visible, keep it
    if (currentFocused && visibleSet.has(currentFocused)) {
      // Just refocus the DOM element
      requestAnimationFrame(() => {
        const el = containerRef?.querySelector(`[data-block-id="${currentFocused}"] [contenteditable]`) as HTMLElement;
        el?.focus();
      });
      return;
    }

    // Current focus is hidden - find nearest visible ancestor
    if (currentFocused) {
      const ancestors = getAncestors(currentFocused);
      for (let i = ancestors.length - 1; i >= 0; i--) {
        if (visibleSet.has(ancestors[i])) {
          setFocusedBlockId(ancestors[i]);
          return;
        }
      }
    }

    // Fallback: focus first visible block
    const firstVisible = visibleIds[0];
    if (firstVisible) {
      setFocusedBlockId(firstVisible);
    }
  };

  return {
    getMaxDepthFrom,
    expandToDepth,
    collapseToDepth,
    ensureVisibleFocus,
    expandAncestors,  // FLO-211: Used for focus restoration after back/forward
  };
}
