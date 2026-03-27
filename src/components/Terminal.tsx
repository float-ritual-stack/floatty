import { createSignal, createEffect, createMemo, onCleanup, For, Show } from 'solid-js';
import { Key } from '@solid-primitives/keyed';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { invoke } from '@tauri-apps/api/core';
import { invoke as typedInvoke } from '../lib/tauriTypes';
import { PaneLayout } from './PaneLayout';
import { TerminalPane } from './TerminalPane';
import { OutlinerPane } from './OutlinerPane';
import { ResizeOverlay } from './ResizeOverlay';
import { SidebarDoorContainer } from './SidebarDoorContainer';
import Resizable from '@corvu/resizable';
import { tabStore } from '../hooks/useTabStore';
import type { Tab } from '../hooks/useTabStore';
import { layoutStore } from '../hooks/useLayoutStore';
import { themeStore } from '../hooks/useThemeStore';
import { getActionForEvent, isGlobalKeyAction, isTerminalReserved, getKeybindDisplay, isMac } from '../lib/keybinds';
import { CommandBar } from './CommandBar';
import { PaneLinkOverlay } from './PaneLinkOverlay';
import { paneLinkStore } from '../hooks/usePaneLinkStore';
import { paneStore } from '../hooks/usePaneStore';
import { navigateToPage, resolveSameTabLink } from '../lib/navigation';
import { emitCtxMarkersChanged } from '../lib/ctxEvents';
import type { FocusDirection, PaneLeaf, PaneHandle, PaneDropPosition } from '../lib/layoutTypes';
import { collectPaneIds, findNode } from '../lib/layoutTypes';
import { terminalManager } from '../lib/terminalManager';

// Zoom state
let currentZoom = 1.0;
const ZOOM_STEP = 0.1;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.0;

// Status bar with semantic state (FLO-54) + keyboard shortcuts
import type { SemanticState } from '../lib/terminalManager';
import { getSyncStatus, getPendingCount, getLastSyncError } from '../hooks/useSyncedYDoc';

interface PaneDropZone {
  targetPaneId: string;
  position: PaneDropPosition;
  rect: {
    left: number;
    top: number;
    width: number;
    height: number;
  };
}

interface PaneDropTarget {
  targetPaneId: string;
  position: PaneDropPosition;
}

interface PaneDropCandidate {
  targetPaneId: string;
  element: HTMLElement;
}

function StatusBar(props: { semanticState?: SemanticState | null }) {
  // Sync status for Y.Doc
  const syncStatus = getSyncStatus;
  const pendingCount = getPendingCount;
  // Use getKeybindDisplay for platform-aware shortcuts (⌘ on Mac, Ctrl on Windows/Linux)
  // Get modifier prefix from focusLeft, then append arrows (avoids broken replacement on Win/Linux)
  const focusMod = getKeybindDisplay('focusLeft')?.replace(/Left$/, '').replace(/ArrowLeft$/, '') || '⌘⌥';
  const zoomMod = getKeybindDisplay('zoomIn')?.replace(/[+=]$/, '') || '⌘';

  const shortcuts = [
    { label: 'Split', keys: getKeybindDisplay('splitHorizontal') || '⌘D' },
    { label: 'Focus', keys: `${focusMod}↑↓←→` },
    { label: 'Outliner', keys: getKeybindDisplay('splitHorizontalOutliner') || '⌘O' },
    { label: 'Theme', keys: getKeybindDisplay('nextTheme') || '⌘;' },
    { label: 'Zoom', keys: `${zoomMod}+/-` },
  ];

  const formatDuration = (ms: number) => {
    if (ms < 1000) return ms + 'ms';
    if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
    return (ms / 60000).toFixed(1) + 'm';
  };

  const truncatePath = (path: string) => {
    if (!path) return '';
    const homePath = path.replace(/^\/Users\/[^/]+/, '~');
    return homePath.length > 35 ? '…' + homePath.slice(-34) : homePath;
  };

  const truncateCommand = (cmd: string) => {
    if (!cmd) return '';
    // Show first 30 chars, add ellipsis if longer
    return cmd.length > 30 ? cmd.slice(0, 30) + '…' : cmd;
  };

  return (
    <footer class="status-bar" role="contentinfo">
      {/* Sync status indicator (leftmost) */}
      <span
        class="status-item status-sync"
        classList={{
          synced: syncStatus() === 'synced',
          pending: syncStatus() === 'pending',
          error: syncStatus() === 'error',
          drift: syncStatus() === 'drift',
        }}
        title={
          syncStatus() === 'error'
            ? getLastSyncError() || 'Sync error'
            : syncStatus() === 'drift'
            ? getLastSyncError() || 'Sync drift detected'
            : syncStatus() === 'pending'
            ? `${pendingCount()} update(s) pending`
            : 'All changes synced'
        }
        aria-live="polite"
      >
        <span class="status-dot" />
        <Show when={syncStatus() === 'pending'}>
          <span class="status-sync-count">{pendingCount()}</span>
        </Show>
        <Show when={syncStatus() === 'drift'}>
          <span class="status-sync-label">drift</span>
        </Show>
        <Show when={syncStatus() === 'error'}>
          <span class="status-sync-label">sync</span>
        </Show>
      </span>

      {/* Semantic state (left side) */}
      <span
        class="status-item status-hooks"
        classList={{ active: props.semanticState?.hooksActive }}
        title={props.semanticState?.hooksActive ? 'Shell hooks active' : 'No hooks detected'}
      >
        <span class="status-dot" />
        hooks
      </span>
      <Show when={props.semanticState?.cwd}>
        <span class="status-item status-cwd" title={props.semanticState?.cwd}>
          {truncatePath(props.semanticState?.cwd || '')}
        </span>
      </Show>
      <Show when={props.semanticState?.lastCommand}>
        <span
          class="status-item status-cmd"
          classList={{
            success: props.semanticState?.lastExitCode === 0,
            error: (props.semanticState?.lastExitCode || 0) !== 0,
          }}
          title={props.semanticState?.lastCommand}
        >
          {truncateCommand(props.semanticState?.lastCommand || '')}
          <Show when={props.semanticState?.lastDuration}>
            <span class="status-duration">
              {' '}({props.semanticState?.lastExitCode}) {formatDuration(props.semanticState?.lastDuration || 0)}
            </span>
          </Show>
        </span>
      </Show>

      {/* Diagnostics strip — toggled via Ctrl+Shift+D */}
      <Show when={themeStore.diagnosticsVisible()}>
        <span class="status-item status-diag-label">diagnostics</span>
        <span class="status-item status-diag-data">:{themeStore.serverPort()}</span>
        <span class="status-item status-diag-data">{themeStore.isDevBuild() ? 'debug' : 'release'}</span>
        <span class="status-item status-diag-data" title={themeStore.configPath()}>
          {truncatePath(themeStore.configPath())}
        </span>
      </Show>

      {/* Spacer */}
      <span style={{ flex: 1 }} />

      {/* Keyboard shortcuts (right side) */}
      <For each={shortcuts}>
        {(item) => (
          <span class="status-item">
            <span class="status-keys">{item.keys}</span>
            <span class="status-label">{item.label}</span>
          </span>
        )}
      </For>
    </footer>
  );
}

