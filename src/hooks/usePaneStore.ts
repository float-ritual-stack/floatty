/**
 * Pane Store - Manages pane-specific state (like collapsed blocks)
 *
 * Separate from layout store to handle view state that isn't structural.
 *
 * FLO-180: Added navigation history (back/forward) per pane.
 */

import { createRoot } from 'solid-js';
import { createStore } from 'solid-js/store';
import {
  createNavigationState,
  pushNavigation as pushNavigationPure,
  goBack as goBackPure,
  goForward as goForwardPure,
  canGoBack as canGoBackPure,
  canGoForward as canGoForwardPure,
  DEFAULT_MAX_HISTORY_SIZE,
  type NavigationState,
  type NavigationEntry,
} from '../lib/navigationHistory';

// Re-export types for consumers
export type { NavigationState, NavigationEntry };

interface PaneState {
  // Map of paneId -> Set of collapsed block IDs
  // Since Sets aren't easily serializable/reactive in stores, we use an array or object
  // Using Record<paneId, Record<blockId, boolean>> for easy access
  collapsed: Record<string, Record<string, boolean>>;
  // Map of paneId -> zoomed root block ID (null = show all roots)
  zoomedRootId: Record<string, string | null>;
  // FLO-77: Map of paneId -> focused block ID (for clone-on-split)
  focusedBlockId: Record<string, string | null>;
  // FLO-180: Map of paneId -> navigation history (back/forward)
  navigationHistory: Record<string, NavigationState>;
}

