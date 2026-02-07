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

// Generate unique tab ID (UUID for persistence compatibility)
function generateTabId(): string {
  return `tab-${crypto.randomUUID()}`;
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
  const [persistenceVersion, setPersistenceVersion] = createSignal(0);

  const bumpPersistenceVersion = () => {
    setPersistenceVersion((v) => v + 1);
  };

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
    bumpPersistenceVersion();
    return newId;
  };

  const closeTab = (id: string) => {
    // Don't close the last tab
    if (tabs.length <= 1) {
      return;
    }
    if (!tabs.some((t) => t.id === id)) return;

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
    bumpPersistenceVersion();
  };

  const setActiveTab = (id: string) => {
    if (tabs.some((t) => t.id === id) && activeTabId() !== id) {
      setActiveTabId(id);
      bumpPersistenceVersion();
    }
  };

  const setTabTitle = (id: string, title: string) => {
    const tab = tabs.find((t) => t.id === id);
    if (!tab || tab.title === title) return;

    setTabs(
      (t) => t.id === id,
      'title',
      title
    );
    bumpPersistenceVersion();
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
    let nextId: string | null = null;

    if (currentIndex > 0) {
      nextId = tabs[currentIndex - 1].id;
    } else if (tabs.length > 0) {
      // Wrap to last tab
      nextId = tabs[tabs.length - 1].id;
    }

    if (nextId && nextId !== activeTabId()) {
      setActiveTabId(nextId);
      bumpPersistenceVersion();
    }
  };

  const nextTab = () => {
    const currentIndex = tabs.findIndex((t) => t.id === activeTabId());
    let nextId: string | null = null;

    if (currentIndex < tabs.length - 1) {
      nextId = tabs[currentIndex + 1].id;
    } else if (tabs.length > 0) {
      // Wrap to first tab
      nextId = tabs[0].id;
    }

    if (nextId && nextId !== activeTabId()) {
      setActiveTabId(nextId);
      bumpPersistenceVersion();
    }
  };

  const goToTab = (n: number) => {
    // 1-indexed to 0-indexed
    const index = n - 1;
    if (index >= 0 && index < tabs.length && tabs[index].id !== activeTabId()) {
      setActiveTabId(tabs[index].id);
      bumpPersistenceVersion();
    }
  };

  const getActiveTab = (): Tab | null => {
    return tabs.find((t) => t.id === activeTabId()) ?? null;
  };

  /**
   * Hydrate tabs from persisted state
   * Replaces current tabs with restored data
   */
  const hydrateTabs = (restoredTabs: Tab[], restoredActiveTabId: string) => {
    // Reset PTY state - processes are gone, need to respawn
    const tabsWithResetPty = restoredTabs.map((t) => ({
      ...t,
      ptyPid: null,
      isAlive: true, // Will become alive when PTY spawns
    }));

    setTabs(tabsWithResetPty);
    setActiveTabId(restoredActiveTabId);
  };

  /**
   * Get all tabs for persistence (strips non-essential runtime state)
   */
  const getTabsForPersistence = (): { tabs: Array<{ id: string; title: string }>; activeTabId: string | null } => {
    return {
      tabs: tabs.map((t) => ({ id: t.id, title: t.title })),
      activeTabId: activeTabId(),
    };
  };

  return {
    // State (reactive)
    tabs,
    activeTabId,
    persistenceVersion,
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
    // Persistence
    hydrateTabs,
    getTabsForPersistence,
  };
}

// Create singleton store
export const tabStore = createRoot(createTabStore);
