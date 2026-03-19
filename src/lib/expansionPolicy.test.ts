import { describe, it, expect } from 'vitest';
import {
  countDescendantsToDepth,
  getAutoCollapseChildren,
  computeExpansion,
  SMART_EXPAND_THRESHOLD,
  type BlockStoreView,
  type PaneStoreView,
} from './expansionPolicy';

// ═══════════════════════════════════════════════════════════════
// TEST HELPERS
// ═══════════════════════════════════════════════════════════════

function makeBlockStore(blocks: Record<string, string[]>, rootIds?: string[]): BlockStoreView {
  const store: BlockStoreView = {
    blocks: {},
    rootIds: rootIds ?? [],
  };
  for (const [id, childIds] of Object.entries(blocks)) {
    store.blocks[id] = { childIds };
  }
  return store;
}

function makePaneStore(collapsedSet: Set<string> = new Set()): PaneStoreView {
  return {
    isCollapsed: (_paneId, blockId) => collapsedSet.has(blockId),
  };
}

// ═══════════════════════════════════════════════════════════════
// countDescendantsToDepth
// ═══════════════════════════════════════════════════════════════

describe('countDescendantsToDepth', () => {
  it('counts direct children at depth 1', () => {
    const store = makeBlockStore({
      root: ['a', 'b', 'c'],
      a: [], b: [], c: [],
    });
    expect(countDescendantsToDepth('root', 1, store)).toBe(3);
  });

  it('counts children and grandchildren at depth 2', () => {
    const store = makeBlockStore({
      root: ['a', 'b'],
      a: ['a1', 'a2'],
      b: ['b1'],
      a1: [], a2: [], b1: [],
    });
    // 2 children + 3 grandchildren = 5
    expect(countDescendantsToDepth('root', 2, store)).toBe(5);
  });

  it('stops at maxDepth', () => {
    const store = makeBlockStore({
      root: ['a'],
      a: ['a1'],
      a1: ['a11'],
      a11: [],
    });
    // depth 1: only count 'a' = 1
    expect(countDescendantsToDepth('root', 1, store)).toBe(1);
    // depth 2: 'a' + 'a1' = 2
    expect(countDescendantsToDepth('root', 2, store)).toBe(2);
    // depth 3: 'a' + 'a1' + 'a11' = 3
    expect(countDescendantsToDepth('root', 3, store)).toBe(3);
  });

  it('returns over_cap when exceeding bailAt', () => {
    const store = makeBlockStore({
      root: ['a', 'b', 'c', 'd', 'e'],
      a: [], b: [], c: [], d: [], e: [],
    });
    expect(countDescendantsToDepth('root', 1, store, 3)).toBe('over_cap');
  });

  it('returns exact count when at bailAt boundary', () => {
    const store = makeBlockStore({
      root: ['a', 'b', 'c'],
      a: [], b: [], c: [],
    });
    expect(countDescendantsToDepth('root', 1, store, 3)).toBe(3);
  });

  it('handles empty block', () => {
    const store = makeBlockStore({ root: [] });
    expect(countDescendantsToDepth('root', 1, store)).toBe(0);
  });

  it('handles missing block', () => {
    const store = makeBlockStore({});
    expect(countDescendantsToDepth('missing', 1, store)).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// getAutoCollapseChildren
// ═══════════════════════════════════════════════════════════════

describe('getAutoCollapseChildren', () => {
  it('returns empty for block with few children', () => {
    const store = makeBlockStore({
      root: ['a', 'b'],
      a: ['a1'], b: [],
      a1: [],
    });
    const result = getAutoCollapseChildren('root', store);
    expect(result).toEqual([]);
  });

  it('returns children with descendants when parent has many kids', () => {
    // Create parent with SMART_EXPAND_THRESHOLD children
    const childIds = Array.from({ length: SMART_EXPAND_THRESHOLD }, (_, i) => `c${i}`);
    const blocks: Record<string, string[]> = { root: childIds };
    for (const id of childIds) {
      blocks[id] = id === 'c0' ? ['grandchild'] : [];
    }
    blocks['grandchild'] = [];

    const store = makeBlockStore(blocks);
    const result = getAutoCollapseChildren('root', store);
    // Only c0 has children
    expect(result).toEqual(['c0']);
  });

  it('returns empty for missing block', () => {
    const store = makeBlockStore({});
    expect(getAutoCollapseChildren('missing', store)).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════
// computeExpansion — toggle trigger
// ═══════════════════════════════════════════════════════════════

describe('computeExpansion — toggle', () => {
  it('expands target with few children (no auto-collapse)', () => {
    const store = makeBlockStore({
      root: ['a', 'b'],
      a: ['a1'], b: [],
      a1: [],
    });
    const result = computeExpansion({
      targetId: 'root',
      trigger: 'toggle',
      blockStore: store,
      paneId: 'p1',
      paneStore: makePaneStore(),
    });
    expect(result.actions).toEqual([
      { blockId: 'root', collapsed: false },
    ]);
  });

  it('auto-collapses children with descendants when parent has many kids', () => {
    const childIds = Array.from({ length: 12 }, (_, i) => `c${i}`);
    const blocks: Record<string, string[]> = { root: childIds };
    for (const id of childIds) {
      blocks[id] = id === 'c0' || id === 'c5' ? ['gc'] : [];
    }
    blocks['gc'] = [];

    const store = makeBlockStore(blocks);
    const result = computeExpansion({
      targetId: 'root',
      trigger: 'toggle',
      blockStore: store,
      paneId: 'p1',
      paneStore: makePaneStore(),
    });

    // Target expanded + c0 and c5 collapsed
    expect(result.actions).toContainEqual({ blockId: 'root', collapsed: false });
    expect(result.actions).toContainEqual({ blockId: 'c0', collapsed: true });
    expect(result.actions).toContainEqual({ blockId: 'c5', collapsed: true });
  });
});

// ═══════════════════════════════════════════════════════════════
// computeExpansion — zoom trigger
// ═══════════════════════════════════════════════════════════════

describe('computeExpansion — zoom', () => {
  it('expands small subtree to depth 2', () => {
    const store = makeBlockStore({
      page: ['a', 'b'],
      a: ['a1'], b: [],
      a1: [],
    });
    const result = computeExpansion({
      targetId: 'page',
      trigger: 'zoom',
      blockStore: store,
      paneId: 'p1',
      paneStore: makePaneStore(),
    });

    // Target expanded, children expanded (depth 2)
    expect(result.actions).toContainEqual({ blockId: 'page', collapsed: false });
    expect(result.actions).toContainEqual({ blockId: 'a', collapsed: false });
    // b has no children so no action for it (leaf nodes are skipped by walk)
  });

  it('falls back to depth 1 for huge subtree and collapses children', () => {
    // Create a tree that exceeds EXPANSION_SIZE_CAP at depth 2
    const childIds = Array.from({ length: 200 }, (_, i) => `p${i}`);
    const blocks: Record<string, string[]> = { pages: childIds };
    for (const id of childIds) {
      // Each page has 3 children → 200 + 600 = 800 at depth 2
      const grandkids = [`${id}_a`, `${id}_b`, `${id}_c`];
      blocks[id] = grandkids;
      for (const gk of grandkids) blocks[gk] = [];
    }

    const store = makeBlockStore(blocks);
    const result = computeExpansion({
      targetId: 'pages',
      trigger: 'zoom',
      blockStore: store,
      paneId: 'p1',
      paneStore: makePaneStore(),
    });

    // Target expanded
    expect(result.actions).toContainEqual({ blockId: 'pages', collapsed: false });

    // Children with descendants should be collapsed (over_cap path)
    const collapseActions = result.actions.filter(a => a.collapsed);
    expect(collapseActions.length).toBe(200); // all 200 pages collapsed
  });
});

// ═══════════════════════════════════════════════════════════════
// computeExpansion — navigate trigger
// ═══════════════════════════════════════════════════════════════

describe('computeExpansion — navigate', () => {
  it('expands ancestor chain', () => {
    const store = makeBlockStore({});
    const result = computeExpansion({
      targetId: 'target',
      trigger: 'navigate',
      blockStore: store,
      paneId: 'p1',
      paneStore: makePaneStore(),
      ancestors: ['parent', 'grandparent', 'root'],
    });

    expect(result.actions).toEqual([
      { blockId: 'parent', collapsed: false },
      { blockId: 'grandparent', collapsed: false },
      { blockId: 'root', collapsed: false },
    ]);
  });

  it('caps ancestor expansion at 10 levels', () => {
    const store = makeBlockStore({});
    const ancestors = Array.from({ length: 15 }, (_, i) => `a${i}`);
    const result = computeExpansion({
      targetId: 'target',
      trigger: 'navigate',
      blockStore: store,
      paneId: 'p1',
      paneStore: makePaneStore(),
      ancestors,
    });

    expect(result.actions.length).toBe(10);
  });

  it('returns empty for no ancestors', () => {
    const store = makeBlockStore({});
    const result = computeExpansion({
      targetId: 'target',
      trigger: 'navigate',
      blockStore: store,
      paneId: 'p1',
      paneStore: makePaneStore(),
    });
    expect(result.actions).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════
// computeExpansion — keybind trigger
// ═══════════════════════════════════════════════════════════════

describe('computeExpansion — keybind', () => {
  it('expands to requested depth (bidirectional)', () => {
    const store = makeBlockStore({
      root: ['a'],
      a: ['a1'],
      a1: ['a11'],
      a11: [],
    });
    const result = computeExpansion({
      targetId: 'root',
      trigger: 'keybind',
      depth: 2,
      blockStore: store,
      paneId: 'p1',
      paneStore: makePaneStore(),
    });

    // depth 1: root expanded, depth 2: a expanded, depth 3 (a1): collapsed
    expect(result.actions).toContainEqual({ blockId: 'root', collapsed: false });
    expect(result.actions).toContainEqual({ blockId: 'a', collapsed: false });
    expect(result.actions).toContainEqual({ blockId: 'a1', collapsed: true });
  });

  it('caps at depth 1 when over size limit', () => {
    // Create tree that exceeds cap at requested depth
    const childIds = Array.from({ length: 200 }, (_, i) => `c${i}`);
    const blocks: Record<string, string[]> = { root: childIds };
    for (const id of childIds) {
      const grandkids = [`${id}_a`, `${id}_b`, `${id}_c`];
      blocks[id] = grandkids;
      for (const gk of grandkids) blocks[gk] = [];
    }

    const store = makeBlockStore(blocks);
    const result = computeExpansion({
      targetId: 'root',
      trigger: 'keybind',
      depth: 3,
      blockStore: store,
      paneId: 'p1',
      paneStore: makePaneStore(),
    });

    // Should cap at depth 1: root expanded, all children collapsed
    expect(result.actions).toContainEqual({ blockId: 'root', collapsed: false });
    const collapseActions = result.actions.filter(a => a.collapsed);
    expect(collapseActions.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// computeExpansion — startup trigger
// ═══════════════════════════════════════════════════════════════

describe('computeExpansion — startup', () => {
  it('returns empty actions (startup uses applyCollapseDepth)', () => {
    const store = makeBlockStore({});
    const result = computeExpansion({
      targetId: 'root',
      trigger: 'startup',
      blockStore: store,
      paneId: 'p1',
      paneStore: makePaneStore(),
    });
    expect(result.actions).toEqual([]);
  });
});
