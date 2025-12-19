import { create } from 'zustand';

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

// Tab store state
interface TabState {
  tabs: Tab[];
  activeTabId: string | null;
}

// Tab store actions
interface TabActions {
  // Create a new tab and make it active
  createTab: (cwd?: string) => string;
  // Close a tab by ID
  closeTab: (id: string) => void;
  // Set active tab
  setActiveTab: (id: string) => void;
  // Update tab title (usually from shell OSC)
  setTabTitle: (id: string, title: string) => void;
  // Update tab's PTY pid after spawn
  setTabPtyPid: (id: string, ptyPid: number) => void;
  // Mark tab as dead (PTY exited)
  markTabDead: (id: string) => void;
  // Navigate to previous tab
  prevTab: () => void;
  // Navigate to next tab
  nextTab: () => void;
  // Navigate to tab by number (1-indexed)
  goToTab: (n: number) => void;
  // Get active tab
  getActiveTab: () => Tab | null;
}

// Generate unique tab ID
function generateTabId(): string {
  return `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// Initial tab created on startup
const initialTabId = generateTabId();

export const useTabStore = create<TabState & TabActions>((set, get) => ({
  // Initial state: one tab
  tabs: [{
    id: initialTabId,
    title: 'Terminal',
    ptyPid: null,
    isAlive: true,
  }],
  activeTabId: initialTabId,

  createTab: (cwd?: string) => {
    const newId = generateTabId();
    set((state) => ({
      tabs: [...state.tabs, {
        id: newId,
        title: 'Terminal',
        ptyPid: null,
        cwd,
        isAlive: true,
      }],
      activeTabId: newId,
    }));
    return newId;
  },

  closeTab: (id: string) => {
    const state = get();

    // Don't close the last tab
    if (state.tabs.length <= 1) {
      return;
    }

    const closingIndex = state.tabs.findIndex((t) => t.id === id);
    const newTabs = state.tabs.filter((t) => t.id !== id);

    // If closing the active tab, activate adjacent tab
    let newActiveId = state.activeTabId;
    if (state.activeTabId === id) {
      // Prefer tab to the left, fall back to first remaining
      const nextIndex = Math.max(0, closingIndex - 1);
      newActiveId = newTabs[nextIndex]?.id ?? newTabs[0]?.id ?? null;
    }

    set({
      tabs: newTabs,
      activeTabId: newActiveId,
    });
  },

  setActiveTab: (id: string) => {
    const state = get();
    if (state.tabs.some((t) => t.id === id)) {
      set({ activeTabId: id });
    }
  },

  setTabTitle: (id: string, title: string) => {
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === id ? { ...t, title } : t
      ),
    }));
  },

  setTabPtyPid: (id: string, ptyPid: number) => {
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === id ? { ...t, ptyPid, isAlive: true } : t
      ),
    }));
  },

  markTabDead: (id: string) => {
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === id ? { ...t, isAlive: false } : t
      ),
    }));
  },

  prevTab: () => {
    const state = get();
    const currentIndex = state.tabs.findIndex((t) => t.id === state.activeTabId);
    if (currentIndex > 0) {
      set({ activeTabId: state.tabs[currentIndex - 1].id });
    } else if (state.tabs.length > 0) {
      // Wrap to last tab
      set({ activeTabId: state.tabs[state.tabs.length - 1].id });
    }
  },

  nextTab: () => {
    const state = get();
    const currentIndex = state.tabs.findIndex((t) => t.id === state.activeTabId);
    if (currentIndex < state.tabs.length - 1) {
      set({ activeTabId: state.tabs[currentIndex + 1].id });
    } else if (state.tabs.length > 0) {
      // Wrap to first tab
      set({ activeTabId: state.tabs[0].id });
    }
  },

  goToTab: (n: number) => {
    const state = get();
    // 1-indexed to 0-indexed
    const index = n - 1;
    if (index >= 0 && index < state.tabs.length) {
      set({ activeTabId: state.tabs[index].id });
    }
  },

  getActiveTab: () => {
    const state = get();
    return state.tabs.find((t) => t.id === state.activeTabId) ?? null;
  },
}));
