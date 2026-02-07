/**
 * layoutTypes.test.ts - Pure tree operation tests
 *
 * Tests the binary tree model for split panes.
 * All functions are pure - no DOM, no framework, no mocking.
 */
import { describe, it, expect } from 'vitest';
import {
  findNode,
  findParent,
  findPath,
  findFirstLeaf,
  findLastLeaf,
  collectPaneIds,
  replaceNode,
  removeNode,
  findAdjacentPane,
  clampRatio,
  matchesDirection,
  getTargetChildIndex,
  moveLeafToTarget,
  moveLeafToRoot,
  generatePaneId,
  generateSplitId,
  createInitialLayout,
  type LayoutNode,
  type PaneLeaf,
  type PaneSplit,
} from './layoutTypes';

// --- Helpers ---

function createLeaf(id: string): PaneLeaf {
  return { type: 'leaf', id };
}

function createSplit(
  id: string,
  direction: 'horizontal' | 'vertical',
  first: LayoutNode,
  second: LayoutNode,
  ratio = 0.5
): PaneSplit {
  return {
    type: 'split',
    id,
    direction,
    ratio,
    children: [first, second],
  };
}

/**
 * Build a test tree:
 *
 *        split-root (horizontal)
 *           /    \
 *       pane-a   split-right (vertical)
 *                   /    \
 *               pane-b  pane-c
 */
function createTestTree(): PaneSplit {
  return createSplit(
    'split-root',
    'horizontal',
    createLeaf('pane-a'),
    createSplit(
      'split-right',
      'vertical',
      createLeaf('pane-b'),
      createLeaf('pane-c')
    )
  );
}

// --- Tests ---

describe('findNode', () => {
  it('finds root node by id', () => {
    const tree = createTestTree();
    const found = findNode(tree, 'split-root');
    expect(found?.id).toBe('split-root');
  });

  it('finds leaf node', () => {
    const tree = createTestTree();
    const found = findNode(tree, 'pane-b');
    expect(found?.type).toBe('leaf');
    expect(found?.id).toBe('pane-b');
  });

  it('finds nested split node', () => {
    const tree = createTestTree();
    const found = findNode(tree, 'split-right');
    expect(found?.type).toBe('split');
    expect((found as PaneSplit).direction).toBe('vertical');
  });

  it('returns null for non-existent id', () => {
    const tree = createTestTree();
    expect(findNode(tree, 'nonexistent')).toBeNull();
  });

  it('finds single leaf as root', () => {
    const leaf = createLeaf('solo');
    expect(findNode(leaf, 'solo')?.id).toBe('solo');
  });
});

describe('findParent', () => {
  it('returns null for root node', () => {
    const tree = createTestTree();
    expect(findParent(tree, 'split-root')).toBeNull();
  });

  it('finds parent of direct child', () => {
    const tree = createTestTree();
    const parent = findParent(tree, 'pane-a');
    expect(parent?.id).toBe('split-root');
  });

  it('finds parent of nested leaf', () => {
    const tree = createTestTree();
    const parent = findParent(tree, 'pane-c');
    expect(parent?.id).toBe('split-right');
  });

  it('finds parent of nested split', () => {
    const tree = createTestTree();
    const parent = findParent(tree, 'split-right');
    expect(parent?.id).toBe('split-root');
  });

  it('returns null for non-existent id', () => {
    const tree = createTestTree();
    expect(findParent(tree, 'ghost')).toBeNull();
  });

  it('returns null when root is a leaf', () => {
    const leaf = createLeaf('solo');
    expect(findParent(leaf, 'solo')).toBeNull();
  });
});

describe('findPath', () => {
  it('returns single-element path for root', () => {
    const tree = createTestTree();
    const path = findPath(tree, 'split-root');
    expect(path).toHaveLength(1);
    expect(path[0].id).toBe('split-root');
  });

  it('returns full path to nested leaf', () => {
    const tree = createTestTree();
    const path = findPath(tree, 'pane-c');
    expect(path.map(n => n.id)).toEqual(['split-root', 'split-right', 'pane-c']);
  });

  it('returns path to direct child', () => {
    const tree = createTestTree();
    const path = findPath(tree, 'pane-a');
    expect(path.map(n => n.id)).toEqual(['split-root', 'pane-a']);
  });

  it('returns empty array for non-existent id', () => {
    const tree = createTestTree();
    expect(findPath(tree, 'missing')).toEqual([]);
  });
});