// Tab bar component
function TabBar(props: {
  tabs: Tab[];
  activeTabId: string | null;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onNewTab: () => void;
  getStickyState?: (tabId: string) => boolean;
}) {
  return (
    <nav class="tab-bar" role="navigation" aria-label="Terminal tabs">
      <div class="tab-list" role="tablist">
        <For each={props.tabs}>
          {(tab, index) => (
            <div
              class={`tab ${tab.id === props.activeTabId ? 'tab-active' : ''} ${!tab.isAlive ? 'tab-dead' : ''}`}
              onClick={() => props.onSelectTab(tab.id)}
            >
              <span class="tab-index">{index() + 1}</span>
              {/* FLO-220: Show indicator when not following output */}
              <Show when={props.getStickyState && !props.getStickyState(tab.id)}>
                <span class="tab-scroll-indicator" title="Scrolled up - press Cmd+Down to follow output">⇡</span>
              </Show>
              <span class="tab-title" title={tab.title}>
                {tab.title.length > 20 ? tab.title.slice(-20) : tab.title}
              </span>
              <Show when={props.tabs.length > 1}>
                <button
                  class="tab-close"
                  onClick={(e) => {
                    e.stopPropagation();
                    props.onCloseTab(tab.id);
                  }}
                  title={`Close tab (${getKeybindDisplay('closeTab') || 'Cmd+W'})`}
                  aria-label={`Close tab ${tab.title}`}
                >
                  ×
                </button>
              </Show>
            </div>
          )}
        </For>
      </div>
      <button
        class="tab-new"
        onClick={props.onNewTab}
        title={`New tab (${getKeybindDisplay('newTab') || 'Cmd+T'})`}
      >
        + New
      </button>
    </nav>
  );
}

