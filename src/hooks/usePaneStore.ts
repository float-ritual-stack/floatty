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
}

function createPaneStore() {
  const [state, setState] = createStore<PaneState>({
    collapsed: {},
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

  return {
    toggleCollapsed,
    isCollapsed,
    setCollapsed,
  };
}

export const paneStore = createRoot(createPaneStore);
