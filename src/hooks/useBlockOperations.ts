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
   * Check if a block is editable (has contentEditable)
   * Blocks with outputType (like daily-view) render custom views, not contentEditable
   */
  const isEditableBlock = (blockId: string): boolean => {
    const b = store.getBlock(blockId);
    if (!b) return false;
    // Output blocks (daily-view, daily-error, etc.) are not editable
    if (b.outputType) return false;
    return true;
  };

  /**
   * Check if a block is navigable (can receive focus via arrow keys)
   * Output blocks aren't editable but ARE navigable — they have outputFocusRef
   */
  const isNavigableBlock = (blockId: string): boolean => {
    const b = store.getBlock(blockId);
    return !!b;
  };

  /**
   * Find the next visible block in the tree (for arrow key navigation)
   * Respects zoom boundary - won't navigate outside zoomed subtree
   * Skips non-editable blocks (like daily output views)
   */
  const findNextVisibleBlock = (id: string, paneId: string): string | null => {
    const block = store.getBlock(id);
    if (!block) return null;

    // Get zoom boundary - stop climbing ancestors at this node
    const zoomedRootId = paneStore.getZoomedRootId(paneId);

    // Check pane-specific collapse state
    const isCollapsed = paneStore.isCollapsed(paneId, id, block.collapsed);

    // 1. If has children and not collapsed, go to first navigable child
    if (block.childIds.length > 0 && !isCollapsed) {
      const firstNavChild = block.childIds.find(isNavigableBlock);
      if (firstNavChild) return firstNavChild;
      // No navigable children - fall through to find next sibling
    }

    // 1b. SPECIAL CASE: At zoomed root with children (even if collapsed)
    // Zooming implies intent to navigate into children, so allow navigation
    // This is a safety net if collapse state gets out of sync with zoom
    if (id === zoomedRootId && block.childIds.length > 0) {
      const firstNavChild = block.childIds.find(isNavigableBlock);
      if (firstNavChild) return firstNavChild;
    }

    // 2. Otherwise, find next sibling or ancestor's next sibling
    // BUT stop at zoom boundary - don't climb above zoomed root
    let currentId = id;
    let currentBlock = block;

    while (currentId) {
      // Stop at zoom boundary BEFORE checking siblings
      // (zoomed root's siblings are outside the zoom view)
      if (currentId === zoomedRootId) break;

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
   * Respects zoom boundary - won't navigate above zoomed root
   * Skips non-editable blocks (like daily output views)
   */
  const findPrevVisibleBlock = (id: string, paneId: string): string | null => {
    const block = store.getBlock(id);
    if (!block) return null;

    // Get zoom boundary - don't navigate above this node
    const zoomedRootId = paneStore.getZoomedRootId(paneId);

    // At zoomed root already? Can't go up further
    if (id === zoomedRootId) return null;

    const parentId = block.parentId;
    const siblings = parentId ? store.getBlock(parentId)?.childIds : store.rootIds;

    if (!siblings) return null;

    const index = siblings.indexOf(id);

    // Helper to find last editable descendant (skipping output blocks)
    const findLastEditableDescendant = (startId: string): string | null => {
      let currentId = startId;
      let current = store.getBlock(currentId);
      if (!current) return null;

      // Check pane-specific collapse state
      let isCollapsed = paneStore.isCollapsed(paneId, currentId, current.collapsed);

      // Drill down to last visible descendant
      while (current.childIds.length > 0 && !isCollapsed) {
        currentId = current.childIds[current.childIds.length - 1];
        const next = store.getBlock(currentId);
        if (!next) break;
        current = next;
        isCollapsed = paneStore.isCollapsed(paneId, currentId, current.collapsed);
      }

      // If the descendant is navigable, return it
      if (isNavigableBlock(currentId)) return currentId;

      // Otherwise, recursively find previous from this position
      return findPrevVisibleBlock(currentId, paneId);
    };

    // 1. If has previous sibling, go to its last navigable descendant
    if (index > 0) {
      const prevSiblingId = siblings[index - 1];

      // Check if sibling itself is navigable
      if (isNavigableBlock(prevSiblingId)) {
        return findLastEditableDescendant(prevSiblingId);
      }

      // Sibling not navigable, keep looking
      return findPrevVisibleBlock(prevSiblingId, paneId);
    }

    // 2. If no previous sibling, go to parent (but not above zoom boundary)
    if (parentId === zoomedRootId) return zoomedRootId;  // Can navigate TO zoomed root
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

  /**
   * Find best focus target after deleting a block
   * Priority: prev sibling → next sibling → parent → zoomed root → null
   *
   * Rationale: Previous sibling maintains reading position (user stays in place).
   * Next sibling is fallback when deleting first child. Parent is last resort.
   */
  const findFocusAfterDelete = (blockId: string, paneId: string): string | null => {
    const block = store.getBlock(blockId);
    if (!block) return null;

    const zoomedRootId = paneStore.getZoomedRootId(paneId);

    const siblings = block.parentId
      ? store.getBlock(block.parentId)?.childIds
      : store.rootIds;

    if (siblings) {
      const idx = siblings.indexOf(blockId);
      // 1. Previous sibling (maintains reading position)
      if (idx > 0) return siblings[idx - 1];
      // 2. Next sibling
      if (idx !== -1 && idx < siblings.length - 1) return siblings[idx + 1];
    }

    // 3. Parent (fallback — not at or deleting zoomed root)
    if (block.parentId && blockId !== zoomedRootId) {
      return block.parentId;
    }

    // 4. Zoomed root
    if (zoomedRootId && zoomedRootId !== blockId) {
      return zoomedRootId;
    }

    // 5. Nothing to focus
    return null;
  };

  return {
    ...store,
    findNextVisibleBlock,
    findPrevVisibleBlock,
    getAncestors,
    findFocusAfterDelete,
  };
}
