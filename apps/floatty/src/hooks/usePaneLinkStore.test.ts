/**
 * Sidebar-source fallback for paneLinkStore.resolveLink.
 *
 * Bug surface (FLO-671 follow-up): the FLO-671 fix added a sidebar-host
 * fallback inside `resolveSameTabLink` (lib/navigation.ts), but its sibling
 * primitive `paneLinkStore.resolveLink` did not get the same fallback.
 *
 * Every chirp navigation surface (handleChirpNavigate, resolveTargetPane,
 * App.tsx deep-link, Cmd+Shift+L) goes through `resolveLink` directly and
 * therefore never sees `sidebarLinks[activeTab]`. From a sidebar pin the
 * caller `??`s back to `sourcePaneId` (the pin) and navigation lands in the
 * pin instead of the linked tab pane.
 *
 * These tests pin the contract that `resolveLink`, called from a sidebar
 * source, consults `sidebarLinks[activeTab]` and falls through to the
 * layout's first outliner — matching `resolveSameTabLink`'s behavior.
 *
 * paneLinkStore + paneStore + tabStore + layoutStore are module-level
 * createRoot singletons. Tests share the same instances, so each test uses
 * unique IDs and cleans up via afterEach.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { paneLinkStore } from './usePaneLinkStore';
import { paneStore } from './usePaneStore';
import { tabStore } from './useTabStore';
import { layoutStore } from './useLayoutStore';
import { resolveSameTabLink } from '../lib/navigation';
import type { TabLayout, PaneLeaf, PaneSplit } from '../lib/layoutTypes';

const cleanupPaneIds: string[] = [];
const cleanupTabIds: string[] = [];

// Reset shared singleton state before AND after every test so this file is
// resilient to previous-file pollution (paneStore.test.ts, useBacklinkNavigation.test.ts)
// and so a failing test does not leak state into the next.
function resetSharedState() {
  paneLinkStore.clearAllLinks();
  for (const id of cleanupPaneIds.splice(0)) {
    paneStore.removePane(id);
  }
  for (const tabId of cleanupTabIds.splice(0)) {
    layoutStore.removeLayout(tabId);
  }
  // hydrateTabs([], '') sets activeTabId to '' which is falsy — the
  // resolveLink sidebar branch guards on `if (activeTab)`.
  tabStore.hydrateTabs([], '');
}

beforeEach(resetSharedState);
afterEach(resetSharedState);

const trackPane = (id: string) => {
  cleanupPaneIds.push(id);
  return id;
};

const trackTab = (tabId: string) => {
  cleanupTabIds.push(tabId);
  return tabId;
};

/** Build a TabLayout whose root is a single outliner leaf. */
function outlinerLeafLayout(tabId: string, paneId: string): TabLayout {
  const leaf: PaneLeaf = { type: 'leaf', id: paneId, leafType: 'outliner' };
  return { tabId, root: leaf, activePaneId: paneId };
}

/** Build a TabLayout with a horizontal split (left + right outliners). */
function twoOutlinerLayout(tabId: string, leftId: string, rightId: string): TabLayout {
  const left: PaneLeaf = { type: 'leaf', id: leftId, leafType: 'outliner' };
  const right: PaneLeaf = { type: 'leaf', id: rightId, leafType: 'outliner' };
  const split: PaneSplit = {
    type: 'split',
    id: `${tabId}-split`,
    direction: 'horizontal',
    ratio: 0.5,
    children: [left, right],
  };
  return { tabId, root: split, activePaneId: leftId };
}

/** Build a TabLayout whose root is a single terminal leaf (no outliner). */
function terminalOnlyLayout(tabId: string, paneId: string): TabLayout {
  const leaf: PaneLeaf = { type: 'leaf', id: paneId, leafType: 'terminal' };
  return { tabId, root: leaf, activePaneId: paneId };
}

