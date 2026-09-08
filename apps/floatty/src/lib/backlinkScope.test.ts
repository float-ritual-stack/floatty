/**
 * U4 scope-stack fixtures from the design doc §U4 — synthetic, PII-free
 * (test-fixtures-no-pii.md).
 *
 * Outline shape used throughout:
 *   pages-root (`pages::` container)
 *     ├── page-a            (page)
 *     │     ├── child-plain (no inbound)
 *     │     └── child-hot   (has inbound)
 *     └── page-b            (page)
 * Plus `loose-block` living outside pages:: entirely.
 */
import { describe, it, expect } from 'vitest';
import type { BacklinkIndex } from './backlinkIndex';
import {
  nearestPageId,
  resolveBacklinkScope,
  type BacklinkScopeBlock,
} from './backlinkScope';

const PAGES = 'pages-root';

const blocks: Record<string, BacklinkScopeBlock> = {
  [PAGES]: { id: PAGES, parentId: null },
  'page-a': { id: 'page-a', parentId: PAGES },
  'page-b': { id: 'page-b', parentId: PAGES },
  'child-plain': { id: 'child-plain', parentId: 'page-a' },
  'child-hot': { id: 'child-hot', parentId: 'page-a' },
  'loose-block': { id: 'loose-block', parentId: null },
};

const getBlock = (id: string) => blocks[id] ?? null;

function indexOf(map: Record<string, string[]>): BacklinkIndex {
  return {
    referencing: (targetKey: string) => [...(map[targetKey] ?? [])],
    ambiguousTargets: [],
  };
}

describe('nearestPageId', () => {
  it('resolves the block itself when it is a page', () => {
    expect(nearestPageId('page-a', PAGES, getBlock)).toBe('page-a');
  });

  it('walks ancestors to the nearest page', () => {
    expect(nearestPageId('child-hot', PAGES, getBlock)).toBe('page-a');
  });

  it('returns null outside pages:: and on missing blocks', () => {
    expect(nearestPageId('loose-block', PAGES, getBlock)).toBeNull();
    expect(nearestPageId('ghost', PAGES, getBlock)).toBeNull();
    expect(nearestPageId('child-hot', null, getBlock)).toBeNull();
  });

  it('survives a parent-chain cycle', () => {
    const cyclic: Record<string, BacklinkScopeBlock> = {
      a: { id: 'a', parentId: 'b' },
      b: { id: 'b', parentId: 'a' },
    };
    expect(nearestPageId('a', PAGES, (id) => cyclic[id] ?? null)).toBeNull();
  });
});

describe('resolveBacklinkScope (design fixtures)', () => {
  it('focus on the page block yields ONE group — the page group wins the dedup', () => {
    const groups = resolveBacklinkScope({
      zoomedRootId: 'page-a',
      focusedBlockId: 'page-a',
      pagesContainerId: PAGES,
      index: indexOf({ 'page-a': ['src-1', 'src-2'] }),
      getBlock,
    });
    expect(groups).toEqual([
      { kind: 'page', targetId: 'page-a', sourceIds: ['src-1', 'src-2'] },
    ]);
  });

  it('focus on a child with no inbound yields the page group only', () => {
    const groups = resolveBacklinkScope({
      zoomedRootId: 'page-a',
      focusedBlockId: 'child-plain',
      pagesContainerId: PAGES,
      index: indexOf({ 'page-a': ['src-1'] }),
      getBlock,
    });
    expect(groups).toEqual([
      { kind: 'page', targetId: 'page-a', sourceIds: ['src-1'] },
    ]);
  });

  it('focus on a child with inbound yields focal group first, then page group', () => {
    const groups = resolveBacklinkScope({
      zoomedRootId: 'page-a',
      focusedBlockId: 'child-hot',
      pagesContainerId: PAGES,
      index: indexOf({ 'child-hot': ['src-3'], 'page-a': ['src-1'] }),
      getBlock,
    });
    expect(groups).toEqual([
      { kind: 'focal', targetId: 'child-hot', sourceIds: ['src-3'] },
      { kind: 'page', targetId: 'page-a', sourceIds: ['src-1'] },
    ]);
  });

  it('zoomed deep into a page still yields that page group (ask 3)', () => {
    const groups = resolveBacklinkScope({
      zoomedRootId: 'child-plain',
      focusedBlockId: null,
      pagesContainerId: PAGES,
      index: indexOf({ 'page-a': ['src-1'] }),
      getBlock,
    });
    expect(groups).toEqual([
      { kind: 'page', targetId: 'page-a', sourceIds: ['src-1'] },
    ]);
  });

  it('page group is present even with zero inbound (empty state is a feature, D6)', () => {
    const groups = resolveBacklinkScope({
      zoomedRootId: 'page-b',
      focusedBlockId: null,
      pagesContainerId: PAGES,
      index: indexOf({}),
      getBlock,
    });
    expect(groups).toEqual([
      { kind: 'page', targetId: 'page-b', sourceIds: [] },
    ]);
  });

  it('roots view (no zoom, no focus) yields no groups', () => {
    const groups = resolveBacklinkScope({
      zoomedRootId: null,
      focusedBlockId: null,
      pagesContainerId: PAGES,
      index: indexOf({ 'page-a': ['src-1'] }),
      getBlock,
    });
    expect(groups).toEqual([]);
  });

  it('a block outside pages:: yields focal-only groups', () => {
    const groups = resolveBacklinkScope({
      zoomedRootId: null,
      focusedBlockId: 'loose-block',
      pagesContainerId: PAGES,
      index: indexOf({ 'loose-block': ['src-9'] }),
      getBlock,
    });
    expect(groups).toEqual([
      { kind: 'focal', targetId: 'loose-block', sourceIds: ['src-9'] },
    ]);
  });

  it('dedups focused === zoomed into one focal group', () => {
    const groups = resolveBacklinkScope({
      zoomedRootId: 'child-hot',
      focusedBlockId: 'child-hot',
      pagesContainerId: PAGES,
      index: indexOf({ 'child-hot': ['src-3'] }),
      getBlock,
    });
    expect(groups.filter((g) => g.targetId === 'child-hot')).toHaveLength(1);
  });

  it('ignores focal candidates whose block no longer exists', () => {
    const groups = resolveBacklinkScope({
      zoomedRootId: null,
      focusedBlockId: 'ghost',
      pagesContainerId: PAGES,
      index: indexOf({ ghost: ['src-1'] }),
      getBlock,
    });
    expect(groups).toEqual([]);
  });
});
