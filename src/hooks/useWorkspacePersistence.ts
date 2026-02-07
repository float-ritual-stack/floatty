/**
 * Workspace Persistence Hook (FLO-81)
 *
 * Centralized hook that coordinates saving/loading workspace layout state.
 * Uses SQLite backend via Tauri commands for persistence.
 *
 * Persisted state includes:
 * - Tab metadata (id, title)
 * - Layout trees (pane splits, ratios)
 * - Active tab/pane
 * - Pane view state (zoom, collapse)
 *
 * NOT persisted (FLO-82 scope):
 * - Terminal scroll/history
 * - PTY processes (need respawn)
 */

import { invoke } from '../lib/tauriTypes';
import { createSignal } from 'solid-js';
import { tabStore, type Tab } from './useTabStore';
import { layoutStore } from './useLayoutStore';
import { paneStore } from './usePaneStore';
import type { LayoutNode, TabLayout } from '../lib/layoutTypes';

// Persistence key for default workspace
const WORKSPACE_KEY = 'default';

// Debounce delay for saves (ms)
const SAVE_DEBOUNCE_MS = 500;

// Version for schema migration
const SCHEMA_VERSION = 1;

/**
 * Persisted workspace state schema
 */
export interface PersistedWorkspace {
  version: number;
  // Last accepted workspace save sequence (optional for pre-sequence payloads)
  saveSeq?: number;
  tabs: Array<{ id: string; title: string }>;
  activeTabId: string | null;
  layouts: Record<string, { root: LayoutNode; activePaneId: string }>;
  paneStates: Record<string, {
    zoomedRootId: string | null;
  }>;
  // Collapsed state per pane (optional, can be large)
  collapsedState?: Record<string, Record<string, boolean>>;
  // FLO-77: Focused block ID per pane (optional)
  focusedBlockId?: Record<string, string | null>;
  // FLO-180: Navigation history per pane (optional, capped at 50 entries)
  navigationHistory?: Record<string, {
    entries: Array<{
      zoomedRootId: string | null;
      focusedBlockId?: string;
      timestamp: number;
    }>;
    currentIndex: number;
  }>;
}

/**
 * Create the workspace persistence hook
 * Call this once at app startup to enable persistence
 */
