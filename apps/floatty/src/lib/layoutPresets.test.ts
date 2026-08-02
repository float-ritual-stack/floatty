/**
 * FLO-83 — remapPresetIds is what makes preset application ADDITIVE and
 * repeatable: every workspace id gets a fresh identity on load, so applying
 * a preset twice (or over the live workspace it was saved from) can never
 * collide tab/pane ids. Block ids are outline addresses and must pass
 * through untouched.
 *
 * Fixtures are synthetic per .claude/rules/test-fixtures-no-pii.md.
 */
import { describe, it, expect } from 'vitest';
import { remapPresetIds, type PresetIdKind } from './layoutPresets';
import type { PersistedWorkspace } from '../hooks/useWorkspacePersistence';
import type { PaneSplit } from './layoutTypes';

/** Deterministic generator: tab-new-1, pane-new-1, split-new-1, … */
function makeGenId() {
  const counters: Record<PresetIdKind, number> = { tab: 0, pane: 0, split: 0 };
  return (kind: PresetIdKind) => `${kind}-new-${++counters[kind]}`;
}

function fixture(): PersistedWorkspace {
  return {
    version: 1,
    tabs: [{ id: 'tab-old-a', title: 'Demo Tab' }],
    activeTabId: 'tab-old-a',
    layouts: {
      'tab-old-a': {
        root: {
          type: 'split',
          id: 'split-old-1',
          direction: 'horizontal',
          ratio: 0.5,
          children: [
            { type: 'leaf', id: 'pane-old-1', leafType: 'outliner' },
            { type: 'leaf', id: 'pane-old-2', leafType: 'terminal', cwd: '/tmp/demo' },
          ],
        },
        activePaneId: 'pane-old-1',
      },
    },
    paneStates: {
      'pane-old-1': { zoomedRootId: 'block-uuid-untouched' },
    },
    collapsedState: { 'pane-old-1': { 'block-c': true } },
    focusedBlockId: { 'pane-old-2': 'block-f' },
  };
}

describe('remapPresetIds — FLO-83', () => {
  it('remaps tab, pane, and split ids consistently across the whole blob', () => {
    const out = remapPresetIds(fixture(), makeGenId());

    expect(out.tabs[0].id).toBe('tab-new-1');
    expect(out.activeTabId).toBe('tab-new-1');
    expect(Object.keys(out.layouts)).toEqual(['tab-new-1']);

    const root = out.layouts['tab-new-1'].root as PaneSplit;
    expect(root.id).toBe('split-new-1');
    expect(root.children[0]).toMatchObject({ type: 'leaf', id: 'pane-new-1' });
    expect(root.children[1]).toMatchObject({ type: 'leaf', id: 'pane-new-2' });
    // activePaneId reuses the tree walk's mapping — same old id, same new id
    expect(out.layouts['tab-new-1'].activePaneId).toBe('pane-new-1');
  });

  it('rewrites pane-keyed record keys but leaves block-id VALUES untouched', () => {
    const out = remapPresetIds(fixture(), makeGenId());

    expect(out.paneStates).toEqual({ 'pane-new-1': { zoomedRootId: 'block-uuid-untouched' } });
    expect(out.collapsedState).toEqual({ 'pane-new-1': { 'block-c': true } });
    expect(out.focusedBlockId).toEqual({ 'pane-new-2': 'block-f' });
  });

  it('preserves leaf payload fields (leafType, cwd) through the tree rewrite', () => {
    const out = remapPresetIds(fixture(), makeGenId());
    const root = out.layouts['tab-new-1'].root as PaneSplit;
    expect(root.children[1]).toMatchObject({ leafType: 'terminal', cwd: '/tmp/demo' });
    expect(root.ratio).toBe(0.5);
    expect(root.direction).toBe('horizontal');
  });

  it('two applications of the same preset produce disjoint id sets', () => {
    // Default crypto-random generator — the property that prevents the
    // double-apply collision.
    const a = remapPresetIds(fixture());
    const b = remapPresetIds(fixture());
    expect(a.tabs[0].id).not.toBe(b.tabs[0].id);
    expect(Object.keys(a.layouts)[0]).not.toBe(Object.keys(b.layouts)[0]);
    expect(a.layouts[Object.keys(a.layouts)[0]].activePaneId).not.toBe(
      b.layouts[Object.keys(b.layouts)[0]].activePaneId
    );
  });

  it('a record key with no mapping passes through instead of being dropped', () => {
    const f = fixture();
    f.paneStates['pane-orphan'] = { zoomedRootId: null };
    const out = remapPresetIds(f, makeGenId());
    expect(out.paneStates['pane-orphan']).toEqual({ zoomedRootId: null });
  });

  it('null activeTabId stays null', () => {
    const f = fixture();
    f.activeTabId = null;
    const out = remapPresetIds(f, makeGenId());
    expect(out.activeTabId).toBeNull();
  });
});
