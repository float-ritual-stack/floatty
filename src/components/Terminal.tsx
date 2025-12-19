import { useEffect, useRef, useCallback, useState } from 'react';
import { TerminalPane } from './TerminalPane';
import type { TerminalPaneHandle } from './TerminalPane';
import { ContextSidebar } from './ContextSidebar';
import { useTabStore } from '../hooks/useTabStore';
import type { Tab } from '../hooks/useTabStore';
import { getActionForEvent, isTerminalReserved, getKeybindDisplay } from '../lib/keybinds';
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
  const markTabDead = useTabStore((s) => s.markTabDead);
  const prevTab = useTabStore((s) => s.prevTab);
  const nextTab = useTabStore((s) => s.nextTab);
  const goToTab = useTabStore((s) => s.goToTab);

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

  // Handle closing a tab - dispose via terminal manager
  const handleCloseTab = useCallback(async (id: string) => {
    // Terminal manager handles PTY kill and cleanup
    await terminalManager.dispose(id);
    closeTab(id);
  }, [closeTab]);

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
          createTab();
          break;
        case 'closeTab':
          if (activeTabId) handleCloseTab(activeTabId);
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
          // Refit after sidebar toggle
          requestAnimationFrame(() => {
            setTimeout(() => {
              if (activeTabId) {
                paneRefs.current.get(activeTabId)?.fit();
              }
            }, 100);
          });
          break;
        // Future: split management
        case 'splitHorizontal':
        case 'splitVertical':
        case 'closeSplit':
        case 'focusLeft':
        case 'focusRight':
        case 'focusUp':
        case 'focusDown':
          console.log(`[Terminal] Action not yet implemented: ${action}`);
          break;
      }
    };

    window.addEventListener('keydown', handleKeydown, true);
    return () => window.removeEventListener('keydown', handleKeydown, true);
  }, [activeTabId, createTab, handleCloseTab, goToTab, prevTab, nextTab]);

  // Focus active terminal when tab changes
  useEffect(() => {
    if (activeTabId) {
      const pane = paneRefs.current.get(activeTabId);
      // Sequence: fit first (recalculate dimensions), refresh (redraw), then focus
      pane?.fit();
      // Use RAF to ensure fit completes before refresh
      requestAnimationFrame(() => {
        pane?.refresh();
        pane?.focus();
      });
    }
  }, [activeTabId]);

  // Global resize handler - refit active pane
  useEffect(() => {
    const handleResize = () => {
      if (activeTabId) {
        paneRefs.current.get(activeTabId)?.fit();
      }
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [activeTabId]);

  return (
    <div className="terminal-root">
      <TabBar
        tabs={tabs}
        activeTabId={activeTabId}
        onSelectTab={setActiveTab}
        onCloseTab={handleCloseTab}
        onNewTab={() => createTab()}
      />
      <div className="terminal-wrapper">
        <div className="terminal-container">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={`terminal-pane-wrapper ${tab.id === activeTabId ? 'pane-active' : 'pane-hidden'}`}
            >
              <TerminalPane
                id={tab.id}
                cwd={tab.cwd}
                isActive={tab.id === activeTabId}
                ref={(handle) => setPaneRef(tab.id, handle)}
                onPtySpawn={(pid) => setTabPtyPid(tab.id, pid)}
                onPtyExit={() => markTabDead(tab.id)}
                onTitleChange={(title) => setTabTitle(tab.id, title)}
              />
            </div>
          ))}
        </div>
        {sidebarVisible && <ContextSidebar visible={sidebarVisible} />}
      </div>
    </div>
  );
}
