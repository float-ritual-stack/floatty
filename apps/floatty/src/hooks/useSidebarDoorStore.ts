/**
 * Sidebar Door Store — state for sidebar door tabs
 *
 * Phase 2: hardcoded ['ctx'] tab + sidebarEligible doors from DoorRegistry.
 *
 * Module-level singleton (FLO-869): the store used to be created inside
 * SidebarDoorContainer's component body, but that component mounts under
 * `<Show when={sidebarVisible()}>` — every hide/show unmounted the container
 * and recreated the store, resetting the active tab to 'ctx' (the
 * solidjs-patterns.md rule-4 trap). Hoisting via createRoot makes the store
 * survive the container's mount cycle; localStorage makes the active tab
 * survive restart.
 *
 * No Y.Doc coupling — the active tab is per-device UI state, same class as
 * sidebar width (FLO-507), so localStorage is the right home.
 */

import { createSignal, createMemo, createRoot } from 'solid-js';
import { doorRegistry } from '../lib/handlers/doorRegistry';

export interface SidebarDoorInfo {
  id: string;
  label: string;
}

// Hardcoded built-in tabs (always present). Module-level so the set of
// built-in ids can be consumed by SidebarDoorContainer without duplication.
const BUILTIN: SidebarDoorInfo[] = [
  { id: 'ctx', label: 'ctx' },
  // FLO-502: Pin shelf — renders a stack of Outliners zoomed at whatever
  // block each child of the `pinned::` root block references via [[...]].
  { id: 'pins', label: 'pins' },
  // FLO-799: Recent agent-written .md/.txt files, mined from session JSONL.
  { id: 'files', label: 'files' },
];

/** Set of builtin door ids — single source of truth shared with SidebarDoorContainer. */
export const BUILTIN_DOOR_IDS = new Set(BUILTIN.map(d => d.id));

const ACTIVE_TAB_KEY = 'floatty-sidebar-tab';

// Guarded storage access: the singleton below initializes at module import,
// and the vitest jsdom environment ships a method-less localStorage stub —
// a bare `localStorage.getItem(...)` at import time would crash every test
// file that transitively imports this module. In the app (Tauri webview)
// these are always the real thing.
const safeGetItem = (key: string): string | null => {
  try {
    return typeof localStorage?.getItem === 'function' ? localStorage.getItem(key) : null;
  } catch {
    return null;
  }
};
const safeSetItem = (key: string, value: string): void => {
  try {
    if (typeof localStorage?.setItem === 'function') localStorage.setItem(key, value);
  } catch {
    // Persistence is a per-device nicety — never fatal.
  }
};

const loadSavedActiveTab = (): string => {
  const raw = safeGetItem(ACTIVE_TAB_KEY);
  // Accept any non-empty saved id, including registry doors that haven't
  // loaded yet at this point in boot — doorRegistry populates async and
  // `allDoors` is reactive, so the tab appears once the door registers.
  // Self-healing a not-yet-loaded id back to 'ctx' here would lose the
  // persisted tab on every restart.
  return raw && raw.trim() !== '' ? raw : 'ctx';
};

export function createSidebarDoorStore() {
  const [activeDoorId, setActiveDoorIdRaw] = createSignal(loadSavedActiveTab());

  const setActiveDoorId = (id: string) => {
    safeSetItem(ACTIVE_TAB_KEY, id);
    setActiveDoorIdRaw(id);
  };

  // Merge built-in + registry sidebar doors (reactive via registry version signal)
  const allDoors = createMemo((): SidebarDoorInfo[] => {
    const registryDoors = doorRegistry.getSidebarDoors().map(d => ({
      id: d.id,
      label: d.meta.name,
    }));
    return [...BUILTIN, ...registryDoors];
  });

  return {
    activeDoorId,
    setActiveDoorId,
    /** All sidebar tabs — built-in + registry doors */
    allDoors,
  };
}

/**
 * Singleton — survives SidebarDoorContainer unmount/remount (sidebar
 * hide/show). Same createRoot pattern as usePaneLinkStore.
 */
export const sidebarDoorStore = createRoot(createSidebarDoorStore);