describe('findFirstLeaf / findLastLeaf', () => {
  it('findFirstLeaf returns leftmost leaf', () => {
    const tree = createTestTree();
    expect(findFirstLeaf(tree).id).toBe('pane-a');
  });

  it('findLastLeaf returns rightmost leaf', () => {
    const tree = createTestTree();
    expect(findLastLeaf(tree).id).toBe('pane-c');
  });

  it('returns self when node is leaf', () => {
    const leaf = createLeaf('solo');
    expect(findFirstLeaf(leaf).id).toBe('solo');
    expect(findLastLeaf(leaf).id).toBe('solo');
  });

  it('handles deeply nested tree', () => {
    const deep = createSplit(
      's1',
      'horizontal',
      createSplit(
        's2',
        'vertical',
        createLeaf('deep-first'),
        createLeaf('mid')
      ),
      createLeaf('right')
    );
    expect(findFirstLeaf(deep).id).toBe('deep-first');
    expect(findLastLeaf(deep).id).toBe('right');
  });
});

describe('collectPaneIds', () => {
  it('collects all leaf ids from tree', () => {
    const tree = createTestTree();
    const ids = collectPaneIds(tree);
    expect(ids).toEqual(['pane-a', 'pane-b', 'pane-c']);
  });

  it('returns single id for leaf', () => {
    const leaf = createLeaf('solo');
    expect(collectPaneIds(leaf)).toEqual(['solo']);
  });

  it('preserves left-to-right order', () => {
    const tree = createSplit(
      'root',
      'horizontal',
      createLeaf('first'),
      createSplit(
        'nested',
        'horizontal',
        createLeaf('second'),
        createLeaf('third')
      )
    );
    expect(collectPaneIds(tree)).toEqual(['first', 'second', 'third']);
  });
});

describe('replaceNode', () => {
  it('replaces root node', () => {
    const tree = createTestTree();
    const newLeaf = createLeaf('replaced');
    const result = replaceNode(tree, 'split-root', newLeaf);
    expect(result.id).toBe('replaced');
    expect(result.type).toBe('leaf');
  });

  it('replaces nested leaf', () => {
    const tree = createTestTree();
    const newLeaf = createLeaf('new-b');
    const result = replaceNode(tree, 'pane-b', newLeaf) as PaneSplit;

    // Root unchanged
    expect(result.id).toBe('split-root');
    // pane-b replaced in split-right
    const splitRight = result.children[1] as PaneSplit;
    expect(splitRight.children[0].id).toBe('new-b');
  });

  it('replaces nested split with leaf', () => {
    const tree = createTestTree();
    const newLeaf = createLeaf('collapsed');
    const result = replaceNode(tree, 'split-right', newLeaf) as PaneSplit;

    expect(result.children[0].id).toBe('pane-a');
    expect(result.children[1].id).toBe('collapsed');
    expect(result.children[1].type).toBe('leaf');
  });

  it('returns unchanged tree when id not found', () => {
    const tree = createTestTree();
    const newLeaf = createLeaf('new');
    const result = replaceNode(tree, 'ghost', newLeaf);
    expect(collectPaneIds(result)).toEqual(['pane-a', 'pane-b', 'pane-c']);
  });

  it('is immutable - does not modify original', () => {
    const tree = createTestTree();
    const newLeaf = createLeaf('new-b');
    replaceNode(tree, 'pane-b', newLeaf);

    // Original still has pane-b
    expect(findNode(tree, 'pane-b')).not.toBeNull();
  });
});

