/**
 * FLO-869 — the sidebar's active tab must survive both failure modes that
 * used to reset it to 'ctx':
 *
 * 1. Container unmount (sidebar hide/show) — covered by the store being a
 *    module singleton; asserted here as "two createRoot consumers of the
 *    singleton see the same signal".
 * 2. App restart — covered by localStorage round-trip in the factory.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRoot } from 'solid-js';
import { createSidebarDoorStore, sidebarDoorStore, BUILTIN_DOOR_IDS } from './useSidebarDoorStore';

const KEY = 'floatty-sidebar-tab';

// The vitest jsdom environment's `localStorage` global is a method-less stub
// (getItem/setItem undefined) — stub a real Map-backed implementation so the
// persistence contract is actually exercised. The store reads the global at
// call time, so per-test stubbing works.
const backing = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => backing.get(k) ?? null,
  setItem: (k: string, v: string) => void backing.set(k, String(v)),
  removeItem: (k: string) => void backing.delete(k),
  clear: () => backing.clear(),
});

beforeEach(() => {
  backing.clear();
});

describe('sidebar door store — FLO-869', () => {
  it('defaults to ctx with nothing saved', () => {
    createRoot(dispose => {
      const store = createSidebarDoorStore();
      expect(store.activeDoorId()).toBe('ctx');
      dispose();
    });
  });

  it('persists the active tab and restores it in a fresh store (restart shape)', () => {
    createRoot(dispose => {
      const store = createSidebarDoorStore();
      store.setActiveDoorId('pins');
      dispose();
    });

    // Fresh store = app restart: reads what the previous one saved.
    createRoot(dispose => {
      const fresh = createSidebarDoorStore();
      expect(fresh.activeDoorId()).toBe('pins');
      dispose();
    });
  });

  it('restores a registry-door id verbatim — no self-heal to ctx', () => {
    // Registry doors load async at boot; healing a not-yet-registered id
    // back to 'ctx' at load time would lose the tab on every restart.
    backing.set(KEY, 'session-garden');
    createRoot(dispose => {
      const store = createSidebarDoorStore();
      expect(store.activeDoorId()).toBe('session-garden');
      dispose();
    });
  });

  it('heals empty/whitespace storage back to ctx', () => {
    backing.set(KEY, '   ');
    createRoot(dispose => {
      const store = createSidebarDoorStore();
      expect(store.activeDoorId()).toBe('ctx');
      dispose();
    });
  });

  it('the module singleton is shared — a tab set anywhere is seen everywhere', () => {
    // The container reads the singleton; hide/show remounts the container
    // but not the store. Setting through the singleton and reading it again
    // models a remount (the old code created a new store per mount).
    sidebarDoorStore.setActiveDoorId('files');
    expect(sidebarDoorStore.activeDoorId()).toBe('files');
    expect(backing.get(KEY)).toBe('files');
  });

  it('builtin ids are ctx/pins/files', () => {
    expect([...BUILTIN_DOOR_IDS].sort()).toEqual(['ctx', 'files', 'pins']);
  });
});