function createPaneStore() {
  const [state, setState] = createStore<PaneState>({
    collapsed: {},
    zoomedRootId: {},
    focusedBlockId: {},
    navigationHistory: {},
  });

  const toggleCollapsed = (paneId: string, blockId: string, blockDefaultCollapsed: boolean = false) => {
    // Get current value first to ensure proper toggle
    // Must pass the block's own collapsed state as default to match display logic
    const currentValue = isCollapsed(paneId, blockId, blockDefaultCollapsed);
    const newValue = !currentValue;

    // Set in a single operation to avoid SolidJS store batching issues
    // If pane entry doesn't exist, create it WITH the blockId value in one shot
    if (!state.collapsed[paneId]) {
      setState('collapsed', paneId, { [blockId]: newValue });
    } else {
      setState('collapsed', paneId, blockId, newValue);
    }
  };

  const isCollapsed = (paneId: string, blockId: string, defaultCollapsed: boolean): boolean => {
    const paneState = state.collapsed[paneId];
    if (!paneState) {
      return defaultCollapsed;
    }

    const val = paneState[blockId];
    return val !== undefined ? val : defaultCollapsed;
  };

  const setCollapsed = (paneId: string, blockId: string, collapsed: boolean) => {
    // Set in a single operation to avoid SolidJS store batching issues
    if (!state.collapsed[paneId]) {
      setState('collapsed', paneId, { [blockId]: collapsed });
    } else {
      setState('collapsed', paneId, blockId, collapsed);
    }
  };

  const getZoomedRootId = (paneId: string): string | null => {
    return state.zoomedRootId[paneId] ?? null;
  };

  const setZoomedRoot = (paneId: string, blockId: string | null) => {
    setState('zoomedRootId', paneId, blockId);
  };

  // FLO-77: Focused block tracking for clone-on-split
  const getFocusedBlockId = (paneId: string): string | null => {
    return state.focusedBlockId[paneId] ?? null;
  };

  const setFocusedBlockId = (paneId: string, blockId: string | null) => {
    setState('focusedBlockId', paneId, blockId);
  };

  // ═══════════════════════════════════════════════════════════════
  // FLO-180: Navigation History (Back/Forward)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Get navigation history state for a pane (creates if missing)
   */
  const getNavigationHistory = (paneId: string): NavigationState => {
    return state.navigationHistory[paneId] ?? createNavigationState();
  };

  /**
   * Push current location to history (call BEFORE navigating away)
   *
   * @param paneId - The pane to push history for
   * @param zoomedRootId - Current zoom location (null = roots view)
   * @param focusedBlockId - Optional focused block for better restoration
   */
  const pushNavigation = (
    paneId: string,
    zoomedRootId: string | null,
    focusedBlockId?: string
  ) => {
    const currentState = getNavigationHistory(paneId);
    const entry: NavigationEntry = {
      zoomedRootId,
      focusedBlockId,
      timestamp: Date.now(),
    };

    const newState = pushNavigationPure(currentState, entry, DEFAULT_MAX_HISTORY_SIZE);
    setState('navigationHistory', paneId, newState);
  };

  /**
   * Go back in history (restores previous location)
   *
   * @param paneId - The pane to navigate
   * @param blockExists - Function to check if a block still exists (for skip logic)
   * @returns The restored entry, or null if at start of history
   */
  const goBack = (
    paneId: string,
    blockExists: (blockId: string) => boolean
  ): NavigationEntry | null => {
    let currentState = getNavigationHistory(paneId);

    // Keep going back until we find a valid entry or exhaust history
    let result = goBackPure(currentState);
    while (result.entry) {
      // null zoomedRootId (roots view) is always valid
      // Otherwise, check if block still exists
      if (
        result.entry.zoomedRootId === null ||
        blockExists(result.entry.zoomedRootId)
      ) {
        // Valid entry found - update state and zoom
        setState('navigationHistory', paneId, result.state);
        setZoomedRoot(paneId, result.entry.zoomedRootId);

        // Restore focused block if it exists
        if (result.entry.focusedBlockId && blockExists(result.entry.focusedBlockId)) {
          setFocusedBlockId(paneId, result.entry.focusedBlockId);
        }

        return result.entry;
      }

      // Block was deleted - skip this entry and try next
      currentState = result.state;
      result = goBackPure(currentState);
    }

    // Exhausted history without finding valid entry
    setState('navigationHistory', paneId, result.state);
    return null;
  };

  /**
   * Go forward in history (restores next location)
   *
   * @param paneId - The pane to navigate
   * @param blockExists - Function to check if a block still exists (for skip logic)
   * @returns The restored entry, or null if at end of history
   */
  const goForward = (
    paneId: string,
    blockExists: (blockId: string) => boolean
  ): NavigationEntry | null => {
    let currentState = getNavigationHistory(paneId);

    // Keep going forward until we find a valid entry or exhaust history
    let result = goForwardPure(currentState);
    while (result.entry) {
      // null zoomedRootId (roots view) is always valid
      // Otherwise, check if block still exists
      if (
        result.entry.zoomedRootId === null ||
        blockExists(result.entry.zoomedRootId)
      ) {
        // Valid entry found - update state and zoom
        setState('navigationHistory', paneId, result.state);
        setZoomedRoot(paneId, result.entry.zoomedRootId);

        // Restore focused block if it exists
        if (result.entry.focusedBlockId && blockExists(result.entry.focusedBlockId)) {
          setFocusedBlockId(paneId, result.entry.focusedBlockId);
        }

        return result.entry;
      }

      // Block was deleted - skip this entry and try next
      currentState = result.state;
      result = goForwardPure(currentState);
    }

    // Exhausted history without finding valid entry
    setState('navigationHistory', paneId, result.state);
    return null;
  };

  /**
   * Check if can go back (has history entries)
   */
  const canGoBack = (paneId: string): boolean => {
    return canGoBackPure(getNavigationHistory(paneId));
  };

  /**
   * Check if can go forward (has forward entries)
   */
  const canGoForward = (paneId: string): boolean => {
    return canGoForwardPure(getNavigationHistory(paneId));
  };

  /**
   * FLO-77: Clone pane state from source to target
   * Used when splitting an outliner pane to preserve view context
   *
   * FLO-180: New panes get EMPTY history (not cloned)
   * Rationale: Split creates a new "session" at that location.
   * Users don't expect back-button to affect both panes.
   * Matches browser tab duplication (new tab, empty history).
   */
  const clonePaneState = (sourcePaneId: string, targetPaneId: string) => {
    // Clone zoomed root
    const zoomedRoot = getZoomedRootId(sourcePaneId);
    if (zoomedRoot) {
      setState('zoomedRootId', targetPaneId, zoomedRoot);
    }

    // Clone focused block
    const focusedBlock = getFocusedBlockId(sourcePaneId);
    if (focusedBlock) {
      setState('focusedBlockId', targetPaneId, focusedBlock);
    }

    // Deep clone collapsed state
    const sourceCollapsed = state.collapsed[sourcePaneId];
    if (sourceCollapsed && Object.keys(sourceCollapsed).length > 0) {
      setState('collapsed', targetPaneId, { ...sourceCollapsed });
    }

    // FLO-180: Initialize EMPTY history for new pane (not cloned)
    setState('navigationHistory', targetPaneId, createNavigationState());
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
    // FLO-77: Clean up focused block state
    if (state.focusedBlockId[paneId] !== undefined) {
      setState('focusedBlockId', paneId, undefined!);
    }
    // FLO-180: Clean up navigation history
    if (state.navigationHistory[paneId]) {
      setState('navigationHistory', paneId, undefined!);
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
    restoredCollapsed?: Record<string, Record<string, boolean>>,
    restoredFocusedBlockId?: Record<string, string | null>,
    restoredNavigationHistory?: Record<string, NavigationState>
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

    // FLO-77: Restore focused block IDs
    if (restoredFocusedBlockId) {
      if (typeof restoredFocusedBlockId !== 'object' || restoredFocusedBlockId === null) {
        console.warn('[PaneStore] Invalid focusedBlockId structure, skipping');
        return;
      }
      setState('focusedBlockId', restoredFocusedBlockId);
    }

    // FLO-180: Restore navigation history (optional field, empty if missing)
    if (restoredNavigationHistory) {
      if (typeof restoredNavigationHistory !== 'object' || restoredNavigationHistory === null) {
        console.warn('[PaneStore] Invalid navigationHistory structure, skipping');
        return;
      }
      setState('navigationHistory', restoredNavigationHistory);
    }
  };

  /**
   * Get pane state for persistence
   * Deep clones to avoid SolidJS proxy leakage
   *
   * FLO-180: Navigation history is capped at 50 entries per pane on save
   */
  const getPaneStateForPersistence = (): {
    zoomedRootId: Record<string, string | null>;
    collapsed: Record<string, Record<string, boolean>>;
    focusedBlockId: Record<string, string | null>;
    navigationHistory: Record<string, NavigationState>;
  } => {
    // Cap history entries on save (defense in depth, push already caps)
    const cappedHistory: Record<string, NavigationState> = {};
    for (const [paneId, historyState] of Object.entries(state.navigationHistory)) {
      const entries = historyState.entries.slice(-DEFAULT_MAX_HISTORY_SIZE);
      cappedHistory[paneId] = {
        entries,
        currentIndex: Math.min(historyState.currentIndex, entries.length - 1),
      };
    }

    return {
      zoomedRootId: { ...state.zoomedRootId },
      // Deep clone nested structure to strip SolidJS proxies
      collapsed: JSON.parse(JSON.stringify(state.collapsed)),
      // FLO-77: Include focused block IDs in persistence
      focusedBlockId: { ...state.focusedBlockId },
      // FLO-180: Include navigation history (capped)
      navigationHistory: JSON.parse(JSON.stringify(cappedHistory)),
    };
  };

  return {
    toggleCollapsed,
    isCollapsed,
    setCollapsed,
    getZoomedRootId,
    setZoomedRoot,
    // FLO-77: Focused block tracking
    getFocusedBlockId,
    setFocusedBlockId,
    // FLO-180: Navigation history
    pushNavigation,
    goBack,
    goForward,
    canGoBack,
    canGoForward,
    // Clone state
    clonePaneState,
    // Cleanup
    removePane,
    removePanes,
    // Persistence
    hydratePaneState,
    getPaneStateForPersistence,
  };
}

export const paneStore = createRoot(createPaneStore);
