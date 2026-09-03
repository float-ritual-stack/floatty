/**
 * Pane Store - Manages pane-specific state (like collapsed blocks)
 *
 * Separate from layout store to handle view state that isn't structural.
 *
 * FLO-180: Added navigation history (back/forward) per pane.
 */

import { batch, createRoot, createSignal } from 'solid-js';
import { createStore, unwrap } from 'solid-js/store';
import { blockStore } from './useBlockStore';
import { computeExpansion } from '../lib/expansionPolicy';
import { createLogger } from '../lib/logger';

const logger = createLogger('PaneStore');
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

// FLO-211: Track panes with pending history navigation
// Used to skip auto-expand on back/forward (preserve user's collapse state)
const historyNavigationPending = new Set<string>();

// Re-export types for consumers
export type { NavigationState, NavigationEntry };

/**
 * FLO-668: Where a pane lives.
 *
 * Today every pane is tab-hosted via layoutStore.initLayout/splitPane.
 * After FLO-502 lands, sidebar-pinned outline panes live outside any tab's
 * layout tree and register with { kind: 'sidebar' }. A future floating-panel
 * feature (today spiked behind togglePanel/Cmd+Shift+P) uses { kind: 'floating' }.
 *
 * New pane creators MUST call registerPane. Deletion piggybacks on the
 * existing removePane / removePanes cleanup — no extra call needed.
 */
export type PaneHost =
  | { kind: 'tab'; tabId: string }
  | { kind: 'sidebar' }
  | { kind: 'floating' };

interface PaneState {
  // Map of paneId -> Set of collapsed block IDs
  // Since Sets aren't easily serializable/reactive in stores, we use an array or object
  // Using Record<paneId, Record<blockId, boolean>> for easy access
  collapsed: Record<string, Record<string, boolean>>;
  // Map of paneId -> zoomed root block ID (null = show all roots)
  zoomedRootId: Record<string, string | null>;
  // Pane navigation scope floor: the highest block a pane may zoom to
  // (null = unbounded). General primitive — the pin shelf is the first consumer
  // (floor = the pinned block). Ephemeral: re-established by the pane's owner on
  // mount, NOT persisted (like paneHost).
  floorId: Record<string, string | null>;
  // FLO-77: Map of paneId -> focused block ID (for clone-on-split)
  focusedBlockId: Record<string, string | null>;
  // FLO-180: Map of paneId -> navigation history (back/forward)
  navigationHistory: Record<string, NavigationState>;
  // Unit 12.0: Map of paneId -> blocks toggled to full-width mode
  fullWidth: Record<string, Record<string, boolean>>;
  // FLO-668: Map of paneId -> PaneHost (where the pane lives)
  // Ephemeral (not persisted). Cleared by removePane.
  paneHost: Record<string, PaneHost>;
  // FLO-440 backlinks drawer (U2): per-pane open state. Persisted.
  // Absent = closed (D1: default CLOSED, the ⟲n chip advertises).
  drawerOpen: Record<string, boolean>;
  // FLO-440 backlinks drawer (U2): per-pane height in px. Written only by
  // resize gestures (clamped to the pane where the gesture happened);
  // restore applies clamped against the CURRENT pane height without writing
  // back (drawerLayout.ts clampDrawerHeight), so a gesture-free short-window
  // session leaves a tall-window height intact.
  drawerHeight: Record<string, number>;
}

