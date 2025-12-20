import { useEffect, useRef, useCallback, useState } from 'react';
import { PaneLayout } from './PaneLayout';
import { TerminalPane } from './TerminalPane';
import type { TerminalPaneHandle } from './TerminalPane';
import { ContextSidebar } from './ContextSidebar';
import { useTabStore } from '../hooks/useTabStore';
import type { Tab } from '../hooks/useTabStore';
import { useLayoutStore } from '../hooks/useLayoutStore';
import { getActionForEvent, isTerminalReserved, getKeybindDisplay } from '../lib/keybinds';
import type { FocusDirection } from '../lib/layoutTypes';
import { terminalManager } from '../lib/terminalManager';

// Tab bar component
function TabBar({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onNewTab,
}: {
  tabs: Tab[];
  activeTabId: string | null;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onNewTab: () => void;
}) {
  return (
    <div className="tab-bar">
      <div className="tab-list">
        {tabs.map((tab, index) => (
          <div
            key={tab.id}
            className={`tab ${tab.id === activeTabId ? 'tab-active' : ''} ${!tab.isAlive ? 'tab-dead' : ''}`}
            onClick={() => onSelectTab(tab.id)}
          >
            <span className="tab-index">{index + 1}</span>
            <span className="tab-title" title={tab.title}>
              {tab.title.length > 20 ? tab.title.slice(-20) : tab.title}
            </span>
            {tabs.length > 1 && (
              <button
                className="tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseTab(tab.id);
                }}
                title={`Close tab (${getKeybindDisplay('closeTab') || 'Cmd+W'})`}
              >
                ×
              </button>
            )}
          </div>
        ))}
      </div>
      <button
        className="tab-new"
        onClick={onNewTab}
        title={`New tab (${getKeybindDisplay('newTab') || 'Cmd+T'})`}
      >
        +
      </button>
    </div>
  );
}

