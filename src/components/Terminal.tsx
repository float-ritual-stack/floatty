import { createSignal, createEffect, createMemo, onCleanup, For, Show } from 'solid-js';
import { Key } from '@solid-primitives/keyed';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { invoke } from '@tauri-apps/api/core';
import { PaneLayout } from './PaneLayout';
import { TerminalPane } from './TerminalPane';
import { OutlinerPane } from './OutlinerPane';
import { ResizeOverlay } from './ResizeOverlay';
import { ContextSidebar } from './ContextSidebar';
import { tabStore } from '../hooks/useTabStore';
import type { Tab } from '../hooks/useTabStore';
import { layoutStore } from '../hooks/useLayoutStore';
import { themeStore } from '../hooks/useThemeStore';
import { getActionForEvent, isTerminalReserved, getKeybindDisplay } from '../lib/keybinds';
import type { FocusDirection, PaneLeaf, PaneHandle } from '../lib/layoutTypes';
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
        }}
        title={
          syncStatus() === 'error'
            ? getLastSyncError() || 'Sync error'
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
  const [semanticState, setSemanticState] = createSignal<SemanticState | null>(null);

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

  // Helper to split pane and handle post-split fitting/focusing
  const handleSplit = (direction: 'horizontal' | 'vertical', leafType?: 'terminal' | 'outliner') => {
    const activeId = tabStore.activeTabId();
    if (!activeId) {
      console.warn('[Terminal] Split failed: no active tab');
      return;
    }

    const newPaneId = layoutStore.splitPane(activeId, direction, leafType);
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

      if (!action) return;

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
          // Refit all visible panes after sidebar toggle
          requestAnimationFrame(() => {
            setTimeout(() => {
              const currentActiveId = tabStore.activeTabId();
              if (currentActiveId) {
                const paneIds = getAllPaneIds(currentActiveId);
                for (const paneId of paneIds) {
                  paneRefs.get(paneId)?.fit();
                }
              }
            }, 100);
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

  const handlePaneClick = (paneId: string) => {
    const activeId = tabStore.activeTabId();
    if (activeId) {
      layoutStore.setActivePaneId(activeId, paneId);
      const pane = paneRefs.get(paneId);
      pane?.fit();
      pane?.focus();
    }
  };

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
          isActivePane: paneId === activePaneId,
          isActiveTab: tab.id === activeId,
        };
      });
    });
  });

  return (
    <div class="terminal-root">
      <TabBar
        tabs={tabStore.tabs}
        activeTabId={tabStore.activeTabId()}
        onSelectTab={tabStore.setActiveTab}
        onCloseTab={handleCloseTab}
        onNewTab={() => handleNewTab()}
      />
      <div class="terminal-wrapper">
        <main class="terminal-container" role="main">
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
                    ref={(handle) => setPaneRef(info().paneId, handle)}
                    onPaneClick={() => handlePaneClick(info().paneId)}
                  />
                }
              >
                <TerminalPane
                  id={info().paneId}
                  cwd={info().cwd}
                  placeholderId={info().paneId}
                  isActive={info().isActivePane && info().isActiveTab}
                  isVisible={info().isActiveTab}
                  ref={(handle) => setPaneRef(info().paneId, handle)}
                  onPaneClick={() => handlePaneClick(info().paneId)}
                  onPtySpawn={(pid) => handlePtySpawn(info().paneId, pid)}
                  onPtyExit={() => handlePtyExit(info().paneId).catch(e =>
                    console.error(`[Terminal] Unhandled error in handlePtyExit:`, e)
                  )}
                  onTitleChange={(title) => handleTitleChange(info().paneId, title)}
                  onSemanticStateChange={(state) => {
                    // Only update status bar for active pane
                    const i = info();
                    if (i.isActivePane && i.isActiveTab) {
                      // Clone to break reference equality - SolidJS signals won't update on same object
                      setSemanticState({ ...state } as SemanticState);
                    }
                  }}
                />
              </Show>
            )}
          </Key>

          {/* Resize overlay - rendered AFTER terminals so it's on top */}
          <For each={tabStore.tabs}>
            {(tab) => (
              <ResizeOverlay
                tabId={tab.id}
                isVisible={tab.id === tabStore.activeTabId()}
              />
            )}
          </For>
        </main>
        <Show when={sidebarVisible()}>
          <ContextSidebar visible={sidebarVisible()} />
        </Show>
      </div>
      <StatusBar semanticState={semanticState()} />
    </div>
  );
}