export function createWorkspacePersistence() {
  const [isLoaded, setIsLoaded] = createSignal(false);
  const [loadError, setLoadError] = createSignal<string | null>(null);

  let saveTimeoutId: ReturnType<typeof setTimeout> | null = null;
  let nextSaveSeq = 0;

  /**
   * Load workspace state from SQLite
   */
  async function loadWorkspace(): Promise<boolean> {
    try {
      const stored = await invoke<{ stateJson: string; saveSeq: number } | null>(
        'get_workspace_state',
        { key: WORKSPACE_KEY },
      );

      if (!stored) {
        console.log('[WorkspacePersistence] No saved state found, using defaults');
        setIsLoaded(true);
        return false;
      }

      const state = JSON.parse(stored.stateJson) as PersistedWorkspace;

      // Version check (future: migration logic)
      if (state.version !== SCHEMA_VERSION) {
        console.warn(`[WorkspacePersistence] Schema version mismatch (${state.version} vs ${SCHEMA_VERSION}), using defaults`);
        setIsLoaded(true);
        return false;
      }

      // Validate minimal structure
      if (!state.tabs || state.tabs.length === 0) {
        console.warn('[WorkspacePersistence] Invalid state: no tabs, using defaults');
        setIsLoaded(true);
        return false;
      }

      // Hydrate stores in order: tabs first, then layouts, then pane state
      const restoredTabs: Tab[] = state.tabs.map((t) => ({
        id: t.id,
        title: t.title,
        ptyPid: null,
        isAlive: true,
      }));

      // Validate activeTabId exists in restored tabs
      const tabIds = new Set(state.tabs.map((t) => t.id));
      let activeTabId = state.activeTabId;
      if (activeTabId && !tabIds.has(activeTabId)) {
        console.warn(`[WorkspacePersistence] activeTabId '${activeTabId}' not found in tabs, falling back to first tab`);
        activeTabId = state.tabs[0].id;
      }

      tabStore.hydrateTabs(restoredTabs, activeTabId || state.tabs[0].id);

      // Reconstruct TabLayout objects with tabId
      const layoutsWithTabId: Record<string, TabLayout> = {};
      for (const [tabId, layout] of Object.entries(state.layouts)) {
        layoutsWithTabId[tabId] = {
          tabId,
          root: layout.root,
          activePaneId: layout.activePaneId,
        };
      }
      layoutStore.hydrateLayouts(layoutsWithTabId);

      // Reconstruct pane state
      const zoomedRootIds: Record<string, string | null> = {};
      for (const [paneId, paneState] of Object.entries(state.paneStates)) {
        zoomedRootIds[paneId] = paneState.zoomedRootId;
      }
      // FLO-77: Pass focusedBlockId to hydration
      // FLO-180: Pass navigationHistory to hydration
      paneStore.hydratePaneState(zoomedRootIds, state.collapsedState, state.focusedBlockId, state.navigationHistory);

      // Seed local save sequence from persisted value to prevent stale replays after app restart.
      const hydratedSaveSeq = Math.max(state.saveSeq ?? 0, stored.saveSeq ?? 0);
      if (hydratedSaveSeq > nextSaveSeq) {
        nextSaveSeq = hydratedSaveSeq;
      }

      console.log(`[WorkspacePersistence] Restored workspace: ${state.tabs.length} tabs`);
      setIsLoaded(true);
      return true;

    } catch (err) {
      console.error('[WorkspacePersistence] Failed to load workspace:', err);
      setLoadError(String(err));
      setIsLoaded(true);
      return false;
    }
  }

  /**
   * Save workspace state to SQLite
   */
  async function saveWorkspace(): Promise<void> {
    try {
      const saveSeq = ++nextSaveSeq;
      const tabData = tabStore.getTabsForPersistence();
      const layoutData = layoutStore.getLayoutsForPersistence();
      const paneData = paneStore.getPaneStateForPersistence();

      // Build pane states from zoomedRootId
      const paneStates: Record<string, { zoomedRootId: string | null }> = {};
      for (const [paneId, zoomedRootId] of Object.entries(paneData.zoomedRootId)) {
        paneStates[paneId] = { zoomedRootId };
      }

      const state: PersistedWorkspace = {
        version: SCHEMA_VERSION,
        saveSeq,
        tabs: tabData.tabs,
        activeTabId: tabData.activeTabId,
        layouts: layoutData,
        paneStates,
        collapsedState: paneData.collapsed,
        // FLO-77: Include focusedBlockId in persistence
        focusedBlockId: paneData.focusedBlockId,
        // FLO-180: Include navigationHistory in persistence (capped at 50 entries per pane)
        navigationHistory: paneData.navigationHistory,
      };

      const stateJson = JSON.stringify(state);
      await invoke('save_workspace_state', { key: WORKSPACE_KEY, stateJson, saveSeq });

      console.debug('[WorkspacePersistence] Saved workspace state');

    } catch (err) {
      console.error('[WorkspacePersistence] Failed to save workspace:', err);
    }
  }

  /**
   * Schedule a debounced save
   */
  function scheduleSave() {
    if (saveTimeoutId) {
      clearTimeout(saveTimeoutId);
    }
    saveTimeoutId = setTimeout(() => {
      saveWorkspace();
      saveTimeoutId = null;
    }, SAVE_DEBOUNCE_MS);
  }

  /**
   * Force immediate save (for beforeunload)
   */
  function saveNow() {
    if (saveTimeoutId) {
      clearTimeout(saveTimeoutId);
      saveTimeoutId = null;
    }
    // Synchronous-ish save attempt
    saveWorkspace();
  }

  return {
    isLoaded,
    loadError,
    loadWorkspace,
    saveWorkspace,
    scheduleSave,
    saveNow,
  };
}

// Singleton instance
let persistenceInstance: ReturnType<typeof createWorkspacePersistence> | null = null;

/**
 * Get or create the workspace persistence singleton
 */
export function getWorkspacePersistence() {
  if (!persistenceInstance) {
    persistenceInstance = createWorkspacePersistence();
  }
  return persistenceInstance;
}

/**
 * Hook for components that need to trigger saves
 * Returns the persistence singleton
 *
 * Note: Window close handling is done centrally in App.tsx using
 * Tauri's onCloseRequested which properly awaits async saves.
 */
export function useWorkspacePersistence() {
  return getWorkspacePersistence();
}
