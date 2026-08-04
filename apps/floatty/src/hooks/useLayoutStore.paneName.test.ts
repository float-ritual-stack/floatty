/**
 * FLO-862 — pane name survives a split and reaches persistence.
 *
 * splitPane reconstructs the source leaf field-by-field (it must clone off the
 * SolidJS proxy), so every PaneLeaf field has to be listed explicitly or it is
 * silently dropped. `name` was omitted, which meant: name a pane, split it, and
 * the source pane lost its name before workspace save ran.
 *
 * layoutStore is a module-level createRoot singleton, so each test uses a
 * unique tabId and tears it down via removeLayout.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { layoutStore } from './useLayoutStore';

describe('layoutStore — pane name across split (FLO-862)', () => {
  const tabIds: string[] = [];

  afterEach(() => {
    for (const tabId of tabIds.splice(0)) {
      layoutStore.removeLayout(tabId);
    }
  });

  const initTab = (tabId: string) => {
    tabIds.push(tabId);
    return layoutStore.initLayout(tabId);
  };

  it('keeps the source pane name after splitting, and serializes it', () => {
    const tabId = 'flo862-split-keeps-name';
    const paneId = initTab(tabId);

    layoutStore.setPaneName(tabId, paneId, 'nav');
    const newPaneId = layoutStore.splitPane(tabId, 'horizontal');
    expect(newPaneId).toBeTruthy();

    // Source leaf keeps its name; the fresh pane starts anonymous.
    expect(layoutStore.getPaneLeaf(tabId, paneId)?.name).toBe('nav');
    expect(layoutStore.getPaneLeaf(tabId, newPaneId!)?.name).toBeUndefined();

    // And it survives the persistence path (JSON clone through save/restore).
    const persisted = layoutStore.getLayoutsForPersistence()[tabId];
    expect(JSON.stringify(persisted.root)).toContain('"name":"nav"');
  });

  it('omits the name key entirely for unnamed panes', () => {
    const tabId = 'flo862-split-unnamed';
    const paneId = initTab(tabId);

    layoutStore.splitPane(tabId, 'vertical');

    const persisted = layoutStore.getLayoutsForPersistence()[tabId];
    expect(JSON.stringify(persisted.root)).not.toContain('"name"');
    expect(layoutStore.getPaneLeaf(tabId, paneId)?.name).toBeUndefined();
  });
});
