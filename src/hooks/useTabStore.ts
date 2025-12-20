import { createSignal, createRoot } from 'solid-js';
import { createStore, produce } from 'solid-js/store';

// A single terminal tab
export interface Tab {
  id: string;
  title: string;
  // PTY process ID (null until spawned)
  ptyPid: number | null;
  // Working directory for this tab
  cwd?: string;
  // True if PTY is still running
  isAlive: boolean;
}

// Generate unique tab ID
function generateTabId(): string {
  return `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// Initial tab created on startup
const initialTabId = generateTabId();

// Create the store in a root to ensure it persists
function createTabStore() {
  const [tabs, setTabs] = createStore<Tab[]>([{
    id: initialTabId,
    title: 'Terminal',
    ptyPid: null,
    isAlive: true,
  }]);

  const [activeTabId, setActiveTabId] = createSignal<string | null>(initialTabId);

  const createTab = (cwd?: string): string => {
    const newId = generateTabId();
    setTabs(produce((tabs) => {
      tabs.push({
        id: newId,
        title: 'Terminal',
        ptyPid: null,
        cwd,
        isAlive: true,
      });
    }));
    setActiveTabId(newId);
    return newId;
  };

  const closeTab = (id: string) => {
    // Don't close the last tab
    if (tabs.length <= 1) {
      return;
    }

    const closingIndex = tabs.findIndex((t) => t.id === id);
    const currentActiveId = activeTabId();

    // If closing the active tab, activate adjacent tab
    if (currentActiveId === id) {
      // Prefer tab to the left, fall back to first remaining
      const newTabs = tabs.filter((t) => t.id !== id);
      const nextIndex = Math.max(0, closingIndex - 1);
      const newActiveId = newTabs[nextIndex]?.id ?? newTabs[0]?.id ?? null;
      setActiveTabId(newActiveId);
    }

    setTabs(produce((tabs) => {
      const idx = tabs.findIndex((t) => t.id === id);
      if (idx !== -1) {
        tabs.splice(idx, 1);
      }
    }));
  };

  const setActiveTab = (id: string) => {
    if (tabs.some((t) => t.id === id)) {
      setActiveTabId(id);
    }
  };

  const setTabTitle = (id: string, title: string) => {
    setTabs(
      (t) => t.id === id,
      'title',
      title
    );
  };

  const setTabPtyPid = (id: string, ptyPid: number) => {
    setTabs(
      (t) => t.id === id,
      produce((tab) => {
        tab.ptyPid = ptyPid;
        tab.isAlive = true;
      })
    );
  };

  const markTabDead = (id: string) => {
    setTabs(
      (t) => t.id === id,
      'isAlive',
      false
    );
  };

  const prevTab = () => {
    const currentIndex = tabs.findIndex((t) => t.id === activeTabId());
    if (currentIndex > 0) {
      setActiveTabId(tabs[currentIndex - 1].id);
    } else if (tabs.length > 0) {
      // Wrap to last tab
      setActiveTabId(tabs[tabs.length - 1].id);
    }
  };

  const nextTab = () => {
    const currentIndex = tabs.findIndex((t) => t.id === activeTabId());
    if (currentIndex < tabs.length - 1) {
      setActiveTabId(tabs[currentIndex + 1].id);
    } else if (tabs.length > 0) {
      // Wrap to first tab
      setActiveTabId(tabs[0].id);
    }
  };

  const goToTab = (n: number) => {
    // 1-indexed to 0-indexed
    const index = n - 1;
    if (index >= 0 && index < tabs.length) {
      setActiveTabId(tabs[index].id);
    }
  };

  const getActiveTab = (): Tab | null => {
    return tabs.find((t) => t.id === activeTabId()) ?? null;
  };

  return {
    // State (reactive)
    tabs,
    activeTabId,
    // Actions
    createTab,
    closeTab,
    setActiveTab,
    setTabTitle,
    setTabPtyPid,
    markTabDead,
    prevTab,
    nextTab,
    goToTab,
    getActiveTab,
  };
}

// Create singleton store
export const tabStore = createRoot(createTabStore);
