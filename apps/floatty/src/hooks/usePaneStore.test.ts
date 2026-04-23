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
import { findTabIdByPaneId } from './useLayoutStore';

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
    const id = 'flo668-remove'; // not tracked — we remove inside the test
    paneStore.registerPane(id, { kind: 'tab', tabId: 't' });
    expect(paneStore.getPaneHost(id)).toBeDefined();

    paneStore.removePane(id);
    expect(paneStore.getPaneHost(id)).toBeUndefined();
  });

  it('removePane clears registry alongside other pane state', () => {
    // setFocusedBlockId is deliberately skipped — it broadcasts presence via
    // fetch and touches window globals, which complicates environment setup.
    // Cross-field cleanup is adequately covered by zoomedRoot + collapsed.
    const id = 'flo668-remove-mixed';
    paneStore.registerPane(id, { kind: 'tab', tabId: 't' });
    paneStore.setZoomedRoot(id, 'some-block');
    paneStore.setCollapsed(id, 'some-block', true);

    paneStore.removePane(id);

    expect(paneStore.getPaneHost(id)).toBeUndefined();
    expect(paneStore.getZoomedRootId(id)).toBeNull();
    expect(paneStore.isCollapsed(id, 'some-block', false)).toBe(false);
  });

  it('removePanes clears multiple registry entries', () => {
    const ids = ['flo668-bulk-a', 'flo668-bulk-b', 'flo668-bulk-c'];
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