describe('paneLinkStore.resolveLink — sidebar-source fallback', () => {
  it('returns sidebarLinks[activeTab] when set (explicit Cmd+L target)', () => {
    const tabId = trackTab('plr-tab-explicit');
    const pinPaneId = trackPane('plr-pin-explicit');
    const targetPaneId = trackPane('plr-target-explicit');

    // Sidebar pin + tab-hosted target
    paneStore.registerPane(pinPaneId, { kind: 'sidebar' });
    paneStore.registerPane(targetPaneId, { kind: 'tab', tabId });

    // Tab + layout containing the target
    const layout = outlinerLeafLayout(tabId, targetPaneId);
    layoutStore.hydrateLayouts({ [tabId]: layout });
    tabStore.hydrateTabs([{ id: tabId, title: 'Test', ptyPid: null, isAlive: true }], tabId);

    // User pressed Cmd+L from the pin and picked targetPaneId
    paneLinkStore.setSidebarLink(tabId, targetPaneId);

    expect(paneLinkStore.resolveLink(pinPaneId)).toBe(targetPaneId);
  });

  it('falls back to the active tab\'s first outliner when no explicit sidebar link is set', () => {
    const tabId = trackTab('plr-tab-fallback');
    const pinPaneId = trackPane('plr-pin-fallback');
    const leftId = trackPane('plr-left-fallback');
    const rightId = trackPane('plr-right-fallback');

    paneStore.registerPane(pinPaneId, { kind: 'sidebar' });
    paneStore.registerPane(leftId, { kind: 'tab', tabId });
    paneStore.registerPane(rightId, { kind: 'tab', tabId });

    const layout = twoOutlinerLayout(tabId, leftId, rightId);
    layoutStore.hydrateLayouts({ [tabId]: layout });
    tabStore.hydrateTabs([{ id: tabId, title: 'Test', ptyPid: null, isAlive: true }], tabId);

    // No explicit sidebar link — fallback uses resolveSidebarTarget which
    // returns the FIRST outliner leaf encountered (left-to-right DFS).
    expect(paneLinkStore.resolveLink(pinPaneId)).toBe(leftId);
  });

  it('returns null when sidebarLinks target is the pin itself (self-loop guard)', () => {
    const tabId = trackTab('plr-tab-loop');
    const pinPaneId = trackPane('plr-pin-loop');

    paneStore.registerPane(pinPaneId, { kind: 'sidebar' });

    // Tab exists but has no outliner panes — only setting the sidebar link
    // to the pin itself. `resolveSidebarTarget` validates the link via
    // findTabIdByPaneId (returns null for sidebar source) → clears it.
    // Then layout fallback runs; with no layout registered, returns null.
    // The new resolveLink path returns null, NOT the pin.
    paneLinkStore.setSidebarLink(tabId, pinPaneId);
    tabStore.hydrateTabs([{ id: tabId, title: 'Test', ptyPid: null, isAlive: true }], tabId);

    expect(paneLinkStore.resolveLink(pinPaneId)).toBeNull();
  });

  it('returns null when there is no active tab', () => {
    const pinPaneId = trackPane('plr-pin-noactive');
    paneStore.registerPane(pinPaneId, { kind: 'sidebar' });

    // No tabStore.hydrateTabs call → activeTabId() is whatever the singleton
    // had previously. The afterEach hook resets to '' (empty string).
    // resolveLink's sidebar branch guards `if (activeTab)` → '' is falsy.
    expect(paneLinkStore.resolveLink(pinPaneId)).toBeNull();
  });

  it('returns null when the pin is unregistered (no host known)', () => {
    // No registerPane call → getPaneHost returns undefined → sidebar branch
    // guarded by `host?.kind === 'sidebar'` does not fire → returns null.
    const pinPaneId = 'plr-pin-unregistered';
    expect(paneLinkStore.resolveLink(pinPaneId)).toBeNull();
  });

  it('falls back to first outliner even when the tab is terminal-only (returns the terminal)', () => {
    // Documents the resolveSidebarTarget behavior: when no outliner exists,
    // it returns the first leaf overall (terminal). resolveLink mirrors this.
    const tabId = trackTab('plr-tab-terminal');
    const pinPaneId = trackPane('plr-pin-terminal');
    const terminalId = trackPane('plr-terminal');

    paneStore.registerPane(pinPaneId, { kind: 'sidebar' });
    paneStore.registerPane(terminalId, { kind: 'tab', tabId });

    const layout = terminalOnlyLayout(tabId, terminalId);
    layoutStore.hydrateLayouts({ [tabId]: layout });
    tabStore.hydrateTabs([{ id: tabId, title: 'Test', ptyPid: null, isAlive: true }], tabId);

    expect(paneLinkStore.resolveLink(pinPaneId)).toBe(terminalId);
  });
});

