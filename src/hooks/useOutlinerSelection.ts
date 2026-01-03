/**
 * useOutlinerSelection - Multi-select state and operations for Outliner
 *
 * FLO-74: Click, Shift+Click, Cmd+Click multi-select
 * FLO-95: Progressive Cmd+A with collapsed subtree inclusion
 */

import { createSignal, createEffect } from 'solid-js';
import type { Accessor } from 'solid-js';
import { blocksToMarkdown } from '../lib/markdownExport';

interface UseOutlinerSelectionParams {
  blockStore: {
    blocks: Record<string, { content: string; parentId: string | null; childIds: string[] }>;
    rootIds: string[];
    deleteBlocks: (ids: string[]) => void;
  };
  paneStore: {
    setZoomedRoot: (paneId: string, blockId: string | null) => void;
  };
  paneId: string;
  focusedBlockId: Accessor<string | null>;
  setFocusedBlockId: (id: string | null) => void;
  zoomedRootId: Accessor<string | null>;
  getVisibleBlockIds: Accessor<string[]>;
  getAncestors: (blockId: string) => string[];
  findFocusAfterDelete: (blockId: string, paneId: string) => string | null;
}

export function useOutlinerSelection(params: UseOutlinerSelectionParams) {
  const {
    blockStore: store,
    paneStore,
    paneId,
    focusedBlockId,
    setFocusedBlockId,
    zoomedRootId,
    getVisibleBlockIds,
    getAncestors,
    findFocusAfterDelete,
  } = params;

  // Selection state
  const [selectedBlockIds, setSelectedBlockIds] = createSignal<Set<string>>(new Set());
  const [selectionAnchor, setSelectionAnchor] = createSignal<string | null>(null);

  // Cleanup deleted blocks from selection (prevents memory leak)
  createEffect(() => {
    const selected = selectedBlockIds();
    const anchor = selectionAnchor();

    // Filter out any block IDs that no longer exist
    const validIds = new Set<string>();
    for (const id of selected) {
      if (store.blocks[id]) {
        validIds.add(id);
      }
    }

    // Only update if we removed any invalid IDs
    if (validIds.size !== selected.size) {
      setSelectedBlockIds(validIds);
    }

    // Clear anchor if it no longer exists
    if (anchor && !store.blocks[anchor]) {
      setSelectionAnchor(null);
    }
  });

  // Selection handlers
  const handleSelect = (blockId: string, mode: 'set' | 'toggle' | 'range') => {
    if (mode === 'set') {
      // Clear selection, set anchor
      setSelectedBlockIds(new Set());
      setSelectionAnchor(blockId);
    } else if (mode === 'toggle') {
      // Toggle block in selection
      const current = new Set(selectedBlockIds());
      if (current.has(blockId)) {
        current.delete(blockId);
      } else {
        current.add(blockId);
      }
      setSelectedBlockIds(current);
      setSelectionAnchor(blockId);
    } else if (mode === 'range') {
      // Select range from anchor to blockId
      const anchor = selectionAnchor();
      if (!anchor) {
        setSelectedBlockIds(new Set([blockId]));
        setSelectionAnchor(blockId);
        return;
      }

      const visibleIds = getVisibleBlockIds();
      const anchorIdx = visibleIds.indexOf(anchor);
      const targetIdx = visibleIds.indexOf(blockId);

      if (anchorIdx === -1 || targetIdx === -1) {
        // Anchor or target not visible (collapsed/deleted) - reset to target
        setSelectedBlockIds(new Set([blockId]));
        setSelectionAnchor(blockId);
        return;
      }

      const [from, to] = anchorIdx < targetIdx ? [anchorIdx, targetIdx] : [targetIdx, anchorIdx];
      const rangeIds = visibleIds.slice(from, to + 1);
      setSelectedBlockIds(new Set(rangeIds));
    }
  };

  const clearSelection = () => {
    setSelectedBlockIds(new Set());
  };

  // FLO-95: Helper to get ALL descendants (ignores collapsed state)
  const getAllDescendantsOf = (blockId: string): string[] => {
    const block = store.blocks[blockId];
    if (!block) return [];

    const result: string[] = [];
    for (const childId of block.childIds) {
      if (store.blocks[childId]) {
        result.push(childId);
        result.push(...getAllDescendantsOf(childId));
      }
    }
    return result;
  };

  // FLO-95: Get block + ALL descendants (for selection that includes collapsed subtrees)
  const getBlockWithAllDescendants = (blockId: string): string[] => {
    if (!store.blocks[blockId]) return [];
    return [blockId, ...getAllDescendantsOf(blockId)];
  };

  // FLO-95: Get siblings with ALL their descendants (for selection level 1)
  const getSiblingsWithAllDescendants = (parentId: string): string[] => {
    const parent = store.blocks[parentId];
    if (!parent) return [];

    const result: string[] = [];
    for (const childId of parent.childIds) {
      if (store.blocks[childId]) {
        result.push(childId);
        result.push(...getAllDescendantsOf(childId));
      }
    }
    return result;
  };

  // FLO-95: Get ALL block IDs in tree order (for select-all that includes collapsed)
  const getAllBlockIds = (): string[] => {
    const result: string[] = [];
    const rootsToWalk = zoomedRootId() ? [zoomedRootId()!] : store.rootIds;

    const walk = (id: string) => {
      const block = store.blocks[id];
      if (!block) return;
      result.push(id);
      for (const childId of block.childIds) {
        walk(childId);
      }
    };

    for (const rootId of rootsToWalk) {
      walk(rootId);
    }
    return result;
  };

  // Progressive Cmd+A expansion by indent level
  // Level 0: focused block only
  // Level 1: siblings (same parent) + ALL their descendants
  // Level 2+: climb ancestor chain (parent scope, grandparent scope, etc.)
  const selectByIndentLevel = (level: number): string[] => {
    const focusedId = focusedBlockId();
    if (!focusedId) return getAllBlockIds();

    // Level 0: just focused block
    if (level === 0) {
      return [focusedId];
    }

    const ancestors = getAncestors(focusedId); // [rootId, ..., parentId, focusedId]

    // Level 1: siblings (same parent) + ALL descendants
    if (level === 1) {
      const parentId = store.blocks[focusedId]?.parentId;
      if (!parentId) {
        // Top-level block - siblings are other roots with all descendants
        const result: string[] = [];
        const roots = zoomedRootId() ? [zoomedRootId()!] : store.rootIds;
        for (const rootId of roots) {
          result.push(...getBlockWithAllDescendants(rootId));
        }
        return result;
      }
      return getSiblingsWithAllDescendants(parentId);
    }

    // Level 2+: climb ancestors
    // level=2 → parent, level=3 → grandparent, etc.
    const targetAncestorIdx = ancestors.length - level;

    if (targetAncestorIdx < 0) {
      // Climbed past root - select all (including collapsed)
      return getAllBlockIds();
    }

    const scopeId = ancestors[targetAncestorIdx];
    return getBlockWithAllDescendants(scopeId);
  };

  const copySelection = async () => {
    const selected = selectedBlockIds();
    if (selected.size === 0) {
      // Copy focused block if no selection
      const focused = focusedBlockId();
      if (focused) {
        const block = store.blocks[focused];
        if (block) {
          await navigator.clipboard.writeText(block.content);
        }
      }
      return;
    }

    // Use getAllBlockIds() for tree order - includes collapsed blocks (FLO-95)
    const markdown = blocksToMarkdown(selected, store.blocks, getAllBlockIds());
    await navigator.clipboard.writeText(markdown);
  };

  const deleteSelection = () => {
    const selected = selectedBlockIds();
    if (selected.size === 0) return;

    // Find focus target based on selection
    let focusTarget: string | null = null;
    const selectedArray = Array.from(selected);

    if (selectedArray.length === 1) {
      focusTarget = findFocusAfterDelete(selectedArray[0], paneId);
    } else {
      // Multi-select: find common ancestor
      const ancestorLists = selectedArray.map(id => getAncestors(id));
      let commonDepth = 0;
      const firstList = ancestorLists[0];

      if (firstList) {
        for (let i = 0; i < firstList.length; i++) {
          if (ancestorLists.every(list => list[i] === firstList[i])) {
            commonDepth = i + 1;
          } else {
            break;
          }
        }

        if (commonDepth > 0) {
          const commonAncestor = firstList[commonDepth - 1];
          // Only climb to parent if ancestor itself is being deleted
          if (selected.has(commonAncestor)) {
            focusTarget = findFocusAfterDelete(commonAncestor, paneId);
          } else {
            focusTarget = commonAncestor;
          }
        }
      }
    }

    // Delete all selected blocks atomically
    store.deleteBlocks([...selected]);
    clearSelection();

    // Edge case: if zoomed and zoomed root now has no children, unzoom
    const zoomedRoot = zoomedRootId();
    if (zoomedRoot) {
      const zoomedBlock = store.blocks[zoomedRoot];
      if (zoomedBlock && zoomedBlock.childIds.length === 0) {
        paneStore.setZoomedRoot(paneId, null);
        setFocusedBlockId(zoomedRoot);
        return;
      }
    }

    // Focus parent (or sibling fallback), or if all deleted, clear focus
    if (focusTarget) {
      setFocusedBlockId(focusTarget);
    } else {
      setFocusedBlockId(null);
    }
  };

  return {
    // State accessors
    selectedBlockIds,
    selectionAnchor,
    // Handlers
    handleSelect,
    clearSelection,
    selectByIndentLevel,
    copySelection,
    deleteSelection,
    // Helpers (exposed for testing/extension)
    getAllDescendantsOf,
    getBlockWithAllDescendants,
    getAllBlockIds,
  };
}
