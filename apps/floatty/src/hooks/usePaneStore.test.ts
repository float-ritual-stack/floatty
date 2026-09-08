/**
 * FLO-668 — PaneHost registry tests.
 *
 * paneStore is a module-level createRoot singleton, so tests share the same
 * instance. Each test uses unique paneIds and cleans up via removePane/removePanes
 * so state doesn't leak between tests (or into other test files that import
 * paneStore — e.g. useBacklinkNavigation.test.ts).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { paneStore } from './usePaneStore';
import { findTabIdByPaneId, layoutStore } from './useLayoutStore';
import type { TabLayout } from '../lib/layoutTypes';

describe('paneStore — PaneHost registry (FLO-668)', () => {
  const cleanupIds: string[] = [];

  afterEach(() => {
    // Clean up every pane registered during the test
    for (const id of cleanupIds.splice(0)) {
      paneStore.removePane(id);
    }
  });

  const track = (id: string) => {
    cleanupIds.push(id);
    return id;
  };

  it('register + getPaneHost round-trips every host kind', () => {
    const tabId = track('flo668-rt-tab');
    const sidebarId = track('flo668-rt-sidebar');
    const floatingId = track('flo668-rt-floating');

    paneStore.registerPane(tabId, { kind: 'tab', tabId: 'tab-abc' });
    paneStore.registerPane(sidebarId, { kind: 'sidebar' });
    paneStore.registerPane(floatingId, { kind: 'floating' });

    expect(paneStore.getPaneHost(tabId)).toEqual({ kind: 'tab', tabId: 'tab-abc' });
    expect(paneStore.getPaneHost(sidebarId)).toEqual({ kind: 'sidebar' });
    expect(paneStore.getPaneHost(floatingId)).toEqual({ kind: 'floating' });
  });

  it('getPaneHost returns undefined for unregistered panes', () => {
    expect(paneStore.getPaneHost('flo668-never-registered')).toBeUndefined();
  });

  it('re-registering a pane overwrites the previous host', () => {
    const id = track('flo668-overwrite');
    paneStore.registerPane(id, { kind: 'tab', tabId: 'tab-1' });
    paneStore.registerPane(id, { kind: 'tab', tabId: 'tab-2' });
    expect(paneStore.getPaneHost(id)).toEqual({ kind: 'tab', tabId: 'tab-2' });
  });

  it('removePane clears the registry entry', () => {
    const id = track('flo668-remove');
    paneStore.registerPane(id, { kind: 'tab', tabId: 't' });
    expect(paneStore.getPaneHost(id)).toBeDefined();

    paneStore.removePane(id);
    expect(paneStore.getPaneHost(id)).toBeUndefined();
  });

  it('removePane clears registry alongside other pane state', () => {
    // setFocusedBlockId is deliberately skipped — it broadcasts presence via
    // fetch and touches window globals, which complicates environment setup.
    // Cross-field cleanup is adequately covered by zoomedRoot + collapsed.
    const id = track('flo668-remove-mixed');
    paneStore.registerPane(id, { kind: 'tab', tabId: 't' });
    paneStore.setZoomedRoot(id, 'some-block');
    paneStore.setCollapsed(id, 'some-block', true);

    paneStore.removePane(id);

    expect(paneStore.getPaneHost(id)).toBeUndefined();
    expect(paneStore.getZoomedRootId(id)).toBeNull();
    expect(paneStore.isCollapsed(id, 'some-block', false)).toBe(false);
  });

  it('removePanes clears multiple registry entries', () => {
    const ids = [track('flo668-bulk-a'), track('flo668-bulk-b'), track('flo668-bulk-c')];
    for (const id of ids) paneStore.registerPane(id, { kind: 'tab', tabId: 't' });
    for (const id of ids) expect(paneStore.getPaneHost(id)).toBeDefined();

    paneStore.removePanes(ids);
    for (const id of ids) expect(paneStore.getPaneHost(id)).toBeUndefined();
  });

  it('removePane on an unregistered pane is a safe no-op', () => {
    // Should not throw, should not bump persistenceVersion spuriously
    expect(() => paneStore.removePane('flo668-never-existed')).not.toThrow();
    expect(paneStore.getPaneHost('flo668-never-existed')).toBeUndefined();
  });
});

describe('findTabIdByPaneId — registry-backed lookup (FLO-668)', () => {
  const cleanupIds: string[] = [];

  afterEach(() => {
    for (const id of cleanupIds.splice(0)) {
      paneStore.removePane(id);
    }
  });

  const track = (id: string) => {
    cleanupIds.push(id);
    return id;
  };

  it('returns the tabId for tab-hosted panes', () => {
    const id = track('flo668-find-tab');
    paneStore.registerPane(id, { kind: 'tab', tabId: 'tab-42' });
    expect(findTabIdByPaneId(id)).toBe('tab-42');
  });

  it('returns null for sidebar-hosted panes (no layout scan needed)', () => {
    const id = track('flo668-find-sidebar');
    paneStore.registerPane(id, { kind: 'sidebar' });
    expect(findTabIdByPaneId(id)).toBeNull();
  });

  it('returns null for floating-hosted panes', () => {
    const id = track('flo668-find-floating');
    paneStore.registerPane(id, { kind: 'floating' });
    expect(findTabIdByPaneId(id)).toBeNull();
  });

  it('returns null for unregistered panes (deleted / never created)', () => {
    expect(findTabIdByPaneId('flo668-unknown')).toBeNull();
  });
});

describe('getTabHostedPaneIds — registry enumeration (FLO-668)', () => {
  const cleanupIds: string[] = [];

  afterEach(() => {
    for (const id of cleanupIds.splice(0)) paneStore.removePane(id);
  });

  it('returns only panes registered as { kind: "tab" }', () => {
    const tabA = 'flo668-enum-tab-a';
    const tabB = 'flo668-enum-tab-b';
    const sidebar = 'flo668-enum-sidebar';
    const floating = 'flo668-enum-floating';
    cleanupIds.push(tabA, tabB, sidebar, floating);

    paneStore.registerPane(tabA, { kind: 'tab', tabId: 't1' });
    paneStore.registerPane(tabB, { kind: 'tab', tabId: 't2' });
    paneStore.registerPane(sidebar, { kind: 'sidebar' });
    paneStore.registerPane(floating, { kind: 'floating' });

    const ids = new Set(paneStore.getTabHostedPaneIds());
    expect(ids.has(tabA)).toBe(true);
    expect(ids.has(tabB)).toBe(true);
    expect(ids.has(sidebar)).toBe(false);
    expect(ids.has(floating)).toBe(false);
  });
});

describe('layoutStore.hydrateLayouts — registry reconciliation (FLO-668)', () => {
  // Cleanup: remove every test-created pane AND clear all layouts the tests touch
  const cleanupIds: string[] = [];
  const tabIdsToClear: string[] = [];

  afterEach(() => {
    for (const id of cleanupIds.splice(0)) paneStore.removePane(id);
    // Drain any layouts the tests set — keeps the layoutStore singleton clean
    for (const tabId of tabIdsToClear.splice(0)) layoutStore.removeLayout(tabId);
  });

  const leaf = (id: string): TabLayout => ({
    tabId: `flo668-hy-tab-${id}`,
    root: { type: 'leaf', id },
    activePaneId: id,
  });

  it('prunes tab-hosted entries absent from the restored set, preserves sidebar/floating', () => {
    // Seed: one tab pane soon-to-be stale, plus a sidebar and a floating pane
    // registered from "elsewhere" (simulating FLO-502's pin shelf).
    const staleTabPane = 'flo668-hy-stale-tab';
    const sidebarPane = 'flo668-hy-sidebar';
    const floatingPane = 'flo668-hy-floating';
    cleanupIds.push(staleTabPane, sidebarPane, floatingPane);

    paneStore.registerPane(staleTabPane, { kind: 'tab', tabId: 'flo668-hy-tab-stale' });
    paneStore.registerPane(sidebarPane, { kind: 'sidebar' });
    paneStore.registerPane(floatingPane, { kind: 'floating' });

    // Restored layouts contain a DIFFERENT pane. `staleTabPane` is absent.
    const restoredPane = 'flo668-hy-restored';
    cleanupIds.push(restoredPane);
    const restoredLayout = leaf(restoredPane);
    tabIdsToClear.push(restoredLayout.tabId);
    const restoredLayouts: Record<string, TabLayout> = { [restoredLayout.tabId]: restoredLayout };

    layoutStore.hydrateLayouts(restoredLayouts);

    // Contract 1: stale tab-hosted entry gone
    expect(paneStore.getPaneHost(staleTabPane)).toBeUndefined();
    // Contract 2: sidebar/floating untouched
    expect(paneStore.getPaneHost(sidebarPane)).toEqual({ kind: 'sidebar' });
    expect(paneStore.getPaneHost(floatingPane)).toEqual({ kind: 'floating' });
    // Contract 3: the restored pane is registered against the restored tabId
    expect(paneStore.getPaneHost(restoredPane)).toEqual({
      kind: 'tab',
      tabId: restoredLayout.tabId,
    });
    // Contract 4: findTabIdByPaneId reflects reality after hydration
    expect(findTabIdByPaneId(staleTabPane)).toBeNull();
    expect(findTabIdByPaneId(restoredPane)).toBe(restoredLayout.tabId);
    expect(findTabIdByPaneId(sidebarPane)).toBeNull(); // sidebar is not tab-hosted
  });
});

describe('paneStore — persistence snapshot + presence debounce (2026-06-12 keyboard-lag recon)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    delete window.__FLOATTY_SERVER_URL__;
  });

  it('getPaneStateForPersistence returns structured-cloneable plain data (PR #299 DataCloneError regression)', () => {
    const paneId = 'persist-snapshot-pane';
    paneStore.setCollapsed(paneId, 'block-1', true);
    paneStore.setCollapsed(paneId, 'block-2', false);
    paneStore.pushNavigation(paneId, 'zoom-root-1', 'focus-1');
    paneStore.pushNavigation(paneId, 'zoom-root-2', 'focus-2');

    // Pre-fix this line threw DataCloneError: structuredClone was called
    // directly on SolidJS store proxies, which the structured clone
    // algorithm rejects unconditionally. Every workspace save failed from
    // PR #299 (2026-05-08) until this fix.
    const snapshot = paneStore.getPaneStateForPersistence();

    expect(snapshot.collapsed[paneId]).toEqual({ 'block-1': true, 'block-2': false });
    expect(snapshot.navigationHistory[paneId].entries.length).toBeGreaterThanOrEqual(2);

    // The snapshot must survive a further structuredClone — a leaked proxy
    // anywhere in the graph would throw here.
    expect(() => structuredClone(snapshot)).not.toThrow();
    // And the JSON round-trip that saveWorkspace actually performs.
    expect(() => JSON.stringify(snapshot)).not.toThrow();

    paneStore.removePane(paneId);
  });

  it('snapshot is decoupled from live store state (mutating store does not mutate snapshot)', () => {
    const paneId = 'persist-decouple-pane';
    paneStore.setCollapsed(paneId, 'block-a', true);

    const snapshot = paneStore.getPaneStateForPersistence();
    paneStore.setCollapsed(paneId, 'block-a', false);

    expect(snapshot.collapsed[paneId]['block-a']).toBe(true);

    paneStore.removePane(paneId);
  });

  it('debounces presence POSTs: rapid focus changes produce one trailing request with the resting block', () => {
    vi.useFakeTimers();
    const fetchSpy = vi.fn(() => Promise.resolve({} as Response));
    vi.stubGlobal('fetch', fetchSpy);
    window.__FLOATTY_SERVER_URL__ = 'http://127.0.0.1:9';

    const paneId = 'presence-debounce-pane';
    for (let i = 1; i <= 5; i++) {
      paneStore.setFocusedBlockId(paneId, `block-${i}`);
    }

    // No POST during the burst
    expect(fetchSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(200);

    // Exactly one POST, carrying the final resting position
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchSpy.mock.calls[0] as unknown[])[1] !== undefined
      ? String(((fetchSpy.mock.calls[0] as unknown[])[1] as RequestInit).body)
      : '{}');
    expect(body.blockId).toBe('block-5');
    expect(body.paneId).toBe(paneId);

    paneStore.removePane(paneId);
  });

  it('presence POST is skipped entirely when focus clears before the debounce fires', () => {
    vi.useFakeTimers();
    const fetchSpy = vi.fn(() => Promise.resolve({} as Response));
    vi.stubGlobal('fetch', fetchSpy);
    window.__FLOATTY_SERVER_URL__ = 'http://127.0.0.1:9';

    const paneId = 'presence-clear-pane';
    paneStore.setFocusedBlockId(paneId, 'block-x');
    paneStore.setFocusedBlockId(paneId, null);

    vi.advanceTimersByTime(200);
    expect(fetchSpy).not.toHaveBeenCalled();

    paneStore.removePane(paneId);
  });
});

describe('paneStore — backlink drawer view state (FLO-440 U2)', () => {
  const cleanupIds: string[] = [];

  afterEach(() => {
    for (const id of cleanupIds.splice(0)) {
      paneStore.removePane(id);
    }
  });

  const track = (id: string) => {
    cleanupIds.push(id);
    return id;
  };

  it('drawer defaults to closed with no stored height (D1)', () => {
    const id = track('flo440-defaults');
    expect(paneStore.isDrawerOpen(id)).toBe(false);
    expect(paneStore.getDrawerHeight(id)).toBeNull();
  });

  it('open state and height round-trip per pane', () => {
    const a = track('flo440-pane-a');
    const b = track('flo440-pane-b');
    paneStore.setDrawerOpen(a, true);
    paneStore.setDrawerHeight(a, 320);
    expect(paneStore.isDrawerOpen(a)).toBe(true);
    expect(paneStore.getDrawerHeight(a)).toBe(320);
    // Per-pane isolation
    expect(paneStore.isDrawerOpen(b)).toBe(false);
    expect(paneStore.getDrawerHeight(b)).toBeNull();
  });

  it('setters bump persistenceVersion only on real changes', () => {
    const id = track('flo440-persist-bump');
    const before = paneStore.persistenceVersion();
    paneStore.setDrawerOpen(id, true);
    paneStore.setDrawerHeight(id, 200);
    const afterChange = paneStore.persistenceVersion();
    expect(afterChange).toBeGreaterThan(before);
    // No-op writes don't churn the save lane
    paneStore.setDrawerOpen(id, true);
    paneStore.setDrawerHeight(id, 200);
    expect(paneStore.persistenceVersion()).toBe(afterChange);
  });

  it('drawer state rides persistence and hydration', () => {
    const id = track('flo440-persist-shape');
    paneStore.setDrawerOpen(id, true);
    paneStore.setDrawerHeight(id, 275);
    const persisted = paneStore.getPaneStateForPersistence();
    expect(persisted.drawerOpen[id]).toBe(true);
    expect(persisted.drawerHeight[id]).toBe(275);

    paneStore.removePane(id);
    expect(paneStore.isDrawerOpen(id)).toBe(false);
    expect(paneStore.getDrawerHeight(id)).toBeNull();

    // Boot-shaped restore: hydrate puts the drawer state back
    paneStore.hydratePaneState({}, undefined, undefined, undefined,
      { [id]: true }, { [id]: 275 });
    expect(paneStore.isDrawerOpen(id)).toBe(true);
    expect(paneStore.getDrawerHeight(id)).toBe(275);
  });

  it('drops non-boolean drawer open values during hydration', () => {
    const id = track('flo440-invalid-open');
    paneStore.hydratePaneState({}, undefined, undefined, undefined,
      { [id]: 'false' } as unknown as Record<string, boolean>);
    expect(paneStore.isDrawerOpen(id)).toBe(false);
  });

  it('removePane clears drawer state', () => {
    const id = track('flo440-remove');
    paneStore.setDrawerOpen(id, true);
    paneStore.setDrawerHeight(id, 180);
    paneStore.removePane(id);
    expect(paneStore.isDrawerOpen(id)).toBe(false);
    expect(paneStore.getDrawerHeight(id)).toBeNull();
  });
});
