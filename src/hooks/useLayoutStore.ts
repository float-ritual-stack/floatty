/**
 * Layout Store - Zustand store for per-tab split pane layouts
 *
 * Each tab has its own layout tree. The store manages:
 * - Creating/removing layouts when tabs are created/closed
 * - Splitting panes (creating new terminals)
 * - Closing panes (collapsing tree structure)
 * - Focus navigation between panes
 * - Resize ratio updates
 */

import { create } from 'zustand';
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
  // Map of tabId -> TabLayout
  layouts: Map<string, TabLayout>;
}

interface LayoutActions {
  // Initialize a layout for a new tab (single pane)
  initLayout: (tabId: string) => string;  // Returns initial paneId

  // Remove layout when tab closes (returns pane IDs for cleanup)
  removeLayout: (tabId: string) => string[];

  // Split the active pane in a direction
  splitPane: (tabId: string, direction: 'horizontal' | 'vertical') => string | null;  // Returns new paneId

  // Close a specific pane (collapses tree)
  closePane: (tabId: string, paneId: string) => string | null;  // Returns new active paneId

  // Set which pane is active in a tab
  setActivePaneId: (tabId: string, paneId: string) => void;

  // Update split ratio
  setRatio: (tabId: string, splitId: string, ratio: number) => void;

  // Focus adjacent pane in a direction
  focusDirection: (tabId: string, direction: FocusDirection) => string | null;  // Returns new pane ID

  // Getters
  getActivePaneId: (tabId: string) => string | null;
  getLayout: (tabId: string) => LayoutNode | null;
  getTabLayout: (tabId: string) => TabLayout | null;
  getAllPaneIds: (tabId: string) => string[];
  getPaneLeaf: (tabId: string, paneId: string) => PaneLeaf | null;
}

export const useLayoutStore = create<LayoutState & LayoutActions>((set, get) => ({
  layouts: new Map(),

  initLayout: (tabId: string) => {
    const layout = createInitialLayout(tabId);
    set((state) => {
      const newLayouts = new Map(state.layouts);
      newLayouts.set(tabId, layout);
      return { layouts: newLayouts };
    });
    return layout.activePaneId;
  },

  removeLayout: (tabId: string) => {
    const state = get();
    const layout = state.layouts.get(tabId);
    if (!layout) return [];

    const paneIds = collectPaneIds(layout.root);

    set((state) => {
      const newLayouts = new Map(state.layouts);
      newLayouts.delete(tabId);
      return { layouts: newLayouts };
    });

    return paneIds;
  },

  splitPane: (tabId: string, direction: 'horizontal' | 'vertical') => {
    const state = get();
    const layout = state.layouts.get(tabId);
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
        activePane,  // Original pane stays first (left/top)
        { type: 'leaf', id: newPaneId, cwd: activePane.cwd },  // New pane inherits cwd
      ],
    };

    // Replace the active pane with the split
    const newRoot = replaceNode(layout.root, activePane.id, newSplit);

    set((state) => {
      const newLayouts = new Map(state.layouts);
      // Re-fetch layout from state to avoid stale closure
      const currentLayout = state.layouts.get(tabId);
      if (!currentLayout) return state; // Guard against concurrent removal
      newLayouts.set(tabId, {
        ...currentLayout,
        root: newRoot,
        activePaneId: newPaneId,  // Focus new pane
      });
      return { layouts: newLayouts };
    });

    return newPaneId;
  },

  closePane: (tabId: string, paneId: string) => {
    const state = get();
    const layout = state.layouts.get(tabId);
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

    set((state) => {
      const newLayouts = new Map(state.layouts);
      const currentLayout = state.layouts.get(tabId);
      if (!currentLayout) return state;
      newLayouts.set(tabId, {
        ...currentLayout,
        root: newRoot,
        activePaneId: newActivePaneId,
      });
      return { layouts: newLayouts };
    });

    return newActivePaneId;
  },

  setActivePaneId: (tabId: string, paneId: string) => {
    const state = get();
    const layout = state.layouts.get(tabId);
    if (!layout) return;

    // Verify pane exists
    if (!findNode(layout.root, paneId)) return;

    set((state) => {
      const newLayouts = new Map(state.layouts);
      const currentLayout = state.layouts.get(tabId);
      if (!currentLayout) return state;
      newLayouts.set(tabId, {
        ...currentLayout,
        activePaneId: paneId,
      });
      return { layouts: newLayouts };
    });
  },

  setRatio: (tabId: string, splitId: string, ratio: number) => {
    const state = get();
    const layout = state.layouts.get(tabId);
    if (!layout) return;

    const split = findNode(layout.root, splitId);
    if (!split || split.type !== 'split') return;

    const clampedRatio = clampRatio(ratio);

    const newSplit: PaneSplit = {
      ...split,
      ratio: clampedRatio,
    };

    const newRoot = replaceNode(layout.root, splitId, newSplit);

    set((state) => {
      const newLayouts = new Map(state.layouts);
      const currentLayout = state.layouts.get(tabId);
      if (!currentLayout) return state;
      newLayouts.set(tabId, {
        ...currentLayout,
        root: newRoot,
      });
      return { layouts: newLayouts };
    });
  },

  focusDirection: (tabId: string, direction: FocusDirection) => {
    const state = get();
    const layout = state.layouts.get(tabId);
    if (!layout) return null;

    const adjacentPaneId = findAdjacentPane(
      layout.root,
      layout.activePaneId,
      direction
    );

    if (adjacentPaneId) {
      set((state) => {
        const newLayouts = new Map(state.layouts);
        const currentLayout = state.layouts.get(tabId);
        if (!currentLayout) return state;
        newLayouts.set(tabId, {
          ...currentLayout,
          activePaneId: adjacentPaneId,
        });
        return { layouts: newLayouts };
      });
      return adjacentPaneId;
    }
    return null;
  },

  getActivePaneId: (tabId: string) => {
    return get().layouts.get(tabId)?.activePaneId ?? null;
  },

  getLayout: (tabId: string) => {
    return get().layouts.get(tabId)?.root ?? null;
  },

  getTabLayout: (tabId: string) => {
    return get().layouts.get(tabId) ?? null;
  },

  getAllPaneIds: (tabId: string) => {
    const layout = get().layouts.get(tabId);
    if (!layout) return [];
    return collectPaneIds(layout.root);
  },

  getPaneLeaf: (tabId: string, paneId: string) => {
    const layout = get().layouts.get(tabId);
    if (!layout) return null;
    const node = findNode(layout.root, paneId);
    return node?.type === 'leaf' ? node : null;
  },
}));
