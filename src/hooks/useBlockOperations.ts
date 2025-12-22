/**
 * useBlockOperations - High-level utilities for block manipulation
 * 
 * Provides:
 * - Keyboard shortcut handlers
 * - Tree traversal (find next/prev visible block)
 * - Move/Drag logic
 */

import { useBlockStore } from './useBlockStore';

export function useBlockOperations() {
  const store = useBlockStore();

  /**
   * Find the next visible block in the tree (for arrow key navigation)
   */
  const findNextVisibleBlock = (id: string): string | null => {
    const block = store.getBlock(id);
    if (!block) return null;

    // 1. If has children and not collapsed, go to first child
    if (block.childIds.length > 0 && !block.collapsed) {
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
      currentBlock = store.getBlock(parentId)!;
    }

    return null;
  };

  /**
   * Find the previous visible block in the tree
   */
  const findPrevVisibleBlock = (id: string): string | null => {
    const block = store.getBlock(id);
    if (!block) return null;

    const parentId = block.parentId;
    const siblings = parentId ? store.getBlock(parentId)?.childIds : store.rootIds;
    
    if (!siblings) return null;

    const index = siblings.indexOf(id);

    // 1. If has previous sibling, go to its last visible descendant
    if (index > 0) {
      let prevSiblingId = siblings[index - 1];
      let prevSibling = store.getBlock(prevSiblingId)!;

      while (prevSibling.childIds.length > 0 && !prevSibling.collapsed) {
        prevSiblingId = prevSibling.childIds[prevSibling.childIds.length - 1];
        prevSibling = store.getBlock(prevSiblingId)!;
      }
      return prevSiblingId;
    }

    // 2. If no previous sibling, go to parent
    return parentId;
  };

  return {
    ...store,
    findNextVisibleBlock,
    findPrevVisibleBlock,
  };
}
