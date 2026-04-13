/**
 * Layout Store - SolidJS store for per-tab split pane layouts
 *
 * Each tab has its own layout tree. The store manages:
 * - Creating/removing layouts when tabs are created/closed
 * - Splitting panes (creating new terminals)
 * - Closing panes (collapsing tree structure)
 * - Focus navigation between panes
 * - Resize ratio updates
 */

import { batch, createRoot, createSignal } from 'solid-js';
import { createStore, produce } from 'solid-js/store';
import {
  type LayoutNode,
  type TabLayout,
  type PaneSplit,
  type PaneLeaf,
  type FocusDirection,
  type PaneDropPosition,
  createInitialLayout,
  generatePaneId,
  generateSplitId,
  findNode,
  findParent,
  findFirstLeaf,
  findAdjacentPane,
  replaceNode,
  collectPaneIds,
  clampRatio,
  moveLeafToTarget,
  moveLeafToRoot,
} from '../lib/layoutTypes';
import { paneStore } from './usePaneStore';
import { createLogger } from '../lib/logger';

const logger = createLogger('LayoutStore');

interface LayoutState {
  // Record of tabId -> TabLayout (using Record instead of Map for SolidJS reactivity)
  layouts: Record<string, TabLayout>;
  // Currently dragging split handle (null when not dragging)
  draggingSplitId: string | null;
}