describe('removeNode', () => {
  it('returns null when trying to remove root', () => {
    const tree = createTestTree();
    expect(removeNode(tree, 'split-root')).toBeNull();
  });

  it('collapses split when removing direct child', () => {
    const tree = createTestTree();
    const result = removeNode(tree, 'pane-a');

    // Root should become split-right (the sibling)
    expect(result?.id).toBe('split-right');
    expect(result?.type).toBe('split');
  });

  it('returns sibling when removing from two-pane split', () => {
    const simple = createSplit(
      'root',
      'horizontal',
      createLeaf('left'),
      createLeaf('right')
    );
    const result = removeNode(simple, 'left');
    expect(result?.id).toBe('right');
    expect(result?.type).toBe('leaf');
  });

  it('preserves tree structure when removing nested leaf', () => {
    const tree = createTestTree();
    const result = removeNode(tree, 'pane-b') as PaneSplit;

    // split-root still exists
    expect(result.id).toBe('split-root');
    // split-right collapsed to just pane-c
    expect(result.children[1].id).toBe('pane-c');
    expect(result.children[1].type).toBe('leaf');
  });

  it('returns same tree when id not found', () => {
    const tree = createTestTree();
    const result = removeNode(tree, 'ghost');
    expect(result).toBe(tree);
  });
});

describe('matchesDirection', () => {
  it('horizontal split matches left/right', () => {
    expect(matchesDirection('horizontal', 'left')).toBe(true);
    expect(matchesDirection('horizontal', 'right')).toBe(true);
  });

  it('horizontal split does not match up/down', () => {
    expect(matchesDirection('horizontal', 'up')).toBe(false);
    expect(matchesDirection('horizontal', 'down')).toBe(false);
  });

  it('vertical split matches up/down', () => {
    expect(matchesDirection('vertical', 'up')).toBe(true);
    expect(matchesDirection('vertical', 'down')).toBe(true);
  });

  it('vertical split does not match left/right', () => {
    expect(matchesDirection('vertical', 'left')).toBe(false);
    expect(matchesDirection('vertical', 'right')).toBe(false);
  });
});

describe('getTargetChildIndex', () => {
  it('returns 0 for left/up (first child)', () => {
    expect(getTargetChildIndex('left')).toBe(0);
    expect(getTargetChildIndex('up')).toBe(0);
  });

  it('returns 1 for right/down (second child)', () => {
    expect(getTargetChildIndex('right')).toBe(1);
    expect(getTargetChildIndex('down')).toBe(1);
  });
});

describe('findAdjacentPane', () => {
  it('finds right neighbor in horizontal split', () => {
    const tree = createTestTree();
    // pane-a is left, split-right (with pane-b, pane-c) is right
    const adjacent = findAdjacentPane(tree, 'pane-a', 'right');
    // Should find first leaf of split-right = pane-b
    expect(adjacent).toBe('pane-b');
  });

  it('finds left neighbor in horizontal split', () => {
    const tree = createTestTree();
    // Going left from pane-b should find pane-a
    const adjacent = findAdjacentPane(tree, 'pane-b', 'left');
    expect(adjacent).toBe('pane-a');
  });

  it('finds down neighbor in vertical split', () => {
    const tree = createTestTree();
    // pane-b and pane-c are in vertical split
    const adjacent = findAdjacentPane(tree, 'pane-b', 'down');
    expect(adjacent).toBe('pane-c');
  });

  it('finds up neighbor in vertical split', () => {
    const tree = createTestTree();
    const adjacent = findAdjacentPane(tree, 'pane-c', 'up');
    expect(adjacent).toBe('pane-b');
  });

  it('returns null when no neighbor in direction', () => {
    const tree = createTestTree();
    // pane-a is leftmost, no left neighbor
    expect(findAdjacentPane(tree, 'pane-a', 'left')).toBeNull();
    // pane-c is rightmost, no right neighbor
    expect(findAdjacentPane(tree, 'pane-c', 'right')).toBeNull();
  });

  it('returns null for non-existent pane', () => {
    const tree = createTestTree();
    expect(findAdjacentPane(tree, 'ghost', 'right')).toBeNull();
  });

  it('navigates across split boundaries', () => {
    // More complex: from pane-c going left should cross into pane-a
    const tree = createTestTree();
    const adjacent = findAdjacentPane(tree, 'pane-c', 'left');
    expect(adjacent).toBe('pane-a');
  });
});

