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
}

function createPaneStore() {
  const [state, setState] = createStore<PaneState>({
    collapsed: {},
    zoomedRootId: {},
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

  /**
   * Clean up state for a deleted pane (prevents memory leak)
   * Should be called when a pane is closed to remove orphaned view state
   */
  const removePane = (paneId: string) => {
    // Clean up collapsed state
    if (state.collapsed[paneId]) {
      setState('collapsed', paneId, undefined!);
    }
    // Clean up zoomed state
    if (state.zoomedRootId[paneId] !== undefined) {
      setState('zoomedRootId', paneId, undefined!);
    }
  };

  /**
   * Clean up state for all panes in a tab (when tab closes)
   */
  const removePanes = (paneIds: string[]) => {
    for (const paneId of paneIds) {
      removePane(paneId);
    }
  };

  /**
   * Hydrate pane state from persisted data
   */
  const hydratePaneState = (
    restoredZoomedRootIds: Record<string, string | null>,
    restoredCollapsed?: Record<string, Record<string, boolean>>
  ) => {
    // Validate zoomedRootIds structure
    if (typeof restoredZoomedRootIds !== 'object' || restoredZoomedRootIds === null) {
      console.warn('[PaneStore] Invalid zoomedRootIds structure, skipping hydration');
      return;
    }

    setState('zoomedRootId', restoredZoomedRootIds);

    if (restoredCollapsed) {
      // Validate collapsed structure
      if (typeof restoredCollapsed !== 'object' || restoredCollapsed === null) {
        console.warn('[PaneStore] Invalid collapsed structure, skipping');
        return;
      }
      setState('collapsed', restoredCollapsed);
    }
  };

  /**
   * Get pane state for persistence
   * Deep clones to avoid SolidJS proxy leakage
   */
  const getPaneStateForPersistence = (): {
    zoomedRootId: Record<string, string | null>;
    collapsed: Record<string, Record<string, boolean>>;
  } => {
    return {
      zoomedRootId: { ...state.zoomedRootId },
      // Deep clone nested structure to strip SolidJS proxies
      collapsed: JSON.parse(JSON.stringify(state.collapsed)),
    };
  };

  return {
    toggleCollapsed,
    isCollapsed,
    setCollapsed,
    getZoomedRootId,
    setZoomedRoot,
    removePane,
    removePanes,
    // Persistence
    hydratePaneState,
    getPaneStateForPersistence,
  };
}

export const paneStore = createRoot(createPaneStore);