function createLayoutStore() {
  const [state, setState] = createStore<LayoutState>({
    layouts: {},
    draggingSplitId: null,
  });
  const [persistenceVersion, setPersistenceVersion] = createSignal(0);

  const bumpPersistenceVersion = () => {
    setPersistenceVersion((v) => v + 1);
  };

  const initLayout = (tabId: string): string => {
    const layout = createInitialLayout(tabId);
    setState('layouts', tabId, layout);
    bumpPersistenceVersion();
    return layout.activePaneId;
  };

  const removeLayout = (tabId: string): string[] => {
    const layout = state.layouts[tabId];
    if (!layout) return [];

    const paneIds = collectPaneIds(layout.root);

    setState('layouts', produce((layouts) => {
      delete layouts[tabId];
    }));

    // Clean up all pane view state (prevents memory leak)
    paneStore.removePanes(paneIds);
    bumpPersistenceVersion();

    return paneIds;
  };

  const splitPane = (
    tabId: string,
    direction: 'horizontal' | 'vertical',
    leafType: 'terminal' | 'outliner' = 'terminal',
    ephemeral: boolean = false,
    collapseDepth?: number  // FLO-197: Initial collapse depth for new outliner pane
  ): string | null => {
    const layout = state.layouts[tabId];
    if (!layout) {
      logger.warn(`splitPane: no layout for tab ${tabId}`);
      return null;
    }

    // FLO-136: If creating ephemeral split, close existing ephemeral for this direction first
    if (ephemeral) {
      const existingEphemeralId = layout.ephemeralPaneIds?.[direction];
      if (existingEphemeralId) {
        // Close the existing ephemeral pane (will collapse its split)
        closePane(tabId, existingEphemeralId);
        // Re-fetch layout after close
        const updatedLayout = state.layouts[tabId];
        if (!updatedLayout) return null;
      }
    }

    // Re-fetch layout in case ephemeral close modified it
    const currentLayout = state.layouts[tabId];
    if (!currentLayout) return null;

    const activePane = findNode(currentLayout.root, currentLayout.activePaneId);
    if (!activePane || activePane.type !== 'leaf') {
      logger.warn(`splitPane: active pane not found or not a leaf for tab ${tabId}`);
      return null;
    }

    // FLO-77: Capture scroll position from source outliner pane (before DOM changes)
    let initialScrollTop: number | undefined;
    const isOutlinerSource = activePane.leafType === 'outliner';
    const isOutlinerTarget = leafType === 'outliner';

    if (isOutlinerSource && isOutlinerTarget) {
      // Query DOM for current scroll position of source pane
      const sourceEl = document.querySelector(`[data-pane-id="${activePane.id}"] .outliner-container`);
      if (sourceEl) {
        initialScrollTop = sourceEl.scrollTop;
      }
    }

    // Create new pane and split - inherit cwd from active pane
    const newPaneId = generatePaneId();
    const newSplit: PaneSplit = {
      type: 'split',
      id: generateSplitId(),
      direction,
      ratio: 0.5,
      children: [
        // Preserve the original pane's layout state in place. The new split pane is a
        // fresh terminal and must not inherit the original pane's tmux attachment contract.
        { type: 'leaf' as const, id: activePane.id, cwd: activePane.cwd, leafType: activePane.leafType || 'terminal', ...(activePane.tmuxSession ? { tmuxSession: activePane.tmuxSession } : {}) },
        // FLO-136/FLO-197: Mark ephemeral if requested, set collapse depth for outliners
        { type: 'leaf' as const, id: newPaneId, cwd: activePane.cwd, leafType, initialScrollTop, ephemeral, initialCollapseDepth: collapseDepth },
      ],
    };

    // FLO-77: Clone pane state (zoom, collapsed, focused) when splitting outliner
    if (isOutlinerSource && isOutlinerTarget) {
      paneStore.clonePaneState(activePane.id, newPaneId);
    }

    // Replace the active pane with the split
    const newRoot = replaceNode(currentLayout.root, activePane.id, newSplit);

    // Atomic update - batch prevents partial state during tree mutation
    batch(() => {
      setState('layouts', tabId, 'root', newRoot);
      setState('layouts', tabId, 'activePaneId', newPaneId);
      // FLO-136: Track ephemeral pane by direction
      if (ephemeral) {
        // Use produce to safely create nested object if it doesn't exist
        setState('layouts', tabId, produce((layout: TabLayout) => {
          if (!layout.ephemeralPaneIds) {
            layout.ephemeralPaneIds = {};
          }
          layout.ephemeralPaneIds[direction] = newPaneId;
        }));
      }
    });
    bumpPersistenceVersion();

    return newPaneId;
  };

  const togglePaneType = (tabId: string, paneId: string) => {
    const layout = state.layouts[tabId];
    if (!layout) return;

    const node = findNode(layout.root, paneId);
    if (!node || node.type !== 'leaf') return;

    const newType = node.leafType === 'outliner' ? 'terminal' : 'outliner';
    const newNode: PaneLeaf = { ...node, leafType: newType };
    
    const newRoot = replaceNode(layout.root, paneId, newNode);
    setState('layouts', tabId, 'root', newRoot);
    bumpPersistenceVersion();
  };

  const closePane = (tabId: string, paneId: string): string | null => {
    const layout = state.layouts[tabId];
    if (!layout) {
      logger.warn(`closePane: no layout for tab ${tabId}`);
      return null;
    }

    // Check if pane exists in tree (idempotent - already closed is OK)
    const paneIds = collectPaneIds(layout.root);
    if (!paneIds.includes(paneId)) {
      // Pane already removed - this is expected with race between keyboard and PTY exit
      logger.debug(`closePane: pane ${paneId} not in tree (already closed)`);
      return layout.activePaneId;
    }

    // Can't close the last pane
    if (paneIds.length <= 1) {
      logger.debug(`closePane: can't close last pane in tab ${tabId}`);
      return null;
    }

    // FLO-136: Check if this pane is ephemeral (need to clear tracking)
    const ephemeralIds = layout.ephemeralPaneIds;
    const ephemeralDirection = ephemeralIds?.horizontal === paneId ? 'horizontal'
      : ephemeralIds?.vertical === paneId ? 'vertical'
      : null;

    // Find parent split and sibling
    const parent = findParent(layout.root, paneId);
    if (!parent) {
      // This shouldn't happen if pane is in tree, but be defensive
      logger.warn(`closePane: parent not found for pane ${paneId}`);
      return null;
    }

    // Get the sibling (the child that's not being closed)
    const sibling = parent.children[0].id === paneId
      ? parent.children[1]
      : parent.children[0];

    // Replace the parent split with the sibling
    const newRoot = replaceNode(layout.root, parent.id, sibling);

    // Determine new active pane
    const newActivePaneId = layout.activePaneId === paneId
      ? findFirstLeaf(sibling).id
      : layout.activePaneId;

    // Atomic update - batch prevents partial state during tree mutation
    batch(() => {
      setState('layouts', tabId, 'root', newRoot);
      setState('layouts', tabId, 'activePaneId', newActivePaneId);
      // FLO-136: Clear ephemeral tracking if this pane was ephemeral
      if (ephemeralDirection) {
        setState('layouts', tabId, produce((l: TabLayout) => {
          if (l.ephemeralPaneIds) {
            delete l.ephemeralPaneIds[ephemeralDirection];
          }
        }));
      }
    });
    bumpPersistenceVersion();

    // Clean up pane view state (prevents memory leak)
    paneStore.removePane(paneId);

    return newActivePaneId;
  };

  const setActivePaneId = (tabId: string, paneId: string) => {
    const layout = state.layouts[tabId];
    if (!layout) return;

    // Verify pane exists
    if (!findNode(layout.root, paneId)) return;
    if (layout.activePaneId === paneId) return;

    setState('layouts', tabId, 'activePaneId', paneId);
    bumpPersistenceVersion();
  };

  const setRatio = (tabId: string, splitId: string, ratio: number) => {
    const layout = state.layouts[tabId];
    if (!layout) return;

    const split = findNode(layout.root, splitId);
    if (!split || split.type !== 'split') return;

    const clampedRatio = clampRatio(ratio);
    if (split.ratio === clampedRatio) return;

    const newSplit: PaneSplit = {
      ...split,
      ratio: clampedRatio,
    };

    const newRoot = replaceNode(layout.root, splitId, newSplit);

    setState('layouts', tabId, 'root', newRoot);
    bumpPersistenceVersion();
  };

  const focusDirection = (tabId: string, direction: FocusDirection): string | null => {
    const layout = state.layouts[tabId];
    if (!layout) return null;

    const adjacentPaneId = findAdjacentPane(
      layout.root,
      layout.activePaneId,
      direction
    );

    if (adjacentPaneId) {
      setState('layouts', tabId, 'activePaneId', adjacentPaneId);
      bumpPersistenceVersion();
      return adjacentPaneId;
    }
    return null;
  };

  const getActivePaneId = (tabId: string): string | null => {
    return state.layouts[tabId]?.activePaneId ?? null;
  };

  const getLayout = (tabId: string): LayoutNode | null => {
    return state.layouts[tabId]?.root ?? null;
  };

  const getTabLayout = (tabId: string): TabLayout | null => {
    return state.layouts[tabId] ?? null;
  };

  const getAllPaneIds = (tabId: string): string[] => {
    const layout = state.layouts[tabId];
    if (!layout) return [];
    return collectPaneIds(layout.root);
  };

  const getPaneLeaf = (tabId: string, paneId: string): PaneLeaf | null => {
    const layout = state.layouts[tabId];
    if (!layout) return null;
    const node = findNode(layout.root, paneId);
    return node?.type === 'leaf' ? node : null;
  };

  const setDraggingSplitId = (splitId: string | null) => {
    setState('draggingSplitId', splitId);
  };

  const movePane = (
    tabId: string,
    sourcePaneId: string,
    targetPaneId: string,
    position: PaneDropPosition
  ): boolean => {
    const layout = state.layouts[tabId];
    if (!layout) return false;
    if (sourcePaneId === targetPaneId) return false;

    const sourceNode = findNode(layout.root, sourcePaneId);
    const targetNode = findNode(layout.root, targetPaneId);
    if (!sourceNode || sourceNode.type !== 'leaf') return false;
    if (!targetNode || targetNode.type !== 'leaf') return false;

    // Clone store data first; layout.root is a Solid proxy.
    const rootClone = JSON.parse(JSON.stringify(layout.root)) as LayoutNode;
    const newRoot = moveLeafToTarget(rootClone, sourcePaneId, targetPaneId, position);
    if (!newRoot) return false;

    batch(() => {
      setState('layouts', tabId, 'root', newRoot);
      setState('layouts', tabId, 'activePaneId', sourcePaneId);
    });
    bumpPersistenceVersion();

    return true;
  };

  const movePaneToRoot = (
    tabId: string,
    sourcePaneId: string,
    position: 'left' | 'right'
  ): boolean => {
    const layout = state.layouts[tabId];
    if (!layout) return false;

    const sourceNode = findNode(layout.root, sourcePaneId);
    if (!sourceNode || sourceNode.type !== 'leaf') return false;

    // Clone store data first; layout.root is a Solid proxy.
    const rootClone = JSON.parse(JSON.stringify(layout.root)) as LayoutNode;
    const newRoot = moveLeafToRoot(rootClone, sourcePaneId, position);
    if (!newRoot) return false;

    batch(() => {
      setState('layouts', tabId, 'root', newRoot);
      setState('layouts', tabId, 'activePaneId', sourcePaneId);
    });
    bumpPersistenceVersion();

    return true;
  };

  /**
   * FLO-136: Pin an ephemeral pane (make it permanent)
   * Called when user interacts in a way that indicates they want to keep the pane.
   * Returns true if the pane was ephemeral and is now pinned.
   */
  const pinPane = (tabId: string, paneId: string): boolean => {
    const layout = state.layouts[tabId];
    if (!layout) return false;

    const pane = findNode(layout.root, paneId);
    if (!pane || pane.type !== 'leaf' || !pane.ephemeral) {
      return false; // Not ephemeral, nothing to pin
    }

    // Find which direction this ephemeral pane belongs to
    const ephemeralIds = layout.ephemeralPaneIds;
    const direction = ephemeralIds?.horizontal === paneId ? 'horizontal'
      : ephemeralIds?.vertical === paneId ? 'vertical'
      : null;

    // Update pane in tree to remove ephemeral flag
    const pinnedPane: PaneLeaf = { ...pane, ephemeral: false };
    const newRoot = replaceNode(layout.root, paneId, pinnedPane);

    batch(() => {
      setState('layouts', tabId, 'root', newRoot);
      // Clear from ephemeral tracking
      if (direction && layout.ephemeralPaneIds) {
        setState('layouts', tabId, produce((l: TabLayout) => {
          if (l.ephemeralPaneIds) {
            delete l.ephemeralPaneIds[direction];
          }
        }));
      }
    });
    bumpPersistenceVersion();

    logger.debug(`pinPane: pinned ${paneId} (was ${direction} ephemeral)`);
    return true;
  };

  /**
   * Set or clear tmux session on a pane leaf (for auto-reattach).
   * Pane-owned, not tab-owned. Cleared when the user exits tmux.
   * Multiple panes do not share tmux session state.
   */
  const setPaneTmuxSession = (tabId: string, paneId: string, tmuxSession: string | undefined) => {
    const layout = state.layouts[tabId];
    if (!layout) return;

    const pane = findNode(layout.root, paneId);
    if (!pane || pane.type !== 'leaf') return;
    if (pane.tmuxSession === tmuxSession) return; // no-op

    const updated: PaneLeaf = { ...pane, tmuxSession };
    if (!tmuxSession) delete updated.tmuxSession; // clean undefined from serialization
    const newRoot = replaceNode(layout.root, paneId, updated);
    setState('layouts', tabId, produce((currentLayout: TabLayout) => {
      currentLayout.root = newRoot;
    }));
    bumpPersistenceVersion();
  };

  /**
   * FLO-136: Check if a pane is ephemeral
   */
  const isEphemeral = (tabId: string, paneId: string): boolean => {
    const pane = getPaneLeaf(tabId, paneId);
    return pane?.ephemeral === true;
  };

  /**
   * Hydrate layouts from persisted state
   * Replaces current layouts with restored data
   */
  const hydrateLayouts = (restoredLayouts: Record<string, TabLayout>) => {
    setState('layouts', restoredLayouts);
  };

  /**
   * Get all layouts for persistence
   * Deep clones to avoid SolidJS proxy leakage
   */
  const getLayoutsForPersistence = (): Record<string, { root: LayoutNode; activePaneId: string }> => {
    const result: Record<string, { root: LayoutNode; activePaneId: string }> = {};
    for (const [tabId, layout] of Object.entries(state.layouts)) {
      result[tabId] = {
        // Deep clone to strip SolidJS proxies before serialization
        root: JSON.parse(JSON.stringify(layout.root)),
        activePaneId: layout.activePaneId,
      };
    }
    return result;
  };

  return {
    // State (reactive getters preserve store reactivity)
    get layouts() { return state.layouts; },
    get draggingSplitId() { return state.draggingSplitId; },
    persistenceVersion,
    // Actions
    initLayout,
    removeLayout,
    splitPane,
    closePane,
    togglePaneType,
    setActivePaneId,
    setRatio,
    movePane,
    movePaneToRoot,
    setDraggingSplitId,
    focusDirection,
    // Getters
    getActivePaneId,
    getLayout,
    getTabLayout,
    getAllPaneIds,
    getPaneLeaf,
    // Ephemeral panes (FLO-136)
    pinPane,
    isEphemeral,
    // tmux session per pane
    setPaneTmuxSession,
    // Persistence
    hydrateLayouts,
    getLayoutsForPersistence,
  };
}

// Create singleton store
export const layoutStore = createRoot(createLayoutStore);

/**
 * Find the tabId that contains a given paneId.
 * Searches all layouts in layoutStore.
 * Returns null if pane not found in any tab.
 */
export function findTabIdByPaneId(paneId: string): string | null {
  const layouts = layoutStore.layouts;
  for (const [tabId, layout] of Object.entries(layouts)) {
    const paneIds = collectPaneIds(layout.root);
    if (paneIds.includes(paneId)) {
      return tabId;
    }
  }
  return null;
}
