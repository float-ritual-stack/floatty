/**
 * Pane Store - Manages pane-specific state (like collapsed blocks)
 * 
 * Separate from layout store to handle view state that isn't structural.
 */

import { createRoot } from 'solid-js';
import { createStore } from 'solid-js/store';

interface PaneState {
  // Map of paneId -> Set of collapsed block IDs
  // Since Sets aren't easily serializable/reactive in stores, we use an array or object
  // Using Record<paneId, Record<blockId, boolean>> for easy access
  collapsed: Record<string, Record<string, boolean>>;
  // Map of paneId -> zoomed root block ID (null = show all roots)
  zoomedRootId: Record<string, string | null>;
  // Map of paneId -> focused block ID (for preserving focus on split)
  focusedBlockId: Record<string, string | null>;
}

function createPaneStore() {
  const [state, setState] = createStore<PaneState>({
    collapsed: {},
    zoomedRootId: {},
    focusedBlockId: {},
  });

  const toggleCollapsed = (paneId: string, blockId: string) => {
    // Get current value first to ensure proper toggle
    const currentValue = isCollapsed(paneId, blockId, false);

    // Ensure the pane entry exists
    if (!state.collapsed[paneId]) {
      setState('collapsed', paneId, {});
    }

    // Set the new value explicitly (not toggling undefined)
    setState('collapsed', paneId, blockId, !currentValue);
  };

  const isCollapsed = (paneId: string, blockId: string, defaultCollapsed: boolean): boolean => {
    const paneState = state.collapsed[paneId];
    if (!paneState) return defaultCollapsed;
    
    const val = paneState[blockId];
    return val !== undefined ? val : defaultCollapsed;
  };

  const setCollapsed = (paneId: string, blockId: string, collapsed: boolean) => {
    if (!state.collapsed[paneId]) {
      setState('collapsed', paneId, {});
    }
    setState('collapsed', paneId, blockId, collapsed);
  };

  const getZoomedRootId = (paneId: string): string | null => {
    return state.zoomedRootId[paneId] ?? null;
  };

  const setZoomedRoot = (paneId: string, blockId: string | null) => {
    setState('zoomedRootId', paneId, blockId);
  };

  const getFocusedBlockId = (paneId: string): string | null => {
    return state.focusedBlockId[paneId] ?? null;
  };

  const setFocusedBlockId = (paneId: string, blockId: string | null) => {
    setState('focusedBlockId', paneId, blockId);
  };

  return {
    toggleCollapsed,
    isCollapsed,
    setCollapsed,
    getZoomedRootId,
    setZoomedRoot,
    getFocusedBlockId,
    setFocusedBlockId,
  };
}

export const paneStore = createRoot(createPaneStore);