describe('clampRatio', () => {
  it('clamps values below 0.1 to 0.1', () => {
    expect(clampRatio(0)).toBe(0.1);
    expect(clampRatio(-0.5)).toBe(0.1);
    expect(clampRatio(0.05)).toBe(0.1);
  });

  it('clamps values above 0.9 to 0.9', () => {
    expect(clampRatio(1)).toBe(0.9);
    expect(clampRatio(1.5)).toBe(0.9);
    expect(clampRatio(0.95)).toBe(0.9);
  });

  it('passes through valid values unchanged', () => {
    expect(clampRatio(0.1)).toBe(0.1);
    expect(clampRatio(0.5)).toBe(0.5);
    expect(clampRatio(0.9)).toBe(0.9);
  });
});

describe('moveLeafToTarget', () => {
  it('moves a pane to the left of target (horizontal split)', () => {
    const tree = createSplit(
      'root',
      'horizontal',
      createLeaf('left'),
      createLeaf('right')
    );

    const result = moveLeafToTarget(tree, 'right', 'left', 'left');
    expect(result).not.toBeNull();

    const moved = result as PaneSplit;
    expect(moved.type).toBe('split');
    expect(moved.direction).toBe('horizontal');
    expect(collectPaneIds(moved)).toEqual(['right', 'left']);
  });

  it('moves a pane to the right of target (horizontal split)', () => {
    const tree = createSplit(
      'root',
      'horizontal',
      createLeaf('left'),
      createLeaf('right')
    );

    const result = moveLeafToTarget(tree, 'left', 'right', 'right');
    expect(result).not.toBeNull();

    const moved = result as PaneSplit;
    expect(moved.type).toBe('split');
    expect(moved.direction).toBe('horizontal');
    expect(collectPaneIds(moved)).toEqual(['right', 'left']);
  });

  it('moves a pane below target (vertical split)', () => {
    const tree = createTestTree();
    const result = moveLeafToTarget(tree, 'pane-a', 'pane-c', 'down');
    expect(result).not.toBeNull();

    const moved = result as PaneSplit;
    expect(findNode(moved, 'pane-a')).not.toBeNull();
    expect(findNode(moved, 'pane-c')).not.toBeNull();

    const parentOfTarget = findParent(moved, 'pane-a');
    expect(parentOfTarget?.direction).toBe('vertical');
  });

  it('moves a pane above target (vertical split)', () => {
    const tree = createSplit(
      'root',
      'vertical',
      createLeaf('top'),
      createLeaf('bottom')
    );

    const result = moveLeafToTarget(tree, 'bottom', 'top', 'up');
    expect(result).not.toBeNull();

    const moved = result as PaneSplit;
    expect(moved.type).toBe('split');
    expect(moved.direction).toBe('vertical');
    expect(collectPaneIds(moved)).toEqual(['bottom', 'top']);
  });

  it('returns null when source and target are the same', () => {
    const tree = createTestTree();
    expect(moveLeafToTarget(tree, 'pane-a', 'pane-a', 'right')).toBeNull();
  });

  it('returns null when source does not exist', () => {
    const tree = createTestTree();
    expect(moveLeafToTarget(tree, 'ghost', 'pane-a', 'right')).toBeNull();
  });

  it('returns null when target does not exist', () => {
    const tree = createTestTree();
    expect(moveLeafToTarget(tree, 'pane-a', 'ghost', 'right')).toBeNull();
  });

  it('clones source and target leaves instead of reusing object identity', () => {
    const source = createLeaf('source');
    const target = createLeaf('target');
    const tree = createSplit('root', 'horizontal', source, target);

    const result = moveLeafToTarget(tree, 'source', 'target', 'right');
    expect(result).not.toBeNull();

    const moved = result as LayoutNode;
    const movedSource = findNode(moved, 'source');
    const movedTarget = findNode(moved, 'target');
    expect(movedSource).not.toBeNull();
    expect(movedTarget).not.toBeNull();
    expect(movedSource).not.toBe(source);
    expect(movedTarget).not.toBe(target);
  });
});

