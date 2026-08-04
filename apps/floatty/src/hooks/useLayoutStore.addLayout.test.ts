/**
 * FLO-83 — addLayout registry reconciliation.
 *
 * The preset-apply race: appendTabs lands → Terminal.tsx's "initialize a
 * layout for layout-less tabs" effect can create a DEFAULT layout for the
 * appended tab → addLayout replaces it. The default layout's pane must be
 * DEREGISTERED from the paneStore host registry, or it leaks forever
 * (findTabIdByPaneId keeps answering for a pane no layout contains).
 *
 * applyLayoutPreset also wraps the whole apply in one batch() so effects
 * can't interleave at all — this reconciliation is the second line of
 * defense, and the one that's unit-testable.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { layoutStore } from './useLayoutStore';
import { paneStore } from './usePaneStore';

describe('layoutStore.addLayout — registry reconciliation (FLO-83)', () => {
  const tabIds: string[] = [];

  afterEach(() => {
    for (const tabId of tabIds.splice(0)) {
      layoutStore.removeLayout(tabId);
    }
  });

  it('deregisters panes of a replaced default layout', () => {
    const tabId = 'flo83-race-tab';
    tabIds.push(tabId);
    // Stands in for the Terminal effect's default layout
    const defaultPaneId = layoutStore.initLayout(tabId);
    expect(paneStore.getPaneHost(defaultPaneId)).toBeTruthy();

    layoutStore.addLayout({
      tabId,
      root: { type: 'leaf', id: 'flo83-preset-pane', leafType: 'outliner' },
      activePaneId: 'flo83-preset-pane',
    });

    // Replaced default pane is gone from the registry; preset pane is in.
    expect(paneStore.getPaneHost(defaultPaneId)).toBeFalsy();
    expect(paneStore.getPaneHost('flo83-preset-pane')).toBeTruthy();
  });

  it('leaves other tabs and fresh adds untouched', () => {
    const tabId = 'flo83-fresh-tab';
    tabIds.push(tabId);
    // No existing layout — plain add, nothing to reconcile.
    layoutStore.addLayout({
      tabId,
      root: { type: 'leaf', id: 'flo83-fresh-pane', leafType: 'terminal' },
      activePaneId: 'flo83-fresh-pane',
    });
    expect(paneStore.getPaneHost('flo83-fresh-pane')).toBeTruthy();
    expect(layoutStore.layouts[tabId]?.activePaneId).toBe('flo83-fresh-pane');
  });
});
