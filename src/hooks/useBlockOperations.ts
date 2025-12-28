/**
 * useBlockOperations - High-level utilities for block manipulation
 * 
 * Provides:
 * - Keyboard shortcut handlers
 * - Tree traversal (find next/prev visible block)
 * - Move/Drag logic
 */

import { useWorkspace } from '../context/WorkspaceContext';

export function useBlockOperations() {
  const { blockStore, paneStore } = useWorkspace();
  const store = blockStore;

  /**
   * Find the next visible block in the tree (for arrow key navigation)
   */
  const findNextVisibleBlock = (id: string, paneId: string): string | null => {
    const block = store.getBlock(id);
    if (!block) return null;

    // Check pane-specific collapse state
    const isCollapsed = paneStore.isCollapsed(paneId, id, block.collapsed);

    // 1. If has children and not collapsed, go to first child
    if (block.childIds.length > 0 && !isCollapsed) {
      return block.childIds[0];
    }

    // 2. Otherwise, find next sibling or ancestor's next sibling
    let currentId = id;
    let currentBlock = block;

    while (currentId) {
      const parentId = currentBlock.parentId;
      const siblings = parentId ? store.getBlock(parentId)?.childIds : store.rootIds;
      
      if (siblings) {
        const index = siblings.indexOf(currentId);
        if (index < siblings.length - 1) {
          return siblings[index + 1];
        }
      }

      if (!parentId) break;
      currentId = parentId;
      const parent = store.getBlock(parentId);
      if (!parent) break;
      currentBlock = parent;
    }

    return null;
  };

  /**
   * Find the previous visible block in the tree
   */
  const findPrevVisibleBlock = (id: string, paneId: string): string | null => {
    const block = store.getBlock(id);
    if (!block) return null;

    const parentId = block.parentId;
    const siblings = parentId ? store.getBlock(parentId)?.childIds : store.rootIds;
    
    if (!siblings) return null;

    const index = siblings.indexOf(id);

    // 1. If has previous sibling, go to its last visible descendant
    if (index > 0) {
      let prevSiblingId = siblings[index - 1];
      let prevSibling = store.getBlock(prevSiblingId);
      if (!prevSibling) return null;

      // Check pane-specific collapse state
      let isPrevCollapsed = paneStore.isCollapsed(paneId, prevSiblingId, prevSibling.collapsed);

      while (prevSibling.childIds.length > 0 && !isPrevCollapsed) {
        prevSiblingId = prevSibling.childIds[prevSibling.childIds.length - 1];
        const nextSibling = store.getBlock(prevSiblingId);
        if (!nextSibling) break;
        prevSibling = nextSibling;
        isPrevCollapsed = paneStore.isCollapsed(paneId, prevSiblingId, prevSibling.collapsed);
      }
      return prevSiblingId;
    }

    // 2. If no previous sibling, go to parent
    return parentId;
  };

  /**
   * Get ancestor chain from root to block (inclusive)
   * Returns [rootId, ..., parentId, blockId]
   */
  const getAncestors = (blockId: string): string[] => {
    const result: string[] = [];
    let currentId: string | null = blockId;

    while (currentId) {
      result.unshift(currentId);
      const block = store.getBlock(currentId);
      if (!block) break;
      currentId = block.parentId ?? null;
    }

    return result;
  };

  return {
    ...store,
    findNextVisibleBlock,
    findPrevVisibleBlock,
    getAncestors,
  };
}
