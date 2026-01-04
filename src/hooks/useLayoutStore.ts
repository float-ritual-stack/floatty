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
import { paneStore } from './usePaneStore';

interface LayoutState {
  // Record of tabId -> TabLayout (using Record instead of Map for SolidJS reactivity)
  layouts: Record<string, TabLayout>;
  // Currently dragging split handle (null when not dragging)
  draggingSplitId: string | null;
  // Hint mode state (Vimium-style pane selection)
  hintMode: {
    active: boolean;
    tabId: string | null;  // Which tab is showing hints
    hints: Record<string, string>;  // paneId -> hint letter
    pendingLinkTarget: string | null;  // Wikilink target for after selection
    sourcePaneId: string | null;  // Where the link was clicked (for Alt+Click fallback)
  };
}

function createLayoutStore() {
  const [state, setState] = createStore<LayoutState>({
    layouts: {},
    draggingSplitId: null,
    hintMode: {
      active: false,
      tabId: null,
      hints: {},
      pendingLinkTarget: null,
      sourcePaneId: null,
    },
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

    // Clean up all pane view state (prevents memory leak)
    paneStore.removePanes(paneIds);

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
        // CLONE the leaf - don't use proxy directly (causes infinite recursion)
        { type: 'leaf', id: activePane.id, cwd: activePane.cwd, leafType: activePane.leafType || 'terminal' },
        { type: 'leaf', id: newPaneId, cwd: activePane.cwd, leafType, initialScrollTop },
      ],
    };

    // FLO-77: Clone pane state (zoom, collapsed, focused) when splitting outliner
    if (isOutlinerSource && isOutlinerTarget) {
      paneStore.clonePaneState(activePane.id, newPaneId);
    }

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

    // Check if pane exists in tree (idempotent - already closed is OK)
    const paneIds = collectPaneIds(layout.root);
    if (!paneIds.includes(paneId)) {
      // Pane already removed - this is expected with race between keyboard and PTY exit
      console.debug(`[LayoutStore] closePane: pane ${paneId} not in tree (already closed)`);
      return layout.activePaneId;
    }

    // Can't close the last pane
    if (paneIds.length <= 1) {
      console.debug(`[LayoutStore] closePane: can't close last pane in tab ${tabId}`);
      return null;
    }

    // Find parent split and sibling
    const parent = findParent(layout.root, paneId);
    if (!parent) {
      // This shouldn't happen if pane is in tree, but be defensive
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

    // Clean up pane view state (prevents memory leak)
    paneStore.removePane(paneId);

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

  const setDraggingSplitId = (splitId: string | null) => {
    setState('draggingSplitId', splitId);
  };

  // ─────────────────────────────────────────────────────────────
  // Hint Mode (Vimium-style pane selection)
  // ─────────────────────────────────────────────────────────────

  /**
   * Generate hint letters for visible panes in a tab.
   * Uses single letters A-Z for up to 26 panes.
   */
  const generateHints = (paneIds: string[]): Record<string, string> => {
    const hints: Record<string, string> = {};
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

    paneIds.forEach((paneId, index) => {
      if (index < letters.length) {
        hints[paneId] = letters[index];
      }
    });

    return hints;
  };

  /**
   * Enter hint mode for a given tab.
   * Shows letter hints over all panes to allow keyboard selection.
   */
  const enterHintMode = (tabId: string, linkTarget: string, sourcePaneId: string) => {
    const paneIds = getAllPaneIds(tabId);
    if (paneIds.length === 0) return;

    const hints = generateHints(paneIds);

    batch(() => {
      setState('hintMode', {
        active: true,
        tabId,
        hints,
        pendingLinkTarget: linkTarget,
        sourcePaneId,
      });
    });
  };

  /**
   * Exit hint mode without taking action.
   */
  const exitHintMode = () => {
    setState('hintMode', {
      active: false,
      tabId: null,
      hints: {},
      pendingLinkTarget: null,
      sourcePaneId: null,
    });
  };

  /**
   * Get pane ID by hint letter.
   * Returns null if letter doesn't match any hint.
   */
  const getPaneByHint = (letter: string): string | null => {
    const upperLetter = letter.toUpperCase();

    for (const [paneId, hint] of Object.entries(state.hintMode.hints)) {
      if (hint === upperLetter) {
        return paneId;
      }
    }

    return null;
  };

  /**
   * Check if hint mode is active.
   */
  const isHintModeActive = (): boolean => {
    return state.hintMode.active;
  };

  /**
   * Get current hint mode state.
   */
  const getHintModeState = () => {
    return state.hintMode;
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
    // Actions
    initLayout,
    removeLayout,
    splitPane,
    closePane,
    togglePaneType,
    setActivePaneId,
    setRatio,
    setDraggingSplitId,
    focusDirection,
    // Getters
    getActivePaneId,
    getLayout,
    getTabLayout,
    getAllPaneIds,
    getPaneLeaf,
    // Persistence
    hydrateLayouts,
    getLayoutsForPersistence,
    // Hint Mode (Vimium-style pane selection)
    enterHintMode,
    exitHintMode,
    getPaneByHint,
    isHintModeActive,
    getHintModeState,
  };
}

// Create singleton store
export const layoutStore = createRoot(createLayoutStore);
