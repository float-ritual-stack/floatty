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
import { getActionForEvent, isTerminalReserved, getKeybindDisplay } from '../lib/keybinds';
import type { FocusDirection, LayoutNode, PaneLeaf, PaneHandle } from '../lib/layoutTypes';
import { terminalManager } from '../lib/terminalManager';

// Zoom state
let currentZoom = 1.0;
const ZOOM_STEP = 0.1;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.0;

// Status bar with keyboard shortcuts
function StatusBar() {
  const shortcuts = [
    { label: 'Split', keys: '⌘D' },
    { label: 'Focus', keys: '⌘⌥↑↓←→' },
    { label: 'Outliner', keys: '⌘O' },
    { label: 'Fold', keys: '⌘.' },
    { label: 'Zoom', keys: '⌘+/-' },
  ];

  return (
    <div class="status-bar">
      <For each={shortcuts}>
        {(item) => (
          <span class="status-item">
            <span class="status-keys">{item.keys}</span>
            <span class="status-label">{item.label}</span>
          </span>
        )}
      </For>
    </div>
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
    <div class="tab-bar">
      <div class="tab-list">
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
    </div>
  );
}

export function Terminal() {
  const [sidebarVisible, setSidebarVisible] = createSignal(true);

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

  // Helper to collect all pane IDs from layout
  const collectIds = (node: LayoutNode): string[] => {
    if (node.type === 'leaf') return [node.id];
    return [...collectIds(node.children[0]), ...collectIds(node.children[1])];
  };

  // Helper to find a leaf by pane ID
  const findLeaf = (node: LayoutNode, paneId: string): PaneLeaf | null => {
    if (node.type === 'leaf') return node.id === paneId ? node : null;
    return findLeaf(node.children[0], paneId) ?? findLeaf(node.children[1], paneId);
  };

  // Derived getters using layout store
  const getLayout = (tabId: string) => layoutStore.layouts[tabId]?.root ?? null;
  const getActivePaneId = (tabId: string) => layoutStore.layouts[tabId]?.activePaneId ?? null;
  const getAllPaneIds = (tabId: string) => {
    const layout = layoutStore.layouts[tabId];
    if (!layout) return [];
    return collectIds(layout.root);
  };
  const getPaneLeaf = (tabId: string, paneId: string) => {
    const layout = layoutStore.layouts[tabId];
    if (!layout) return null;
    return findLeaf(layout.root, paneId);
  };

  // Helper to split pane and handle post-split fitting/focusing
  const handleSplit = (direction: 'horizontal' | 'vertical', leafType?: 'terminal' | 'outliner') => {
    const activeId = tabStore.activeTabId();
    if (!activeId) return;

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

  // Handle creating a new tab - creates tab + layout
  const handleNewTab = (cwd?: string) => {
    const tabId = tabStore.createTab(cwd);
    layoutStore.initLayout(tabId);
    return tabId;
  };

  // Handle closing a tab - dispose all panes then tab
  const handleCloseTab = async (id: string) => {
    // Get all pane IDs in this tab's layout
    const paneIds = getAllPaneIds(id);
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

    // Remove layout and tab
    layoutStore.removeLayout(id);
    tabStore.closeTab(id);
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
        <div class="terminal-container">
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
        </div>
        <Show when={sidebarVisible()}>
          <ContextSidebar visible={sidebarVisible()} />
        </Show>
      </div>
      <StatusBar />
    </div>
  );
}
