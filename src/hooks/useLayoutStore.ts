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

import { batch, createRoot } from 'solid-js';
import { createStore, produce } from 'solid-js/store';
import {
  type LayoutNode,
  type TabLayout,
  type PaneSplit,
  type PaneLeaf,
  type FocusDirection,
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
} from '../lib/layoutTypes';

interface LayoutState {
  // Record of tabId -> TabLayout (using Record instead of Map for SolidJS reactivity)
  layouts: Record<string, TabLayout>;
}

function createLayoutStore() {
  const [state, setState] = createStore<LayoutState>({
    layouts: {},
  });

  const initLayout = (tabId: string): string => {
    const layout = createInitialLayout(tabId);
    setState('layouts', tabId, layout);
    return layout.activePaneId;
  };

  const removeLayout = (tabId: string): string[] => {
    const layout = state.layouts[tabId];
    if (!layout) return [];

    const paneIds = collectPaneIds(layout.root);

    setState('layouts', produce((layouts) => {
      delete layouts[tabId];
    }));

    return paneIds;
  };

  const splitPane = (tabId: string, direction: 'horizontal' | 'vertical', leafType: 'terminal' | 'outliner' = 'terminal'): string | null => {
    const layout = state.layouts[tabId];
    if (!layout) {
      console.warn(`[LayoutStore] splitPane: no layout for tab ${tabId}`);
      return null;
    }

    const activePane = findNode(layout.root, layout.activePaneId);
    if (!activePane || activePane.type !== 'leaf') {
      console.warn(`[LayoutStore] splitPane: active pane not found or not a leaf for tab ${tabId}`);
      return null;
    }

    // Create new pane and split - inherit cwd from active pane
    const newPaneId = generatePaneId();
    const newSplit: PaneSplit = {
      type: 'split',
      id: generateSplitId(),
      direction,
      ratio: 0.5,
      children: [
        // CLONE the leaf - don't use proxy directly (causes infinite recursion)
        { type: 'leaf', id: activePane.id, cwd: activePane.cwd, leafType: activePane.leafType || 'terminal' },
        { type: 'leaf', id: newPaneId, cwd: activePane.cwd, leafType },
      ],
    };

    // Replace the active pane with the split
    const newRoot = replaceNode(layout.root, activePane.id, newSplit);

    // Atomic update - batch prevents partial state during tree mutation
    batch(() => {
      setState('layouts', tabId, 'root', newRoot);
      setState('layouts', tabId, 'activePaneId', newPaneId);
    });

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
  };

  const closePane = (tabId: string, paneId: string): string | null => {
    const layout = state.layouts[tabId];
    if (!layout) {
      console.warn(`[LayoutStore] closePane: no layout for tab ${tabId}`);
      return null;
    }

    // Can't close the last pane
    const paneIds = collectPaneIds(layout.root);
    if (paneIds.length <= 1) {
      console.debug(`[LayoutStore] closePane: can't close last pane in tab ${tabId}`);
      return null;
    }

    // Find parent split and sibling
    const parent = findParent(layout.root, paneId);
    if (!parent) {
      console.warn(`[LayoutStore] closePane: parent not found for pane ${paneId}`);
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
    });

    return newActivePaneId;
  };

  const setActivePaneId = (tabId: string, paneId: string) => {
    const layout = state.layouts[tabId];
    if (!layout) return;

    // Verify pane exists
    if (!findNode(layout.root, paneId)) return;

    setState('layouts', tabId, 'activePaneId', paneId);
  };

  const setRatio = (tabId: string, splitId: string, ratio: number) => {
    const layout = state.layouts[tabId];
    if (!layout) return;

    const split = findNode(layout.root, splitId);
    if (!split || split.type !== 'split') return;

    const clampedRatio = clampRatio(ratio);

    const newSplit: PaneSplit = {
      ...split,
      ratio: clampedRatio,
    };

    const newRoot = replaceNode(layout.root, splitId, newSplit);

    setState('layouts', tabId, 'root', newRoot);
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

  return {
    // State (reactive getter preserves store reactivity)
    get layouts() { return state.layouts; },
    // Actions
    initLayout,
    removeLayout,
    splitPane,
    closePane,
    togglePaneType,
    setActivePaneId,
    setRatio,
    focusDirection,
    // Getters
    getActivePaneId,
    getLayout,
    getTabLayout,
    getAllPaneIds,
    getPaneLeaf,
  };
}

// Create singleton store
export const layoutStore = createRoot(createLayoutStore);