export function Terminal() {
  const [sidebarVisible, setSidebarVisible] = createSignal(true);
  const [sidebarSide, setSidebarSide] = createSignal<'left' | 'right'>('right');
  const [sidebarWidth, setSidebarWidth] = createSignal<number | string>('280px');
  // Debounced save of sidebar width to config.toml (FLO-507)
  let sidebarSaveTimer: ReturnType<typeof setTimeout> | undefined;
  const saveSidebarWidth = (widthPx: number) => {
    clearTimeout(sidebarSaveTimer);
    sidebarSaveTimer = setTimeout(async () => {
      try {
        const config = await invoke<Record<string, unknown>>('get_ctx_config');
        await invoke('set_ctx_config', { config: { ...config, sidebar_width: Math.round(widthPx) } });
      } catch (e) {
        console.warn('[Terminal] Failed to save sidebar width:', e);
      }
    }, 500);
  };
  const [isCommandBarOpen, setCommandBarOpen] = createSignal(false);
  // Snapshot focused block + pane when ⌘K opens (focus moves to command bar input)
  let commandBarFocusedBlockId: string | null = null;
  let commandBarSourcePaneId: string | null = null;
  const [semanticState, setSemanticState] = createSignal<SemanticState | null>(null);
  // FLO-197: Collapse depth for split panes (loaded from config)
  const [splitCollapseDepth, setSplitCollapseDepth] = createSignal(0);
  // FLO-220: Track sticky scroll state per pane for UI indicator
  const [stickyState, setStickyState] = createSignal<Map<string, boolean>>(new Map());

  // Pane dimming state — config value cached for toggle
  let configDimOpacity = 0.4;
  const [dimEnabled, setDimEnabled] = createSignal(true);

  // Load config once on mount
  (async () => {
    try {
      const config = await invoke<{ split_collapse_depth?: number; unfocused_pane_opacity?: number; sidebar_width?: number }>('get_ctx_config');
      setSplitCollapseDepth(config.split_collapse_depth ?? 0);
      // Restore persisted sidebar width
      if (config.sidebar_width && config.sidebar_width > 0) {
        setSidebarWidth(`${config.sidebar_width}px`);
      }
      configDimOpacity = Math.max(0, Math.min(1, config.unfocused_pane_opacity ?? 0.4));
      // Disable dimming if config set to 1.0
      if (configDimOpacity >= 1) setDimEnabled(false);
      document.documentElement.style.setProperty('--unfocused-pane-opacity', dimEnabled() ? String(configDimOpacity) : '1');
    } catch (e) {
      console.warn('[Terminal] Failed to load config:', e);
    }
  })();

  function toggleDimming() {
    const next = !dimEnabled();
    setDimEnabled(next);
    document.documentElement.style.setProperty('--unfocused-pane-opacity', next ? String(configDimOpacity) : '1');
  }

  // Pane refs for imperative control
  const paneRefs = new Map<string, PaneHandle>();

  // Register a pane ref
  const setPaneRef = (id: string, handle: PaneHandle | null) => {
    if (handle) {
      paneRefs.set(id, handle);
    } else {
      paneRefs.delete(id);
    }
  };

  // Derived getters using layout store (uses shared helpers from layoutTypes.ts)
  const getLayout = (tabId: string) => layoutStore.layouts[tabId]?.root ?? null;
  const getActivePaneId = (tabId: string) => layoutStore.layouts[tabId]?.activePaneId ?? null;
  const getAllPaneIds = (tabId: string) => {
    const layout = layoutStore.layouts[tabId];
    if (!layout) return [];
    return collectPaneIds(layout.root);
  };
  const getPaneLeaf = (tabId: string, paneId: string): PaneLeaf | null => {
    const layout = layoutStore.layouts[tabId];
    if (!layout) return null;
    const node = findNode(layout.root, paneId);
    return node?.type === 'leaf' ? node : null;
  };

  // Resolve first outliner pane in active tab — shared by CommandBar and sidebar
  const resolvedOutlinerPaneId = createMemo(() => {
    const activeId = tabStore.activeTabId();
    if (!activeId) return null;
    // Prefer active pane if it's an outliner, otherwise find first outliner
    let paneId = getActivePaneId(activeId);
    if (paneId) {
      const leaf = getPaneLeaf(activeId, paneId);
      if (leaf?.leafType !== 'outliner') {
        const allPanes = getAllPaneIds(activeId);
        paneId = allPanes.find(id => {
          const l = getPaneLeaf(activeId, id);
          return l?.leafType === 'outliner';
        }) ?? paneId;
      }
    }
    return paneId;
  });

  // FLO-136: Pin ephemeral pane (make permanent)
  const pinPane = (tabId: string, paneId: string) => {
    return layoutStore.pinPane(tabId, paneId);
  };

  // Pane drag-and-drop state (rearrange splits by dropping relative to a target pane)
  const [draggingPaneId, setDraggingPaneId] = createSignal<string | null>(null);
  const [draggingTabId, setDraggingTabId] = createSignal<string | null>(null);
  const [paneDropZones, setPaneDropZones] = createSignal<PaneDropZone[]>([]);
  const [activeDropTarget, setActiveDropTarget] = createSignal<PaneDropTarget | null>(null);

  let lastDragPointer: { x: number; y: number } | null = null;
  let paneDropCandidates: PaneDropCandidate[] = [];
  let paneDragSessionCounter = 0;
  let activePaneDragSessionId: number | null = null;
  let finishedPaneDragSessionId: number | null = null;
  let paneDragPointerCapture: { target: Element; pointerId: number } | null = null;
  let paneDragZoneRecomputeRafId: number | null = null;
  let paneDragMoveListener: ((e: PointerEvent) => void) | null = null;
  let paneDragEndListener: ((e: PointerEvent) => void) | null = null;
  let paneDragCancelListener: (() => void) | null = null;
  let paneDragResizeListener: (() => void) | null = null;
  let paneDragKeydownListener: ((e: KeyboardEvent) => void) | null = null;

  const fitAndFocusWhenPaneRefsReady = (tabId: string, focusPaneId: string) => {
    const MAX_FRAME_RETRIES = 12;
    let attempts = 0;

    const applyFitAndFocus = () => {
      const paneIds = getAllPaneIds(tabId);
      const allRefsReady = paneIds.every((paneId) => paneRefs.has(paneId));
      const focusHandle = paneRefs.get(focusPaneId);

      if ((!allRefsReady || !focusHandle) && attempts < MAX_FRAME_RETRIES) {
        attempts += 1;
        requestAnimationFrame(applyFitAndFocus);
        return;
      }

      if (attempts >= MAX_FRAME_RETRIES) {
        console.warn(`[Terminal] fitAndFocusWhenPaneRefsReady exhausted ${MAX_FRAME_RETRIES} frames — refs still missing, proceeding best-effort`);
      }

      for (const paneId of paneIds) {
        paneRefs.get(paneId)?.fit();
      }
      focusHandle?.focus();
    };

    requestAnimationFrame(applyFitAndFocus);
  };

  const releasePaneDragPointerCapture = () => {
    if (!paneDragPointerCapture) return;
    const { target, pointerId } = paneDragPointerCapture;
    paneDragPointerCapture = null;

    try {
      if (target.hasPointerCapture(pointerId)) {
        target.releasePointerCapture(pointerId);
      }
    } catch {
      // Best effort cleanup: the element may already be detached.
    }
  };

  const detachPaneDragListeners = () => {
    if (paneDragMoveListener) {
      window.removeEventListener('pointermove', paneDragMoveListener);
      paneDragMoveListener = null;
    }
    if (paneDragEndListener) {
      window.removeEventListener('pointerup', paneDragEndListener);
      paneDragEndListener = null;
    }
    if (paneDragCancelListener) {
      window.removeEventListener('pointercancel', paneDragCancelListener);
      window.removeEventListener('blur', paneDragCancelListener);
      paneDragCancelListener = null;
    }
    if (paneDragResizeListener) {
      window.removeEventListener('resize', paneDragResizeListener);
      paneDragResizeListener = null;
    }
    if (paneDragKeydownListener) {
      window.removeEventListener('keydown', paneDragKeydownListener, true);
      paneDragKeydownListener = null;
    }
  };

  const clearPaneDragState = () => {
    detachPaneDragListeners();
    releasePaneDragPointerCapture();
    if (paneDragZoneRecomputeRafId !== null) {
      cancelAnimationFrame(paneDragZoneRecomputeRafId);
      paneDragZoneRecomputeRafId = null;
    }
    activePaneDragSessionId = null;
    paneDropCandidates = [];
    lastDragPointer = null;
    setDraggingPaneId(null);
    setDraggingTabId(null);
    setPaneDropZones([]);
    setActiveDropTarget(null);
    document.body.classList.remove('pane-dragging');
  };

  const collectPaneDropCandidates = (tabId: string, sourcePaneId: string): PaneDropCandidate[] => {
    return getAllPaneIds(tabId)
      .filter((paneId) => paneId !== sourcePaneId)
      .flatMap((paneId) => {
        const placeholder = document.querySelector(`[data-pane-id="${paneId}"]`) as HTMLElement | null;
        if (!placeholder) return [];
        return [{ targetPaneId: paneId, element: placeholder }];
      });
  };

  const computePaneDropZones = (candidates: PaneDropCandidate[]): PaneDropZone[] => {
    const EDGE_ZONE_SIZE = 44;
    const MIN_EDGE_ZONE_SIZE = 16;
    const OUTER_ZONE_WIDTH = 20;

    const perPaneZones = candidates.flatMap((candidate) => {
      if (!candidate.element.isConnected) return [];

      const rect = candidate.element.getBoundingClientRect();
      if (rect.width < 8 || rect.height < 8) return [];

      const edge = Math.max(
        MIN_EDGE_ZONE_SIZE,
        Math.min(EDGE_ZONE_SIZE, Math.floor(Math.min(rect.width, rect.height) * 0.28))
      );

      const topBottomWidth = Math.max(0, rect.width - edge * 2);
      const topBottomLeft = topBottomWidth > 0 ? rect.left + edge : rect.left;
      const upDownRect = {
        left: topBottomLeft,
        width: topBottomWidth > 0 ? topBottomWidth : rect.width,
      };

      return [
        {
          targetPaneId: candidate.targetPaneId,
          position: 'left' as const,
          rect: { left: rect.left, top: rect.top, width: edge, height: rect.height },
        },
        {
          targetPaneId: candidate.targetPaneId,
          position: 'right' as const,
          rect: { left: rect.right - edge, top: rect.top, width: edge, height: rect.height },
        },
        {
          targetPaneId: candidate.targetPaneId,
          position: 'up' as const,
          rect: { left: upDownRect.left, top: rect.top, width: upDownRect.width, height: edge },
        },
        {
          targetPaneId: candidate.targetPaneId,
          position: 'down' as const,
          rect: { left: upDownRect.left, top: rect.bottom - edge, width: upDownRect.width, height: edge },
        },
      ];
    });

    // Outer edge zones: full-height left/right strips along the layout root.
    // Only when 2+ panes exist (need at least 2 for the source to have somewhere to go).
    const outerZones: PaneDropZone[] = [];
    const layoutRoot = document.querySelector('.pane-layout-root') as HTMLElement | null;
    if (layoutRoot && candidates.length > 0) {
      const rootRect = layoutRoot.getBoundingClientRect();
      outerZones.push(
        {
          targetPaneId: '__outer_left',
          position: 'left' as const,
          rect: { left: rootRect.left, top: rootRect.top, width: OUTER_ZONE_WIDTH, height: rootRect.height },
        },
        {
          targetPaneId: '__outer_right',
          position: 'right' as const,
          rect: { left: rootRect.right - OUTER_ZONE_WIDTH, top: rootRect.top, width: OUTER_ZONE_WIDTH, height: rootRect.height },
        },
      );
    }

    // Outer zones prepended so zones.find() checks them first — outer wins at edge.
    return [...outerZones, ...perPaneZones];
  };

  const schedulePaneDropZoneRecompute = () => {
    if (paneDragZoneRecomputeRafId !== null) return;

    paneDragZoneRecomputeRafId = requestAnimationFrame(() => {
      paneDragZoneRecomputeRafId = null;
      paneDropCandidates = paneDropCandidates.filter((candidate) => candidate.element.isConnected);
      const zones = computePaneDropZones(paneDropCandidates);
      setPaneDropZones(zones);

      if (lastDragPointer) {
        setActiveDropTarget(hitTestPaneDropTarget(lastDragPointer.x, lastDragPointer.y, zones));
      } else {
        setActiveDropTarget(null);
      }
    });
  };

  const hitTestPaneDropTarget = (
    clientX: number,
    clientY: number,
    zones: PaneDropZone[] = paneDropZones()
  ): PaneDropTarget | null => {
    // Left/right zones are emitted before up/down in computePaneDropZones,
    // so horizontal splits win at corner overlaps (intentional UX default).
    const zone = zones.find((candidate) => {
      const { left, top, width, height } = candidate.rect;
      return (
        clientX >= left
        && clientX <= left + width
        && clientY >= top
        && clientY <= top + height
      );
    });

    if (!zone) return null;
    return {
      targetPaneId: zone.targetPaneId,
      position: zone.position,
    };
  };

  const dropPositionGlyph = (position: PaneDropPosition, isOuter: boolean = false): string => {
    if (position === 'left') return isOuter ? '⇐' : '←';
    if (position === 'right') return isOuter ? '⇒' : '→';
    if (position === 'up') return '↑';
    return '↓';
  };

  const finishPaneDrag = (commitDrop: boolean, dropTarget: PaneDropTarget | null = null) => {
    const sessionId = activePaneDragSessionId;
    if (sessionId === null) return;
    if (finishedPaneDragSessionId === sessionId) return;
    finishedPaneDragSessionId = sessionId;

    const tabId = draggingTabId();
    const sourcePaneId = draggingPaneId();
    const target = dropTarget ?? activeDropTarget();
    clearPaneDragState();

    if (!commitDrop || !tabId || !sourcePaneId || !target) return;

    let moved: boolean;
    if (target.targetPaneId.startsWith('__outer_')) {
      const rootPosition = target.targetPaneId === '__outer_left' ? 'left' as const : 'right' as const;
      moved = layoutStore.movePaneToRoot(tabId, sourcePaneId, rootPosition);
    } else {
      moved = layoutStore.movePane(tabId, sourcePaneId, target.targetPaneId, target.position);
    }
    if (!moved) return;

    fitAndFocusWhenPaneRefsReady(tabId, sourcePaneId);
  };

  const handlePaneDragStart = (paneId: string, event: PointerEvent) => {
    const tabId = tabStore.activeTabId();
    if (!tabId) return;

    event.preventDefault();
    event.stopPropagation();

    const candidates = collectPaneDropCandidates(tabId, paneId);
    const zones = computePaneDropZones(candidates);
    if (zones.length === 0) return; // Can't drag when no other pane exists in tab

    clearPaneDragState();
    const sessionId = ++paneDragSessionCounter;
    activePaneDragSessionId = sessionId;
    finishedPaneDragSessionId = null;
    const captureTarget = event.currentTarget;
    if (captureTarget instanceof Element) {
      try {
        captureTarget.setPointerCapture(event.pointerId);
        paneDragPointerCapture = { target: captureTarget, pointerId: event.pointerId };
      } catch {
        paneDragPointerCapture = null;
      }
    }

    setDraggingPaneId(paneId);
    setDraggingTabId(tabId);
    paneDropCandidates = candidates;
    setPaneDropZones(zones);
    setActiveDropTarget(null);
    lastDragPointer = { x: event.clientX, y: event.clientY };
    layoutStore.setActivePaneId(tabId, paneId);
    document.body.classList.add('pane-dragging');

    paneDragMoveListener = (moveEvent: PointerEvent) => {
      if (activePaneDragSessionId !== sessionId) return;
      moveEvent.preventDefault();
      lastDragPointer = { x: moveEvent.clientX, y: moveEvent.clientY };
      setActiveDropTarget(hitTestPaneDropTarget(moveEvent.clientX, moveEvent.clientY));
    };
    paneDragEndListener = (upEvent: PointerEvent) => {
      if (activePaneDragSessionId !== sessionId) return;
      const target = hitTestPaneDropTarget(upEvent.clientX, upEvent.clientY);
      setActiveDropTarget(target);
      finishPaneDrag(true, target);
    };
    paneDragCancelListener = () => {
      if (activePaneDragSessionId !== sessionId) return;
      finishPaneDrag(false);
    };
    paneDragResizeListener = () => {
      if (activePaneDragSessionId !== sessionId) return;
      schedulePaneDropZoneRecompute();
    };
    paneDragKeydownListener = (keydownEvent: KeyboardEvent) => {
      if (activePaneDragSessionId !== sessionId) return;
      if (keydownEvent.key !== 'Escape') return;
      keydownEvent.preventDefault();
      keydownEvent.stopPropagation();
      finishPaneDrag(false);
    };

    window.addEventListener('pointermove', paneDragMoveListener, { passive: false });
    window.addEventListener('pointerup', paneDragEndListener);
    window.addEventListener('pointercancel', paneDragCancelListener);
    window.addEventListener('blur', paneDragCancelListener);
    window.addEventListener('resize', paneDragResizeListener);
    window.addEventListener('keydown', paneDragKeydownListener, true);
  };

  // Helper to split pane and handle post-split fitting/focusing
  const handleSplit = (direction: 'horizontal' | 'vertical', leafType?: 'terminal' | 'outliner') => {
    const activeId = tabStore.activeTabId();
    if (!activeId) {
      console.warn('[Terminal] Split failed: no active tab');
      return;
    }

    // FLO-197: Pass collapse depth for outliner panes (0 = disabled)
    const collapseDepth = leafType === 'outliner' ? splitCollapseDepth() : undefined;
    const newPaneId = layoutStore.splitPane(activeId, direction, leafType, false, collapseDepth);
    if (newPaneId) {
      requestAnimationFrame(() => {
        setTimeout(() => {
          const paneIds = getAllPaneIds(activeId);
          for (const paneId of paneIds) {
            paneRefs.get(paneId)?.fit();
          }
          paneRefs.get(newPaneId)?.focus();
        }, 100);
      });
    } else {
      // Split failed - log for debugging (user sees no visual change, which is feedback enough)
      console.warn('[Terminal] Split operation failed for tab:', activeId);
    }
  };

  // Initialize layout for tabs that don't have one
  createEffect(() => {
    for (const tab of tabStore.tabs) {
      if (!getLayout(tab.id)) {
        layoutStore.initLayout(tab.id);
      }
    }
  });

  // Handle creating a new tab - layout is initialized by the createEffect above
  const handleNewTab = (cwd?: string) => {
    const tabId = tabStore.createTab(cwd);
    // NOTE: Don't call layoutStore.initLayout here - the createEffect handles it
    // Calling it here caused double-pane creation (2 terminals per tab)
    return tabId;
  };

  // Handle closing a tab - dispose all panes then tab
  const handleCloseTab = async (id: string) => {
    // Get all pane IDs in this tab's layout
    const paneIds = getAllPaneIds(id);
    console.log(`[Terminal] handleCloseTab(${id}) - found ${paneIds.length} panes:`, paneIds);
    const failedDisposals: string[] = [];

    // Dispose each terminal
    for (const paneId of paneIds) {
      try {
        await terminalManager.dispose(paneId);
      } catch (e) {
        console.error(`[Terminal] Failed to dispose pane ${paneId}:`, e);
        failedDisposals.push(paneId);
      }
    }

    if (failedDisposals.length > 0) {
      console.warn(`[Terminal] ${failedDisposals.length} panes failed to dispose for tab ${id}`);
    }

    // Close tab FIRST, then remove layout
    // Order matters: createEffect watches tabs and creates layouts for tabs without layouts
    // If we remove layout before tab, the effect sees "tab exists, no layout" and re-creates one
    tabStore.closeTab(id);
    layoutStore.removeLayout(id);
  };

  // Handle closing a single pane (not entire tab)
  const handleClosePane = async (tabId: string) => {
    const paneId = getActivePaneId(tabId);
    if (!paneId) return;

    // Check if this is the last pane in the tab
    const paneIds = getAllPaneIds(tabId);
    if (paneIds.length <= 1) {
      // Last pane - close the entire tab
      await handleCloseTab(tabId);
      return;
    }

    // Dispose the terminal
    await terminalManager.dispose(paneId);

    // Update layout (collapses tree)
    layoutStore.closePane(tabId, paneId);
  };

  // Keyboard shortcuts - using keybind system
  createEffect(() => {
    const handleKeydown = (e: KeyboardEvent) => {
      // Never intercept terminal-reserved keys (Ctrl+C, Ctrl+Z, etc.)
      if (isTerminalReserved(e)) {
        return;
      }

      const action = getActionForEvent(e);

      // Debug: log all keyboard events with modifiers to trace sporadic failures
      if (e.metaKey || e.ctrlKey) {
        console.log('[Keybind] key:', e.key, 'meta:', e.metaKey, 'ctrl:', e.ctrlKey, 'shift:', e.shiftKey, 'action:', action);
      }

      // Cmd+L — link active terminal pane to an outliner pane.
      // Handled here (before the action guard) because it's not in the keybind registry.
      // Outliners handle their own Cmd+L guarded by activePaneId check — no double-fire.
      {
        const isCmdL = isMac
          ? (e.metaKey && !e.shiftKey && !e.altKey && e.key === 'l')
          : (e.ctrlKey && !e.shiftKey && !e.altKey && e.key === 'l');
        if (isCmdL) {
          e.preventDefault();
          e.stopPropagation();
          const activeId = tabStore.activeTabId();
          if (activeId) {
            const activePaneId = getActivePaneId(activeId);
            if (activePaneId) {
              paneLinkStore.startLinking(activePaneId);
            }
          }
          return;
        }
      }

      if (!action) return;
      if (!isGlobalKeyAction(action)) return;

      e.preventDefault();

      const activeId = tabStore.activeTabId();

      // Debug: warn if activeId is missing when needed
      if ((action === 'closeTab' || action === 'closeSplit') && !activeId) {
        console.warn('[Keybind] action', action, 'but activeId is null!');
      }

      switch (action) {
        case 'newTab':
          handleNewTab();
          break;
        case 'closeTab':
          if (activeId) {
            handleCloseTab(activeId).catch(e =>
              console.error('[Terminal] closeTab shortcut failed:', e)
            );
          }
          break;
        case 'prevTab':
          tabStore.prevTab();
          break;
        case 'nextTab':
          tabStore.nextTab();
          break;
        case 'goToTab1':
        case 'goToTab2':
        case 'goToTab3':
        case 'goToTab4':
        case 'goToTab5':
        case 'goToTab6':
        case 'goToTab7':
        case 'goToTab8':
        case 'goToTab9':
          tabStore.goToTab(parseInt(action.replace('goToTab', ''), 10));
          break;
        case 'toggleSidebar':
          setSidebarVisible((v) => !v);
          // onSizesChange won't fire when <Show> unmounts/mounts the panel,
          // so refit terminals explicitly after DOM settles
          requestAnimationFrame(() => {
            setTimeout(() => {
              const currentActiveId = tabStore.activeTabId();
              if (currentActiveId) {
                const paneIds = getAllPaneIds(currentActiveId);
                for (const paneId of paneIds) {
                  paneRefs.get(paneId)?.fit();
                }
              }
            }, 50);
          });
          break;
        // Split management
        case 'splitHorizontal':
          handleSplit('horizontal');
          break;
        case 'splitVertical':
          handleSplit('vertical');
          break;
        case 'splitHorizontalOutliner':
          handleSplit('horizontal', 'outliner');
          break;
        case 'splitVerticalOutliner':
          handleSplit('vertical', 'outliner');
          break;
        case 'closeSplit':
          if (activeId) {
            handleClosePane(activeId).catch(e =>
              console.error('[Terminal] closeSplit shortcut failed:', e)
            );
          }
          break;
        case 'focusLeft':
        case 'focusRight':
        case 'focusUp':
        case 'focusDown': {
          if (activeId) {
            const direction = action.replace('focus', '').toLowerCase() as FocusDirection;
            const newPaneId = layoutStore.focusDirection(activeId, direction);
            // Focus the newly active pane (use returned ID, not stale closure)
            if (newPaneId) {
              requestAnimationFrame(() => {
                paneRefs.get(newPaneId)?.focus();
              });
            }
          }
          break;
        }
        case 'zoomIn': {
          currentZoom = Math.min(ZOOM_MAX, currentZoom + ZOOM_STEP);
          getCurrentWebviewWindow().setZoom(currentZoom).catch(console.error);
          break;
        }
        case 'zoomOut': {
          currentZoom = Math.max(ZOOM_MIN, currentZoom - ZOOM_STEP);
          getCurrentWebviewWindow().setZoom(currentZoom).catch(console.error);
          break;
        }
        case 'zoomReset': {
          currentZoom = 1.0;
          getCurrentWebviewWindow().setZoom(currentZoom).catch(console.error);
          break;
        }
        case 'togglePanel': {
          invoke('toggle_test_panel').catch((err) => {
            console.error('[Terminal] Failed to toggle panel:', err);
          });
          break;
        }
        case 'nextTheme': {
          themeStore.nextTheme();
          break;
        }
        case 'toggleDevVisuals': {
          typedInvoke('toggle_diagnostics', {}).then((newValue) => {
            themeStore.setDiagnostics(newValue);
          }).catch((err) => {
            console.error('[Terminal] Failed to toggle diagnostics:', err);
          });
          break;
        }
        case 'commandPalette': {
          // Snapshot focused block + pane BEFORE command bar steals focus
          if (!isCommandBarOpen()) {
            if (activeId) {
              const ap = getActivePaneId(activeId);
              commandBarFocusedBlockId = ap ? paneStore.getFocusedBlockId(ap) : null;
              commandBarSourcePaneId = ap ?? null;
            } else {
              commandBarFocusedBlockId = null;
              commandBarSourcePaneId = null;
            }
          }
          setCommandBarOpen(open => !open);
          break;
        }
        case 'focusPane': {
          if (activeId) {
            const activePaneId = getActivePaneId(activeId);
            if (activePaneId) {
              paneLinkStore.startFocusing(activePaneId);
            }
          }
          break;
        }
      }

    };

    window.addEventListener('keydown', handleKeydown, true);
    onCleanup(() => window.removeEventListener('keydown', handleKeydown, true));
  });

  // Focus active pane when tab changes
  createEffect(() => {
    const activeId = tabStore.activeTabId();
    if (activeId) {
      const activePaneId = getActivePaneId(activeId);
      if (activePaneId) {
        // Refit all panes in the tab, then focus the active one
        requestAnimationFrame(() => {
          const paneIds = getAllPaneIds(activeId);
          for (const paneId of paneIds) {
            paneRefs.get(paneId)?.fit();
          }
          setTimeout(() => {
            const pane = paneRefs.get(activePaneId);
            pane?.refresh();
            pane?.focus();
          }, 50);
        });
      }
    }
  });

  // Highlight linked pane partner when active pane has a link (bidirectional)
  createEffect(() => {
    const activeId = tabStore.activeTabId();
    if (!activeId) return;
    const activePaneId = getActivePaneId(activeId);
    // Forward: active pane links TO a target
    const forwardTarget = activePaneId ? paneLinkStore.getLinkedPaneForPane(activePaneId) : null;
    // Reverse: ALL panes that link TO the active pane (many→one supported)
    const reverseSources = activePaneId ? paneLinkStore.getSourcePanesFor(activePaneId) : [];

    // Clear previous tint
    document.querySelectorAll('.pane-link-target').forEach(el => el.classList.remove('pane-link-target'));

    const partnersToTint = [forwardTarget, ...reverseSources].filter(Boolean) as string[];
    for (const paneId of partnersToTint) {
      if (paneId === activePaneId) continue; // Don't tint self
      const outlinerEl = document.querySelector(`.outliner-container[data-pane-id="${CSS.escape(paneId)}"]`);
      const wrapper = outlinerEl?.closest('.terminal-pane-positioned')
        ?? document.querySelector(`.terminal-pane-positioned[data-terminal-id="${CSS.escape(paneId)}"]`);
      wrapper?.classList.add('pane-link-target');
    }
  });

  // Callbacks for TerminalPane
  const handlePtySpawn = (paneId: string, pid: number) => {
    // For now, track on the tab level (first pane's pid wins)
    const tab = tabStore.tabs.find(t => getAllPaneIds(t.id).includes(paneId));
    if (tab && !tab.ptyPid) {
      tabStore.setTabPtyPid(tab.id, pid);
    }
  };

  const handlePtyExit = async (paneId: string) => {
    try {
      // Find which tab this pane belongs to
      const tab = tabStore.tabs.find(t => getAllPaneIds(t.id).includes(paneId));
      if (!tab) {
        console.warn(`[Terminal] PTY exit for orphaned pane: ${paneId}`);
        return;
      }

      const paneIds = getAllPaneIds(tab.id);

      if (paneIds.length <= 1) {
        // Last pane in tab - close the entire tab
        await handleCloseTab(tab.id);
      } else {
        // Multiple panes - just close this one and collapse tree
        await terminalManager.dispose(paneId);
        layoutStore.closePane(tab.id, paneId);
      }
    } catch (e) {
      console.error(`[Terminal] Failed to handle PTY exit for ${paneId}:`, e);
    }
  };

  const handleTitleChange = (paneId: string, title: string) => {
    // Update tab title from active pane
    const tab = tabStore.tabs.find(t => getActivePaneId(t.id) === paneId);
    if (tab) {
      tabStore.setTabTitle(tab.id, title);
    }
  };

  // FLO-220: Track sticky scroll state per pane
  const handleStickyChange = (paneId: string, sticky: boolean) => {
    setStickyState(prev => {
      const next = new Map(prev);
      next.set(paneId, sticky);
      return next;
    });
  };

  // FLO-220: Get sticky state for active pane of a tab
  const getTabStickyState = (tabId: string): boolean => {
    const activePaneId = getActivePaneId(tabId);
    if (!activePaneId) return true;  // Default to sticky
    return stickyState().get(activePaneId) ?? true;
  };

  const handlePaneClick = (paneId: string) => {
    const activeId = tabStore.activeTabId();
    if (activeId) {
      layoutStore.setActivePaneId(activeId, paneId);
      const pane = paneRefs.get(paneId);
      pane?.fit();
      // FLO-197: Only auto-focus terminal panes, not outliners
      // For outliners, BlockItem's onClick already handles focus.
      // Calling pane.focus() for outliners causes a race: it focuses the first block,
      // then the block click focuses the correct block, creating a flash.
      const leaf = getPaneLeaf(activeId, paneId);
      if (leaf?.leafType === 'terminal') {
        pane?.focus();
      }
    }
  };

  // Cancel in-flight pane drag if active tab changes
  createEffect(() => {
    const dragTab = draggingTabId();
    const activeTab = tabStore.activeTabId();
    if (dragTab && activeTab && dragTab !== activeTab) {
      finishPaneDrag(false);
    }
  });

  // Collect all pane info across all tabs for terminal layer (memoized for performance)
  const allPaneInfo = createMemo(() => {
    const activeId = tabStore.activeTabId();
    return tabStore.tabs.flatMap(tab => {
      const paneIds = getAllPaneIds(tab.id);
      const activePaneId = getActivePaneId(tab.id);
      return paneIds.map(paneId => {
        const leaf = getPaneLeaf(tab.id, paneId);
        return {
          paneId,
          tabId: tab.id,
          cwd: leaf?.cwd,
          leafType: leaf?.leafType || 'terminal',
          // FLO-77: Pass initialScrollTop for cloned outliner panes
          initialScrollTop: leaf?.initialScrollTop,
          // FLO-197: Pass initialCollapseDepth for split panes
          initialCollapseDepth: leaf?.initialCollapseDepth,
          // FLO-136: Ephemeral pane flag for preview mode
          ephemeral: leaf?.ephemeral ?? false,
          // tmux session for auto-reattach (per-pane, persisted in layout tree)
          tmuxSession: leaf?.tmuxSession,
          isActivePane: paneId === activePaneId,
          isActiveTab: tab.id === activeId,
        };
      });
    });
  });

  // FLO-136: Auto-pin ephemeral panes after timeout (5 seconds)
  const EPHEMERAL_TIMEOUT_MS = 5000;
  const ephemeralTimers = new Map<string, ReturnType<typeof setTimeout>>();

  createEffect(() => {
    const infos = allPaneInfo();
    const currentEphemeralIds = new Set<string>();

    // Set up timers for ephemeral panes
    for (const info of infos) {
      if (info.ephemeral) {
        currentEphemeralIds.add(info.paneId);
        // Only create timer if not already tracking
        if (!ephemeralTimers.has(info.paneId)) {
          const timer = setTimeout(() => {
            console.debug(`[Terminal] Auto-pinning ephemeral pane ${info.paneId} after ${EPHEMERAL_TIMEOUT_MS}ms`);
            pinPane(info.tabId, info.paneId);
            ephemeralTimers.delete(info.paneId);
          }, EPHEMERAL_TIMEOUT_MS);
          ephemeralTimers.set(info.paneId, timer);
        }
      }
    }

    // Clean up timers for panes that are no longer ephemeral
    for (const [paneId, timer] of ephemeralTimers.entries()) {
      if (!currentEphemeralIds.has(paneId)) {
        clearTimeout(timer);
        ephemeralTimers.delete(paneId);
      }
    }
  });

  // Cleanup all timers on unmount
  onCleanup(() => {
    clearPaneDragState();
    for (const timer of ephemeralTimers.values()) {
      clearTimeout(timer);
    }
    ephemeralTimers.clear();
  });

  return (
    <div class="terminal-root">
      <TabBar
        tabs={tabStore.tabs}
        activeTabId={tabStore.activeTabId()}
        onSelectTab={tabStore.setActiveTab}
        onCloseTab={handleCloseTab}
        onNewTab={() => handleNewTab()}
        getStickyState={getTabStickyState}
      />
      <div class="terminal-wrapper">
      <Resizable
        orientation="horizontal"
        style={{ display: 'flex', width: '100%', height: '100%' }}
        onSizesChange={(sizes) => {
          // Persist sidebar width across side swaps + save to config (FLO-507)
          // Corvu sizes are fractions (0-1) — convert to pixels for persistence
          const sideIdx = sidebarSide() === 'left' ? 0 : sizes.length - 1;
          if (sidebarVisible() && sizes[sideIdx] > 0) {
            const containerWidth = document.querySelector('.terminal-wrapper')?.clientWidth ?? 0;
            const widthPx = Math.round(sizes[sideIdx] * containerWidth);
            if (widthPx > 50) {
              setSidebarWidth(`${widthPx}px`);
              saveSidebarWidth(widthPx);
            }
          }
          // Refit all visible terminals when sidebar resizes
          requestAnimationFrame(() => {
            const currentActiveId = tabStore.activeTabId();
            if (currentActiveId) {
              const paneIds = getAllPaneIds(currentActiveId);
              for (const paneId of paneIds) {
                paneRefs.get(paneId)?.fit();
              }
            }
          });
        }}
      >
        {/* Sidebar on left side */}
        <Show when={sidebarVisible() && sidebarSide() === 'left'}>
          <Resizable.Panel
            class="sidebar-panel-wrapper sidebar-left"
            minSize={'200px'}
            initialSize={sidebarWidth()}
            collapsible
            collapsedSize={0}
            collapseThreshold={'50px'}
            style={{ 'max-width': '40vw' }}
          >
            <SidebarDoorContainer
              visible={sidebarVisible()}
              getOutlinerPaneId={() => resolvedOutlinerPaneId()}
            />
          </Resizable.Panel>
          <Resizable.Handle class="sidebar-resize-handle" aria-label="Resize sidebar" />
        </Show>
        <Resizable.Panel class="terminal-container" as="main" role="main" minSize={0.3}>
          {/* Layout layer - just placeholder divs */}
          <For each={tabStore.tabs}>
            {(tab) => {
              const layout = () => getLayout(tab.id);
              const activePaneId = () => getActivePaneId(tab.id);

              return (
                <Show when={layout() && activePaneId()}>
                  <div
                    class={`terminal-pane-wrapper ${tab.id === tabStore.activeTabId() ? 'pane-active' : 'pane-hidden'}`}
                  >
                    <PaneLayout
                      tabId={tab.id}
                      node={layout()!}
                      activePaneId={activePaneId()!}
                      onPaneClick={handlePaneClick}
                    />
                  </div>
                </Show>
              );
            }}
          </For>

          {/* Terminal layer - absolutely positioned over placeholders */}
          {/* These components NEVER unmount during layout changes! */}
          {/* Using <Key> for stable identity - SolidJS <For> uses object reference, not property */}
          <Key each={allPaneInfo()} by={(info) => info.paneId}>
            {(info) => (
              <Show
                when={info().leafType === 'terminal'}
                fallback={
                  <OutlinerPane
                    id={info().paneId}
                    placeholderId={info().paneId}
                    isActive={info().isActivePane && info().isActiveTab}
                    isVisible={info().isActiveTab}
                    initialScrollTop={info().initialScrollTop}
                    initialCollapseDepth={info().initialCollapseDepth}
                    ref={(handle) => setPaneRef(info().paneId, handle)}
                    onPaneClick={() => handlePaneClick(info().paneId)}
                    onDragHandlePointerDown={(e) => handlePaneDragStart(info().paneId, e)}
                    isBeingDragged={draggingTabId() === info().tabId && draggingPaneId() === info().paneId}
                  />
                }
              >
                <TerminalPane
                  id={info().paneId}
                  cwd={info().cwd}
                  tmuxSession={info().tmuxSession}
                  placeholderId={info().paneId}
                  isActive={info().isActivePane && info().isActiveTab}
                  isVisible={info().isActiveTab}
                  ref={(handle) => setPaneRef(info().paneId, handle)}
                  onPaneClick={() => handlePaneClick(info().paneId)}
                  onDragHandlePointerDown={(e) => handlePaneDragStart(info().paneId, e)}
                  isBeingDragged={draggingTabId() === info().tabId && draggingPaneId() === info().paneId}
                  onPtySpawn={(pid) => handlePtySpawn(info().paneId, pid)}
                  onPtyExit={() => handlePtyExit(info().paneId).catch(e =>
                    console.error(`[Terminal] Unhandled error in handlePtyExit:`, e)
                  )}
                  onTitleChange={(title) => handleTitleChange(info().paneId, title)}
                  onSemanticStateChange={(state) => {
                    const i = info();
                    const s = state as SemanticState;
                    // Bubble tmux session to pane in layout store (per-pane persistence)
                    if (s.tmuxSession !== undefined) {
                      layoutStore.setPaneTmuxSession(i.tabId, i.paneId, s.tmuxSession);
                    }
                    // Only update status bar for active pane
                    if (i.isActivePane && i.isActiveTab) {
                      setSemanticState({ ...s });
                    }
                  }}
                  onStickyChange={(sticky) => handleStickyChange(info().paneId, sticky)}
                  onCtxMarker={() => {
                    emitCtxMarkersChanged('terminal');
                  }}
                />
              </Show>
            )}
          </Key>

          <Show when={draggingTabId() === tabStore.activeTabId() && paneDropZones().length > 0}>
            <div class="pane-drop-overlay">
              <For each={paneDropZones()}>
                {(zone) => (
                  <div
                    class="pane-drop-zone"
                    classList={{
                      active: activeDropTarget()?.targetPaneId === zone.targetPaneId
                        && activeDropTarget()?.position === zone.position,
                      outer: zone.targetPaneId.startsWith('__outer_'),
                    }}
                    data-drop-position={zone.position}
                    style={{
                      position: 'fixed',
                      left: `${zone.rect.left}px`,
                      top: `${zone.rect.top}px`,
                      width: `${zone.rect.width}px`,
                      height: `${zone.rect.height}px`,
                    }}
                  >
                    <span class="pane-drop-zone-glyph">{dropPositionGlyph(zone.position, zone.targetPaneId.startsWith('__outer_'))}</span>
                  </div>
                )}
              </For>
            </div>
          </Show>

          {/* Resize overlay - rendered AFTER terminals so it's on top */}
          <For each={tabStore.tabs}>
            {(tab) => (
              <ResizeOverlay
                tabId={tab.id}
                isVisible={tab.id === tabStore.activeTabId()}
              />
            )}
          </For>
        </Resizable.Panel>
        {/* Sidebar on right side */}
        <Show when={sidebarVisible() && sidebarSide() === 'right'}>
          <Resizable.Handle class="sidebar-resize-handle" aria-label="Resize sidebar" />
          <Resizable.Panel
            class="sidebar-panel-wrapper"
            minSize={'200px'}
            initialSize={sidebarWidth()}
            collapsible
            collapsedSize={0}
            collapseThreshold={'50px'}
            style={{ 'max-width': '40vw' }}
          >
            <SidebarDoorContainer
              visible={sidebarVisible()}
              getOutlinerPaneId={() => resolvedOutlinerPaneId()}
            />
          </Resizable.Panel>
        </Show>
      </Resizable>
      </div>
      <Show when={isCommandBarOpen()}>
        <CommandBar
          onClose={() => setCommandBarOpen(false)}
          onNavigate={(pageName) => {
            const paneId = resolvedOutlinerPaneId();
            if (!paneId) return;
            navigateToPage(pageName, { paneId: resolveSameTabLink(paneId) });
            setCommandBarOpen(false);
            // Restore DOM focus to the outliner pane after CommandBar unmounts
            requestAnimationFrame(() => {
              const paneEl = document.querySelector(`[data-pane-id="${paneId}"]`);
              const focusTarget = paneEl?.querySelector('[contenteditable="true"]') as HTMLElement;
              (focusTarget ?? paneEl as HTMLElement)?.focus();
            });
          }}
          onCommand={(commandId) => {
            setCommandBarOpen(false);

            // Link Pane — start pane link overlay for the currently active pane.
            // Works from both terminal panes (→ picks outliner target) and outliner panes (→ picks outliner target).
            if (commandId === 'link-pane') {
              const activeId = tabStore.activeTabId();
              if (activeId) {
                const activePaneId = getActivePaneId(activeId);
                if (activePaneId) paneLinkStore.startLinking(activePaneId);
              }
              return;
            }

            // Focus Pane — show letter overlay to jump to any pane
            if (commandId === 'focus-pane') {
              const activeId = tabStore.activeTabId();
              if (activeId) {
                const activePaneId = getActivePaneId(activeId);
                if (activePaneId) {
                  paneLinkStore.startFocusing(activePaneId);
                }
              }
              return;
            }

            // Unlink active pane (works for terminal and outliner source panes)
            if (commandId === 'unlink-pane') {
              const activeId = tabStore.activeTabId();
              if (activeId) {
                const activePaneId = getActivePaneId(activeId);
                if (activePaneId) paneLinkStore.clearPaneLink(activePaneId);
              }
              return;
            }

            // Unlink all panes
            if (commandId === 'unlink-all') {
              paneLinkStore.clearAllLinks();
              return;
            }

            // Copy focused block's ID (first 8 chars) to clipboard
            if (commandId === 'copy-block-id') {
              if (commandBarFocusedBlockId) {
                navigator.clipboard.writeText(commandBarFocusedBlockId.slice(0, 8));
              }
              return;
            }

            // Home: zoom out to root
            if (commandId === 'go-home') {
              const paneId = commandBarSourcePaneId;
              if (paneId) {
                paneStore.zoomTo(paneId, null);
              }
              return;
            }

            // Today's daily note
            if (commandId === 'go-today') {
              const today = new Date();
              const yyyy = today.getFullYear();
              const mm = String(today.getMonth() + 1).padStart(2, '0');
              const dd = String(today.getDate()).padStart(2, '0');
              const pageName = `${yyyy}-${mm}-${dd}`;
              const paneId = commandBarSourcePaneId;
              if (paneId) {
                navigateToPage(pageName, { paneId: resolveSameTabLink(paneId) });
              }
              return;
            }

            // Toggle pane dimming
            if (commandId === 'toggle-dim') {
              toggleDimming();
              return;
            }

            // Swap sidebar side (left ↔ right)
            if (commandId === 'sidebar-swap') {
              setSidebarSide(s => s === 'right' ? 'left' : 'right');
              return;
            }

            // Link sidebar to the currently active outliner pane
            // (sidebar chirp navigation will target this pane)
            if (commandId === 'sidebar-link') {
              const activeId = tabStore.activeTabId();
              if (activeId) {
                const paneId = resolvedOutlinerPaneId();
                if (paneId) {
                  paneLinkStore.setSidebarLink(activeId, paneId);
                }
              }
              return;
            }

            // Dispatch keyboard events that Outliner.tsx already handles
            const keyMap: Record<string, string> = {
              'export-json': 'j',
              'export-binary': 'b',
              'export-markdown': 'm',
            };
            const key = keyMap[commandId];
            if (key) {
              document.dispatchEvent(new KeyboardEvent('keydown', {
                key,
                metaKey: isMac,
                ctrlKey: !isMac,
                shiftKey: true,
                bubbles: true,
                cancelable: true,
              }));
            }
          }}
        />
      </Show>
      <PaneLinkOverlay />
      <StatusBar semanticState={semanticState()} />
    </div>
  );
}