describe('paneLinkStore.resolveLink — regression: tab-hosted sources unchanged', () => {
  it('still returns the explicit pane link for tab-hosted sources', () => {
    const tabId = trackTab('plr-tab-regression');
    const sourceId = trackPane('plr-source-regression');
    const targetId = trackPane('plr-target-regression');

    paneStore.registerPane(sourceId, { kind: 'tab', tabId });
    paneStore.registerPane(targetId, { kind: 'tab', tabId });

    const layout = twoOutlinerLayout(tabId, sourceId, targetId);
    layoutStore.hydrateLayouts({ [tabId]: layout });
    tabStore.hydrateTabs([{ id: tabId, title: 'Test', ptyPid: null, isAlive: true }], tabId);

    paneLinkStore.setPaneLink(sourceId, targetId);

    expect(paneLinkStore.resolveLink(sourceId)).toBe(targetId);
  });

  it('returns null for tab-hosted source with no link set (no sidebar fallback fires)', () => {
    const tabId = trackTab('plr-tab-noprop');
    const sourceId = trackPane('plr-source-noprop');

    paneStore.registerPane(sourceId, { kind: 'tab', tabId });
    const layout = outlinerLeafLayout(tabId, sourceId);
    layoutStore.hydrateLayouts({ [tabId]: layout });
    tabStore.hydrateTabs([{ id: tabId, title: 'Test', ptyPid: null, isAlive: true }], tabId);

    expect(paneLinkStore.resolveLink(sourceId)).toBeNull();
  });

  it('block link still takes priority over pane link', () => {
    const tabId = trackTab('plr-tab-block');
    const sourceId = trackPane('plr-source-block');
    const paneTarget = trackPane('plr-pane-target-block');
    const blockTarget = trackPane('plr-block-target-block');
    const blockId = 'plr-block-id';

    paneStore.registerPane(sourceId, { kind: 'tab', tabId });
    paneStore.registerPane(paneTarget, { kind: 'tab', tabId });
    paneStore.registerPane(blockTarget, { kind: 'tab', tabId });

    const layout = twoOutlinerLayout(tabId, paneTarget, blockTarget);
    layoutStore.hydrateLayouts({ [tabId]: layout });
    tabStore.hydrateTabs([{ id: tabId, title: 'Test', ptyPid: null, isAlive: true }], tabId);

    paneLinkStore.setPaneLink(sourceId, paneTarget);
    paneLinkStore.setBlockLink(blockId, blockTarget);

    // Chain order: block link → pane link → sidebar fallback
    expect(paneLinkStore.resolveLink(sourceId, blockId)).toBe(blockTarget);
  });
});

describe('resolveSameTabLink — sidebar source preserves FLO-671 behavior', () => {
  it('routes sidebar-hosted source to its sidebar target (chirp + native parity)', () => {
    // After lifting the sidebar fallback into resolveLink, the same-tab guard
    // at the bottom of resolveSameTabLink would naively return sourcePaneId
    // for sidebar sources (sourceTab is null). This test pins the FLO-671
    // contract: native wikilink clicks from a sidebar pin must route to the
    // sidebar target, matching what chirp navigation already does.
    const tabId = trackTab('rstl-tab');
    const pinPaneId = trackPane('rstl-pin');
    const targetPaneId = trackPane('rstl-target');

    paneStore.registerPane(pinPaneId, { kind: 'sidebar' });
    paneStore.registerPane(targetPaneId, { kind: 'tab', tabId });
    layoutStore.hydrateLayouts({ [tabId]: outlinerLeafLayout(tabId, targetPaneId) });
    tabStore.hydrateTabs([{ id: tabId, title: 'Test', ptyPid: null, isAlive: true }], tabId);
    paneLinkStore.setSidebarLink(tabId, targetPaneId);

    expect(resolveSameTabLink(pinPaneId)).toBe(targetPaneId);
  });

  it('tab-hosted source still enforces same-tab guard', () => {
    // Cross-tab links from tab-hosted sources continue to fall back to the
    // source pane — the same-tab guard is the FLO-668 null-contract default
    // for tab-hosted resolutions and stays in place.
    const tabA = trackTab('rstl-tabA');
    const tabB = trackTab('rstl-tabB');
    const sourceId = trackPane('rstl-source-tabA');
    const crossTabTarget = trackPane('rstl-target-tabB');

    paneStore.registerPane(sourceId, { kind: 'tab', tabId: tabA });
    paneStore.registerPane(crossTabTarget, { kind: 'tab', tabId: tabB });
    layoutStore.hydrateLayouts({
      [tabA]: outlinerLeafLayout(tabA, sourceId),
      [tabB]: outlinerLeafLayout(tabB, crossTabTarget),
    });
    tabStore.hydrateTabs(
      [
        { id: tabA, title: 'A', ptyPid: null, isAlive: true },
        { id: tabB, title: 'B', ptyPid: null, isAlive: true },
      ],
      tabA,
    );
    paneLinkStore.setPaneLink(sourceId, crossTabTarget);

    // Cross-tab link → returns source (same-tab guard wins)
    expect(resolveSameTabLink(sourceId)).toBe(sourceId);
  });

  it('tab-hosted source with same-tab link returns the link', () => {
    const tabId = trackTab('rstl-tab-same');
    const sourceId = trackPane('rstl-source-same');
    const targetId = trackPane('rstl-target-same');

    paneStore.registerPane(sourceId, { kind: 'tab', tabId });
    paneStore.registerPane(targetId, { kind: 'tab', tabId });
    layoutStore.hydrateLayouts({ [tabId]: twoOutlinerLayout(tabId, sourceId, targetId) });
    tabStore.hydrateTabs([{ id: tabId, title: 'Test', ptyPid: null, isAlive: true }], tabId);
    paneLinkStore.setPaneLink(sourceId, targetId);

    expect(resolveSameTabLink(sourceId)).toBe(targetId);
  });
});