describe('moveLeafToRoot', () => {
  it('moves source to left: source left, remaining right', () => {
    const tree = createSplit(
      'root',
      'horizontal',
      createLeaf('left'),
      createLeaf('right')
    );

    const result = moveLeafToRoot(tree, 'right', 'left');
    expect(result).not.toBeNull();

    const moved = result as PaneSplit;
    expect(moved.type).toBe('split');
    expect(moved.direction).toBe('horizontal');
    // Source 'right' should be left child, remaining 'left' should be right child
    expect(collectPaneIds(moved)).toEqual(['right', 'left']);
  });

  it('moves source to right: remaining left, source right', () => {
    const tree = createSplit(
      'root',
      'horizontal',
      createLeaf('left'),
      createLeaf('right')
    );

    const result = moveLeafToRoot(tree, 'left', 'right');
    expect(result).not.toBeNull();

    const moved = result as PaneSplit;
    expect(moved.type).toBe('split');
    expect(moved.direction).toBe('horizontal');
    // Remaining 'right' should be left child, source 'left' should be right child
    expect(collectPaneIds(moved)).toEqual(['right', 'left']);
  });

  it('returns null when source is root (single pane)', () => {
    const leaf = createLeaf('solo');
    expect(moveLeafToRoot(leaf, 'solo', 'left')).toBeNull();
  });

  it('returns null when source does not exist', () => {
    const tree = createTestTree();
    expect(moveLeafToRoot(tree, 'ghost', 'left')).toBeNull();
  });

  it('preserves remaining tree structure for 3-pane nested tree', () => {
    // Tree: [A | (B / C)]
    const tree = createTestTree();

    // Move B to left edge → [B | (A / C)] where (A / C) is the remaining tree
    // But removeNode('pane-b') collapses split-right → remaining = [A | C]
    const result = moveLeafToRoot(tree, 'pane-b', 'left');
    expect(result).not.toBeNull();

    const moved = result as PaneSplit;
    // B is leftmost
    expect(findFirstLeaf(moved).id).toBe('pane-b');
    // A and C are still present
    expect(findNode(moved, 'pane-a')).not.toBeNull();
    expect(findNode(moved, 'pane-c')).not.toBeNull();
    expect(collectPaneIds(moved)).toHaveLength(3);
  });

  it('clones source leaf (no object identity reuse)', () => {
    const source = createLeaf('source');
    const other = createLeaf('other');
    const tree = createSplit('root', 'horizontal', source, other);

    const result = moveLeafToRoot(tree, 'source', 'left');
    expect(result).not.toBeNull();

    const movedSource = findNode(result!, 'source');
    expect(movedSource).not.toBeNull();
    expect(movedSource).not.toBe(source);
  });
});

describe('generatePaneId', () => {
  it('generates IDs with pane prefix and UUID format', () => {
    const id = generatePaneId();
    // UUID v4 format: pane-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
    expect(id).toMatch(/^pane-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('generates unique IDs', () => {
    const id1 = generatePaneId();
    const id2 = generatePaneId();
    expect(id1).not.toBe(id2);
  });
});

describe('generateSplitId', () => {
  it('generates IDs with split prefix and UUID format', () => {
    const id = generateSplitId();
    // UUID v4 format: split-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
    expect(id).toMatch(/^split-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});

describe('createInitialLayout', () => {
  it('creates single-pane layout for new tab', () => {
    const layout = createInitialLayout('tab-1');
    expect(layout.tabId).toBe('tab-1');
    expect(layout.root.type).toBe('leaf');
    expect(layout.activePaneId).toBe(layout.root.id);
  });

  it('generates unique pane ID for root', () => {
    const layout = createInitialLayout('tab-2');
    expect(layout.root.id).toMatch(/^pane-/);
  });
});
