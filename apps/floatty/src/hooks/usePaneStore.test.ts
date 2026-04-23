/**
 * FLO-668 — PaneHost registry tests.
 *
 * paneStore is a module-level createRoot singleton, so tests share the same
 * instance. Each test uses unique paneIds and cleans up via removePane/removePanes
 * so state doesn't leak between tests (or into other test files that import
 * paneStore — e.g. useBacklinkNavigation.test.ts).
 */

import { describe, it, expect, afterEach } from 'vitest';
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