export function Terminal() {
  const [sidebarVisible, setSidebarVisible] = useState(true);

  // Tab store
  const tabs = useTabStore((s) => s.tabs);
  const activeTabId = useTabStore((s) => s.activeTabId);
  const createTab = useTabStore((s) => s.createTab);
  const closeTab = useTabStore((s) => s.closeTab);
  const setActiveTab = useTabStore((s) => s.setActiveTab);
  const setTabTitle = useTabStore((s) => s.setTabTitle);
  const setTabPtyPid = useTabStore((s) => s.setTabPtyPid);
  // markTabDead removed - we now close panes on PTY exit instead
  const prevTab = useTabStore((s) => s.prevTab);
  const nextTab = useTabStore((s) => s.nextTab);
  const goToTab = useTabStore((s) => s.goToTab);

  // Layout store - subscribe to layouts Map for reactivity
  const layouts = useLayoutStore((s) => s.layouts);
  const initLayout = useLayoutStore((s) => s.initLayout);
  const removeLayout = useLayoutStore((s) => s.removeLayout);
  const setActivePaneId = useLayoutStore((s) => s.setActivePaneId);
  const splitPane = useLayoutStore((s) => s.splitPane);
  const closePane = useLayoutStore((s) => s.closePane);
  const focusDirection = useLayoutStore((s) => s.focusDirection);

  // Derived getters (use layouts Map directly for reactivity)
  const getLayout = useCallback((tabId: string) => layouts.get(tabId)?.root ?? null, [layouts]);
  const getActivePaneId = useCallback((tabId: string) => layouts.get(tabId)?.activePaneId ?? null, [layouts]);
  const getAllPaneIds = useCallback((tabId: string) => {
    const layout = layouts.get(tabId);
    if (!layout) return [];
    const collectIds = (node: import('../lib/layoutTypes').LayoutNode): string[] => {
      if (node.type === 'leaf') return [node.id];
      return [...collectIds(node.children[0]), ...collectIds(node.children[1])];
    };
    return collectIds(layout.root);
  }, [layouts]);
  const getPaneLeaf = useCallback((tabId: string, paneId: string) => {
    const layout = layouts.get(tabId);
    if (!layout) return null;
    const findLeaf = (node: import('../lib/layoutTypes').LayoutNode): import('../lib/layoutTypes').PaneLeaf | null => {
      if (node.type === 'leaf') return node.id === paneId ? node : null;
      return findLeaf(node.children[0]) ?? findLeaf(node.children[1]);
    };
    return findLeaf(layout.root);
  }, [layouts]);

  // Refs to terminal panes for imperative control
  const paneRefs = useRef<Map<string, TerminalPaneHandle>>(new Map());

  // Register a pane ref
  const setPaneRef = useCallback((id: string, handle: TerminalPaneHandle | null) => {
    if (handle) {
      paneRefs.current.set(id, handle);
    } else {
      paneRefs.current.delete(id);
    }
  }, []);

  // Initialize layout for tabs that don't have one
  useEffect(() => {
    for (const tab of tabs) {
      if (!getLayout(tab.id)) {
        initLayout(tab.id);
      }
    }
  }, [tabs, getLayout, initLayout]);

  // Handle creating a new tab - creates tab + layout
  const handleNewTab = useCallback((cwd?: string) => {
    const tabId = createTab(cwd);
    initLayout(tabId);
    return tabId;
  }, [createTab, initLayout]);

  // Handle closing a tab - dispose all panes then tab
  const handleCloseTab = useCallback(async (id: string) => {
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
    removeLayout(id);
    closeTab(id);
  }, [closeTab, getAllPaneIds, removeLayout]);

  // Handle closing a single pane (not entire tab)
  const handleClosePane = useCallback(async (tabId: string) => {
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
    closePane(tabId, paneId);
  }, [getActivePaneId, getAllPaneIds, handleCloseTab, closePane]);

  // Keyboard shortcuts - using keybind system
  useEffect(() => {
    const handleKeydown = (e: KeyboardEvent) => {
      // Never intercept terminal-reserved keys (Ctrl+C, Ctrl+Z, etc.)
      if (isTerminalReserved(e)) {
        return;
      }

      const action = getActionForEvent(e);
      if (!action) return;

      e.preventDefault();

      switch (action) {
        case 'newTab':
          handleNewTab();
          break;
        case 'closeTab':
          if (activeTabId) {
            handleCloseTab(activeTabId).catch(e =>
              console.error('[Terminal] closeTab shortcut failed:', e)
            );
          }
          break;
        case 'prevTab':
          prevTab();
          break;
        case 'nextTab':
          nextTab();
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
          goToTab(parseInt(action.replace('goToTab', ''), 10));
          break;
        case 'toggleSidebar':
          setSidebarVisible((v) => !v);
          // Refit all visible panes after sidebar toggle
          requestAnimationFrame(() => {
            setTimeout(() => {
              if (activeTabId) {
                const paneIds = getAllPaneIds(activeTabId);
                for (const paneId of paneIds) {
                  paneRefs.current.get(paneId)?.fit();
                }
              }
            }, 100);
          });
          break;
        // Split management
        case 'splitHorizontal':
          if (activeTabId) {
            const newPaneId = splitPane(activeTabId, 'horizontal');
            if (newPaneId) {
              // Delay to let layout + terminals settle, then fit and focus
              requestAnimationFrame(() => {
                setTimeout(() => {
                  const paneIds = getAllPaneIds(activeTabId);
                  for (const paneId of paneIds) {
                    paneRefs.current.get(paneId)?.fit();
                  }
                  paneRefs.current.get(newPaneId)?.focus();
                }, 100);
              });
            }
          }
          break;
        case 'splitVertical':
          if (activeTabId) {
            const newPaneId = splitPane(activeTabId, 'vertical');
            if (newPaneId) {
              requestAnimationFrame(() => {
                setTimeout(() => {
                  const paneIds = getAllPaneIds(activeTabId);
                  for (const paneId of paneIds) {
                    paneRefs.current.get(paneId)?.fit();
                  }
                  paneRefs.current.get(newPaneId)?.focus();
                }, 100);
              });
            }
          }
          break;
        case 'closeSplit':
          if (activeTabId) {
            handleClosePane(activeTabId).catch(e =>
              console.error('[Terminal] closeSplit shortcut failed:', e)
            );
          }
          break;
        case 'focusLeft':
        case 'focusRight':
        case 'focusUp':
        case 'focusDown': {
          if (activeTabId) {
            const direction = action.replace('focus', '').toLowerCase() as FocusDirection;
            const newPaneId = focusDirection(activeTabId, direction);
            // Focus the newly active pane (use returned ID, not stale closure)
            if (newPaneId) {
              requestAnimationFrame(() => {
                paneRefs.current.get(newPaneId)?.focus();
              });
            }
          }
          break;
        }
      }
    };

    window.addEventListener('keydown', handleKeydown, true);
    return () => window.removeEventListener('keydown', handleKeydown, true);
  }, [activeTabId, handleNewTab, handleCloseTab, handleClosePane, goToTab, prevTab, nextTab, splitPane, focusDirection, getActivePaneId, getAllPaneIds]);

  // Focus active pane when tab changes
  useEffect(() => {
    if (activeTabId) {
      const activePaneId = getActivePaneId(activeTabId);
      if (activePaneId) {
        // Refit all panes in the tab, then focus the active one
        requestAnimationFrame(() => {
          const paneIds = getAllPaneIds(activeTabId);
          for (const paneId of paneIds) {
            paneRefs.current.get(paneId)?.fit();
          }
          setTimeout(() => {
            const pane = paneRefs.current.get(activePaneId);
            pane?.refresh();
            pane?.focus();
          }, 50);
        });
      }
    }
  }, [activeTabId, getActivePaneId, getAllPaneIds]);

  // Callbacks for TerminalPane
  const handlePtySpawn = useCallback((paneId: string, pid: number) => {
    // For now, track on the tab level (first pane's pid wins)
    const tab = tabs.find(t => getAllPaneIds(t.id).includes(paneId));
    if (tab && !tab.ptyPid) {
      setTabPtyPid(tab.id, pid);
    }
  }, [tabs, getAllPaneIds, setTabPtyPid]);

  const handlePtyExit = useCallback(async (paneId: string) => {
    try {
      // Find which tab this pane belongs to
      const tab = tabs.find(t => getAllPaneIds(t.id).includes(paneId));
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
        closePane(tab.id, paneId);
      }
    } catch (e) {
      console.error(`[Terminal] Failed to handle PTY exit for ${paneId}:`, e);
    }
  }, [tabs, getAllPaneIds, handleCloseTab, closePane]);

  const handleTitleChange = useCallback((paneId: string, title: string) => {
    // Update tab title from active pane
    const tab = tabs.find(t => getActivePaneId(t.id) === paneId);
    if (tab) {
      setTabTitle(tab.id, title);
    }
  }, [tabs, getActivePaneId, setTabTitle]);

  const handlePaneClick = useCallback((paneId: string) => {
    if (activeTabId) {
      setActivePaneId(activeTabId, paneId);
      const pane = paneRefs.current.get(paneId);
      pane?.fit();
      pane?.focus();
    }
  }, [activeTabId, setActivePaneId]);

  // Collect all pane info across all tabs for terminal layer
  const allPaneInfo = tabs.flatMap(tab => {
    const paneIds = getAllPaneIds(tab.id);
    const activePaneId = getActivePaneId(tab.id);
    return paneIds.map(paneId => {
      const leaf = getPaneLeaf(tab.id, paneId);
      return {
        paneId,
        tabId: tab.id,
        cwd: leaf?.cwd,
        isActivePane: paneId === activePaneId,
        isActiveTab: tab.id === activeTabId,
      };
    });
  });

  return (
    <div className="terminal-root">
      <TabBar
        tabs={tabs}
        activeTabId={activeTabId}
        onSelectTab={setActiveTab}
        onCloseTab={handleCloseTab}
        onNewTab={() => handleNewTab()}
      />
      <div className="terminal-wrapper">
        <div className="terminal-container">
          {/* Layout layer - just placeholder divs */}
          {tabs.map((tab) => {
            const layout = getLayout(tab.id);
            const activePaneId = getActivePaneId(tab.id);

            if (!layout || !activePaneId) {
              return null;
            }

            return (
              <div
                key={tab.id}
                className={`terminal-pane-wrapper ${tab.id === activeTabId ? 'pane-active' : 'pane-hidden'}`}
              >
                <PaneLayout
                  tabId={tab.id}
                  node={layout}
                  activePaneId={activePaneId}
                  onPaneClick={handlePaneClick}
                />
              </div>
            );
          })}

          {/* Terminal layer - absolutely positioned over placeholders */}
          {/* These components NEVER unmount during layout changes! */}
          {allPaneInfo.map(({ paneId, cwd, isActivePane, isActiveTab }) => (
            <TerminalPane
              key={paneId}
              id={paneId}
              cwd={cwd}
              placeholderId={paneId}
              isActive={isActivePane && isActiveTab}
              isVisible={isActiveTab}
              ref={(handle) => setPaneRef(paneId, handle)}
              onPtySpawn={(pid) => handlePtySpawn(paneId, pid)}
              onPtyExit={() => handlePtyExit(paneId).catch(e =>
                console.error(`[Terminal] Unhandled error in handlePtyExit:`, e)
              )}
              onTitleChange={(title) => handleTitleChange(paneId, title)}
            />
          ))}
        </div>
        {sidebarVisible && <ContextSidebar visible={sidebarVisible} />}
      </div>
    </div>
  );
}