function createPaneStore() {
  const [state, setState] = createStore<PaneState>({
    collapsed: {},
    zoomedRootId: {},
    floorId: {},
    focusedBlockId: {},
    navigationHistory: {},
    fullWidth: {},
    paneHost: {},
    drawerOpen: {},
    drawerHeight: {},
  });
  const [persistenceVersion, setPersistenceVersion] = createSignal(0);

  const bumpPersistenceVersion = () => {
    setPersistenceVersion((v) => v + 1);
  };

  const toggleCollapsed = (paneId: string, blockId: string, blockDefaultCollapsed: boolean = false) => {
    // Get current value first to ensure proper toggle
    const currentValue = isCollapsed(paneId, blockId, blockDefaultCollapsed);
    const newValue = !currentValue;

    // Set in a single operation to avoid SolidJS store batching issues
    if (!state.collapsed[paneId]) {
      setState('collapsed', paneId, { [blockId]: newValue });
    } else {
      setState('collapsed', paneId, blockId, newValue);
    }

    // When expanding, use expansion policy for smart auto-collapse
    if (!newValue) {
      const result = computeExpansion({
        targetId: blockId,
        trigger: 'toggle',
        blockStore: { blocks: blockStore.blocks, rootIds: blockStore.rootIds },
      });
      // Batch all auto-collapse setState calls — 265 children = 265 individual
      // reactivity triggers without batch, causing multi-second hang
      batch(() => {
        for (const action of result.actions) {
          if (action.blockId === blockId) continue;
          if (state.collapsed[paneId]?.[action.blockId] !== undefined) continue;
          setState('collapsed', paneId, action.blockId, action.collapsed);
        }
      });
    }

    bumpPersistenceVersion();
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
    bumpPersistenceVersion();
  };

  // Unit 12.0: Full-width block mode
  const toggleFullWidth = (paneId: string, blockId: string) => {
    const current = isFullWidth(paneId, blockId);
    if (!state.fullWidth[paneId]) {
      setState('fullWidth', paneId, { [blockId]: !current });
    } else {
      setState('fullWidth', paneId, blockId, !current);
    }
  };

  const isFullWidth = (paneId: string, blockId: string): boolean => {
    return state.fullWidth[paneId]?.[blockId] ?? false;
  };

  // FLO-440 backlinks drawer (U2): per-pane open/height view state.
  // Height setters store the value they are handed — callers clamp against
  // the current pane height first (drawerLayout.ts), keeping "clamp on
  // apply, persist raw" in one place.
  const isDrawerOpen = (paneId: string): boolean => {
    return state.drawerOpen[paneId] ?? false;
  };

  const setDrawerOpen = (paneId: string, open: boolean) => {
    if ((state.drawerOpen[paneId] ?? false) === open) return;
    setState('drawerOpen', paneId, open);
    bumpPersistenceVersion();
  };

  const getDrawerHeight = (paneId: string): number | null => {
    return state.drawerHeight[paneId] ?? null;
  };

  const setDrawerHeight = (paneId: string, heightPx: number) => {
    if (state.drawerHeight[paneId] === heightPx) return;
    setState('drawerHeight', paneId, heightPx);
    bumpPersistenceVersion();
  };

  const getZoomedRootId = (paneId: string): string | null => {
    return state.zoomedRootId[paneId] ?? null;
  };

  const setZoomedRoot = (paneId: string, blockId: string | null) => {
    if (state.zoomedRootId[paneId] === blockId) return;
    setState('zoomedRootId', paneId, blockId);
    bumpPersistenceVersion();
  };

  // FLO-77: Focused block tracking for clone-on-split
  const getFocusedBlockId = (paneId: string): string | null => {
    return state.focusedBlockId[paneId] ?? null;
  };

  // Trailing debounce for presence POSTs. Without it, rapid arrow-key
  // navigation fires one HTTP request per block transition (measured 43
  // POSTs in a single navigation burst, 2026-06-12 perf recon). The TUI
  // follower only needs the resting position, so last-write-wins after a
  // short quiet period.
  const PRESENCE_DEBOUNCE_MS = 150;
  let presenceTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingPresencePaneId: string | null = null;

  const setFocusedBlockId = (paneId: string, blockId: string | null) => {
    if (state.focusedBlockId[paneId] === blockId) return;
    setState('focusedBlockId', paneId, blockId);
    bumpPersistenceVersion();
    // Spike: broadcast cursor position for TUI follower
    if (blockId && window.__FLOATTY_SERVER_URL__) {
      pendingPresencePaneId = paneId;
      if (presenceTimer) clearTimeout(presenceTimer);
      presenceTimer = setTimeout(() => {
        presenceTimer = null;
        const targetPaneId = pendingPresencePaneId;
        pendingPresencePaneId = null;
        if (!targetPaneId) return;
        // Re-read at fire time so the POST carries the resting position,
        // not the position when the debounce window opened.
        const currentBlockId = state.focusedBlockId[targetPaneId];
        if (!currentBlockId) return;
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (window.__FLOATTY_API_KEY__) headers['Authorization'] = `Bearer ${window.__FLOATTY_API_KEY__}`;
        fetch(`${window.__FLOATTY_SERVER_URL__}/api/v1/presence`, {
          method: 'POST', headers,
          body: JSON.stringify({ blockId: currentBlockId, paneId: targetPaneId }),
        }).catch(() => {});
      }, PRESENCE_DEBOUNCE_MS);
    }
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
   * Push a location to history (call AFTER navigating to destination)
   *
   * Standard browser model: entries contain visited locations.
   * Push the DESTINATION you just navigated TO, not where you came from.
   *
   * @param paneId - The pane to push history for
   * @param zoomedRootId - The destination location (null = roots view)
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
    bumpPersistenceVersion();
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
        // FLO-211: Skip history push (we're traversing history) and auto-expand
        historyNavigationPending.add(paneId);
        setZoomedRoot(paneId, result.entry.zoomedRootId);

        // Restore focused block if it exists
        if (result.entry.focusedBlockId && blockExists(result.entry.focusedBlockId)) {
          setFocusedBlockId(paneId, result.entry.focusedBlockId);
        }

        bumpPersistenceVersion();
        return result.entry;
      }

      // Block was deleted - skip this entry and try next
      currentState = result.state;
      result = goBackPure(currentState);
    }

    // Exhausted history without finding valid entry
    setState('navigationHistory', paneId, result.state);
    bumpPersistenceVersion();
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
        // FLO-211: Skip history push (we're traversing history) and auto-expand
        historyNavigationPending.add(paneId);
        setZoomedRoot(paneId, result.entry.zoomedRootId);

        // Restore focused block if it exists
        if (result.entry.focusedBlockId && blockExists(result.entry.focusedBlockId)) {
          setFocusedBlockId(paneId, result.entry.focusedBlockId);
        }

        bumpPersistenceVersion();
        return result.entry;
      }

      // Block was deleted - skip this entry and try next
      currentState = result.state;
      result = goForwardPure(currentState);
    }

    // Exhausted history without finding valid entry
    setState('navigationHistory', paneId, result.state);
    bumpPersistenceVersion();
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
   * FLO-211: Check and consume history navigation flag
   * Used by Outliner to skip auto-expand on back/forward navigation.
   * Returns true if this zoom change came from history navigation.
   */
  const consumeHistoryNavigation = (paneId: string): boolean => {
    if (historyNavigationPending.has(paneId)) {
      historyNavigationPending.delete(paneId);
      return true;
    }
    return false;
  };

  // ═══════════════════════════════════════════════════════════════
  // FLO-211: Unified Navigation API
  // Centralizes zoom + history push + auto-expand coordination
  // ═══════════════════════════════════════════════════════════════

  interface ZoomToOptions {
    /** Don't push to history (used by goBack/goForward) */
    skipHistory?: boolean;
    /** Don't auto-expand (used by history navigation) */
    skipAutoExpand?: boolean;
    /** FLO-211: Block where navigation started (e.g., wikilink container) */
    originBlockId?: string;
  }

  /**
   * Navigate to a zoom target with consistent history and expand behavior.
   *
   * This is the preferred API for navigation - use this instead of calling
   * setZoomedRoot + pushNavigation separately.
   *
   * @param paneId - The pane to navigate
   * @param targetBlockId - The block to zoom into (null = roots view)
   * @param options - Control history push and auto-expand behavior
   */
  const zoomTo = (
    paneId: string,
    targetBlockId: string | null,
    options: ZoomToOptions = {}
  ) => {
    const { skipHistory = false, skipAutoExpand = false, originBlockId } = options;

    // Push current location to history BEFORE navigating (browser model)
    // FLO-211: Capture focus so we can restore it on back navigation
    if (!skipHistory) {
      const currentZoom = getZoomedRootId(paneId);
      // Use originBlockId if provided (click navigation), else paneStore focus
      const focusToCapture = originBlockId ?? getFocusedBlockId(paneId) ?? undefined;

      pushNavigation(paneId, currentZoom, focusToCapture);
      pushNavigation(paneId, targetBlockId);  // Destination has no focus yet
    }

    // Mark to skip auto-expand if requested
    if (skipAutoExpand) {
      historyNavigationPending.add(paneId);
    }

    // Perform the zoom
    setZoomedRoot(paneId, targetBlockId);
  };

  // ── Pane navigation scope (floor) ───────────────────────────────────────
  // The floor is the highest block a pane may zoom to. null = unbounded (normal
  // panes — current behavior). resolvePaneZoom() in lib/navigation.ts reads this
  // to clamp/redirect above-floor navigation. General primitive; pins are the
  // first consumer. See apps/floatty/docs (pane-scope) for the policy.
  const getFloor = (paneId: string): string | null => {
    return state.floorId[paneId] ?? null;
  };

  const setFloor = (paneId: string, blockId: string | null) => {
    if (state.floorId[paneId] === blockId) return;
    setState('floorId', paneId, blockId);
  };

  /**
   * Establish a pane's scope: set the floor AND zoom to it in one call.
   * The pin shelf uses this to bind a pane to a block — it replaces the prior
   * direct `zoomTo` call (centralizing scope creation, per CodeRabbit feedback
   * on PR #317). `skipHistory` because this is external-state-driven retargeting
   * (the pin's [[target]] resolving), not user navigation — it must not pollute
   * the pane's Cmd+[ / Cmd+] history.
   */
  const setScope = (paneId: string, floorBlockId: string | null) => {
    setFloor(paneId, floorBlockId);
    zoomTo(paneId, floorBlockId, { skipHistory: true });
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
    bumpPersistenceVersion();
  };

  /**
   * FLO-668: Register a pane with its host kind.
   *
   * MUST be called when a new pane is created:
   *   - layoutStore.initLayout / splitPane / hydrateLayouts → { kind: 'tab', tabId }
   *   - Future sidebar pin shelf → { kind: 'sidebar' }
   *   - Future floating pane feature → { kind: 'floating' }
   *
   * Deletion piggybacks on removePane / removePanes — no unregisterPane call needed.
   * Idempotent: re-registering with an equivalent host is a no-op (matches the
   * setZoomedRoot / setFocusedBlockId guard pattern).
   */
  const registerPane = (paneId: string, host: PaneHost) => {
    const existing = state.paneHost[paneId];
    if (existing && existing.kind === host.kind) {
      if (host.kind !== 'tab' || existing.kind === 'tab' && existing.tabId === host.tabId) {
        return;
      }
    }
    setState('paneHost', paneId, host);
  };

  /**
   * FLO-668: Look up a pane's host.
   * Returns undefined for panes that were never registered (deleted or
   * pre-registry-era). Registered panes always have a non-null object.
   */
  const getPaneHost = (paneId: string): PaneHost | undefined => {
    return state.paneHost[paneId];
  };

  /**
   * FLO-668: Enumerate every paneId currently registered as { kind: 'tab' }.
   * Used by layoutStore.hydrateLayouts to reconcile stale registry entries
   * when the layouts map is replaced wholesale. Sidebar/floating entries are
   * intentionally excluded so hydration of tab layouts doesn't clobber them.
   */
  const getTabHostedPaneIds = (): string[] => {
    const ids: string[] = [];
    for (const [paneId, host] of Object.entries(state.paneHost)) {
      if (host?.kind === 'tab') ids.push(paneId);
    }
    return ids;
  };

  /**
   * Clean up state for a deleted pane (prevents memory leak)
   * Should be called when a pane is closed to remove orphaned view state
   */
  const removePane = (paneId: string) => {
    let changed = false;

    // FLO-211: Clean up pending history navigation flag (module-level Set)
    historyNavigationPending.delete(paneId);

    // Clean up collapsed state
    if (state.collapsed[paneId]) {
      setState('collapsed', paneId, undefined!);
      changed = true;
    }
    // Clean up zoomed state
    if (state.zoomedRootId[paneId] !== undefined) {
      setState('zoomedRootId', paneId, undefined!);
      changed = true;
    }
    // FLO-77: Clean up focused block state
    if (state.focusedBlockId[paneId] !== undefined) {
      setState('focusedBlockId', paneId, undefined!);
      changed = true;
    }
    // FLO-180: Clean up navigation history
    if (state.navigationHistory[paneId]) {
      setState('navigationHistory', paneId, undefined!);
      changed = true;
    }
    // Unit 12.0: Clean up full-width state
    if (state.fullWidth[paneId]) {
      setState('fullWidth', paneId, undefined!);
      changed = true;
    }
    // FLO-440: Clean up backlink drawer state (persisted, so flips `changed`)
    if (state.drawerOpen[paneId] !== undefined) {
      setState('drawerOpen', paneId, undefined!);
      changed = true;
    }
    if (state.drawerHeight[paneId] !== undefined) {
      setState('drawerHeight', paneId, undefined!);
      changed = true;
    }
    // FLO-668: Clean up host registry entry.
    // Does NOT flip `changed` — paneHost is session-ephemeral (excluded from
    // getPaneStateForPersistence), so clearing it shouldn't trigger a
    // persistence write. Addresses PR #265 review (Greptile P2).
    if (state.paneHost[paneId] !== undefined) {
      setState('paneHost', paneId, undefined!);
    }
    // Pane scope floor: ephemeral (re-established on mount, excluded from
    // persistence) — clear like paneHost without flipping `changed`.
    if (state.floorId[paneId] !== undefined) {
      setState('floorId', paneId, undefined!);
    }

    if (changed) {
      bumpPersistenceVersion();
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
    restoredNavigationHistory?: Record<string, NavigationState>,
    restoredDrawerOpen?: Record<string, boolean>,
    restoredDrawerHeight?: Record<string, number>
  ) => {
    // Validate zoomedRootIds structure
    if (typeof restoredZoomedRootIds !== 'object' || restoredZoomedRootIds === null) {
      logger.warn('Invalid zoomedRootIds structure, skipping hydration');
      return;
    }

    setState('zoomedRootId', restoredZoomedRootIds);

    if (restoredCollapsed) {
      // Validate collapsed structure
      if (typeof restoredCollapsed !== 'object' || restoredCollapsed === null) {
        logger.warn('Invalid collapsed structure, skipping');
        return;
      }
      setState('collapsed', restoredCollapsed);
    }

    // FLO-77: Restore focused block IDs
    if (restoredFocusedBlockId) {
      if (typeof restoredFocusedBlockId !== 'object' || restoredFocusedBlockId === null) {
        logger.warn('Invalid focusedBlockId structure, skipping');
        return;
      }
      setState('focusedBlockId', restoredFocusedBlockId);
    }

    // FLO-180: Restore navigation history (optional field, empty if missing)
    if (restoredNavigationHistory) {
      if (typeof restoredNavigationHistory !== 'object' || restoredNavigationHistory === null) {
        logger.warn('Invalid navigationHistory structure, skipping');
        return;
      }
      setState('navigationHistory', restoredNavigationHistory);
    }

    // FLO-440: Restore backlink drawer state (optional — absent in old saves)
    if (restoredDrawerOpen && typeof restoredDrawerOpen === 'object') {
      setState('drawerOpen', restoredDrawerOpen);
    }
    if (restoredDrawerHeight && typeof restoredDrawerHeight === 'object') {
      // Drop non-finite entries — a corrupt height would clamp to NaN and
      // render `height: NaNpx` (auto-height drawer).
      const numeric: Record<string, number> = {};
      for (const [paneId, height] of Object.entries(restoredDrawerHeight)) {
        if (typeof height === 'number' && Number.isFinite(height)) {
          numeric[paneId] = height;
        }
      }
      setState('drawerHeight', numeric);
    }
  };

  /**
   * FLO-83: Additively restore per-pane view state for panes that were just
   * created (named-layout preset apply).
   *
   * Deliberately NOT `hydratePaneState` (boot-only, REPLACES the whole map) and
   * NOT `zoomTo` (that is the user-navigation funnel and pushes history) — a
   * preset apply is state restoration for fresh pane ids, so it merges and
   * leaves navigation history alone.
   */
  const restorePaneViews = (
    zoomedRootIds: Record<string, string | null>,
    collapsed?: Record<string, Record<string, boolean>>
  ) => {
    batch(() => {
      for (const [paneId, zoomedRootId] of Object.entries(zoomedRootIds)) {
        setState('zoomedRootId', paneId, zoomedRootId);
      }
      for (const [paneId, blocks] of Object.entries(collapsed ?? {})) {
        if (!blocks || typeof blocks !== 'object') continue;
        setState('collapsed', paneId, { ...(state.collapsed[paneId] ?? {}), ...blocks });
      }
    });
    bumpPersistenceVersion();
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
    drawerOpen: Record<string, boolean>;
    drawerHeight: Record<string, number>;
  } => {
    // structuredClone CANNOT clone Proxy objects — it throws DataCloneError
    // unconditionally, and SolidJS store nodes are proxies. Cloning the
    // store state directly broke every workspace save from PR #299
    // (2026-05-08) until 2026-06-12 (~1k DataCloneError log lines per
    // active day). unwrap() first to get the raw underlying objects, THEN
    // structuredClone for a decoupled snapshot.
    const rawHistory = unwrap(state.navigationHistory);

    // Cap history entries on save (defense in depth, push already caps)
    const cappedHistory: Record<string, NavigationState> = {};
    for (const [paneId, historyState] of Object.entries(rawHistory)) {
      const entries = historyState.entries.slice(-DEFAULT_MAX_HISTORY_SIZE);
      cappedHistory[paneId] = {
        entries,
        currentIndex: Math.min(historyState.currentIndex, entries.length - 1),
      };
    }

    return {
      zoomedRootId: { ...state.zoomedRootId },
      collapsed: structuredClone(unwrap(state.collapsed)),
      // FLO-77: Include focused block IDs in persistence
      focusedBlockId: { ...state.focusedBlockId },
      // FLO-180: Include navigation history (capped)
      navigationHistory: structuredClone(cappedHistory),
      // FLO-440: Backlink drawer open/height (raw px, clamped on apply)
      drawerOpen: { ...state.drawerOpen },
      drawerHeight: { ...state.drawerHeight },
    };
  };

  // Ephemeral cursor position hints (not persisted, not reactive).
  // Set by navigate_up/down handlers, consumed by BlockItem focus effect.
  const focusCursorHints: Record<string, 'start' | 'end'> = {};

  const setFocusCursorHint = (paneId: string, hint: 'start' | 'end') => {
    focusCursorHints[paneId] = hint;
  };

  const consumeFocusCursorHint = (paneId: string): 'start' | 'end' | null => {
    const hint = focusCursorHints[paneId] ?? null;
    delete focusCursorHints[paneId];
    return hint;
  };

  return {
    persistenceVersion,
    toggleCollapsed,
    isCollapsed,
    setCollapsed,
    getZoomedRootId,
    setZoomedRoot,
    // FLO-77: Focused block tracking
    getFocusedBlockId,
    setFocusedBlockId,
    // Ephemeral cursor hints for navigation
    setFocusCursorHint,
    consumeFocusCursorHint,
    // FLO-180: Navigation history
    pushNavigation,
    goBack,
    goForward,
    canGoBack,
    canGoForward,
    // Unit 12.0: Full-width block mode
    toggleFullWidth,
    isFullWidth,
    // FLO-440: Backlink drawer view state
    isDrawerOpen,
    setDrawerOpen,
    getDrawerHeight,
    setDrawerHeight,
    // FLO-211: Unified navigation API
    zoomTo,
    // Pane navigation scope (floor) — general primitive, pin shelf first consumer
    getFloor,
    setFloor,
    setScope,
    consumeHistoryNavigation,
    // Clone state
    clonePaneState,
    // FLO-668: Host registry
    registerPane,
    getPaneHost,
    getTabHostedPaneIds,
    // Cleanup
    removePane,
    removePanes,
    // Persistence
    hydratePaneState,
    // FLO-83: additive view-state restore (layout presets)
    restorePaneViews,
    getPaneStateForPersistence,
  };
}

export const paneStore = createRoot(createPaneStore);
