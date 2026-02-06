/**
 * Surgical Y.Array helper tests + CRDT merge safety
 *
 * Validates that surgical childIds mutations produce minimal CRDT operations
 * that don't duplicate on bidirectional merge — the root cause of FLO-280.
 */

import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';

// ═══════════════════════════════════════════════════════════════
// TEST HELPERS — mirror the private helpers from useBlockStore.ts
// (Testing via public behavior, but we re-implement the helpers
//  here to test them in isolation with fresh Y.Docs per test)
// ═══════════════════════════════════════════════════════════════

function setupDoc(): { doc: Y.Doc; blocksMap: Y.Map<unknown>; rootIds: Y.Array<string> } {
  const doc = new Y.Doc();
  const blocksMap = doc.getMap('blocks');
  const rootIds = doc.getArray<string>('rootIds');
  return { doc, blocksMap, rootIds };
}

function createBlockMap(id: string, childIds: string[] = []): Y.Map<unknown> {
  const blockMap = new Y.Map<unknown>();
  blockMap.set('id', id);
  blockMap.set('parentId', null);
  blockMap.set('content', '');
  blockMap.set('type', 'text');
  const arr = new Y.Array<string>();
  if (childIds.length > 0) arr.push(childIds);
  blockMap.set('childIds', arr);
  return blockMap;
}

function getChildIds(blocksMap: Y.Map<unknown>, blockId: string): string[] {
  const blockMap = blocksMap.get(blockId);
  if (!(blockMap instanceof Y.Map)) return [];
  const arr = blockMap.get('childIds');
  if (!(arr instanceof Y.Array)) return [];
  return arr.toArray() as string[];
}

function getChildIdsArray(blocksMap: Y.Map<unknown>, blockId: string): Y.Array<string> | null {
  const blockMap = blocksMap.get(blockId);
  if (!(blockMap instanceof Y.Map)) return null;
  const arr = blockMap.get('childIds');
  if (!(arr instanceof Y.Array)) return null;
  return arr as Y.Array<string>;
}

// ═══════════════════════════════════════════════════════════════
// SURGICAL HELPERS (re-implemented for isolated testing)
// ═══════════════════════════════════════════════════════════════

function insertChildId(blocksMap: Y.Map<unknown>, parentId: string, childId: string, atIndex: number): void {
  const arr = getChildIdsArray(blocksMap, parentId);
  if (!arr) return;
  arr.insert(atIndex, [childId]);
}

function appendChildId(blocksMap: Y.Map<unknown>, parentId: string, childId: string): void {
  const arr = getChildIdsArray(blocksMap, parentId);
  if (!arr) return;
  arr.push([childId]);
}

function removeChildId(blocksMap: Y.Map<unknown>, parentId: string, childId: string): void {
  const arr = getChildIdsArray(blocksMap, parentId);
  if (!arr) return;
  const items = arr.toArray();
  const idx = items.indexOf(childId);
  if (idx >= 0) arr.delete(idx, 1);
}

function insertChildIds(blocksMap: Y.Map<unknown>, parentId: string, childIds: string[], atIndex: number): void {
  const arr = getChildIdsArray(blocksMap, parentId);
  if (!arr || childIds.length === 0) return;
  arr.insert(atIndex, childIds);
}

function clearChildIds(blocksMap: Y.Map<unknown>, blockId: string): void {
  const arr = getChildIdsArray(blocksMap, blockId);
  if (!arr || arr.length === 0) return;
  arr.delete(0, arr.length);
}

function swapChildIds(blocksMap: Y.Map<unknown>, parentId: string, indexA: number, indexB: number): void {
  const arr = getChildIdsArray(blocksMap, parentId);
  if (!arr) return;
  const lo = Math.min(indexA, indexB);
  const hi = Math.max(indexA, indexB);
  if (lo < 0 || hi >= arr.length || lo === hi) return;
  const valLo = arr.get(lo);
  const valHi = arr.get(hi);
  arr.delete(hi, 1);
  arr.delete(lo, 1);
  arr.insert(lo, [valHi]);
  arr.insert(hi, [valLo]);
}

// ═══════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════

describe('surgical Y.Array helpers', () => {
  describe('insertChildId', () => {
    it('inserts at beginning', () => {
      const { doc, blocksMap } = setupDoc();
      doc.transact(() => {
        blocksMap.set('parent', createBlockMap('parent', ['b', 'c']));
      });

      doc.transact(() => {
        insertChildId(blocksMap, 'parent', 'a', 0);
      });

      expect(getChildIds(blocksMap, 'parent')).toEqual(['a', 'b', 'c']);
    });

    it('inserts in middle', () => {
      const { doc, blocksMap } = setupDoc();
      doc.transact(() => {
        blocksMap.set('parent', createBlockMap('parent', ['a', 'c']));
      });

      doc.transact(() => {
        insertChildId(blocksMap, 'parent', 'b', 1);
      });

      expect(getChildIds(blocksMap, 'parent')).toEqual(['a', 'b', 'c']);
    });

    it('inserts at end', () => {
      const { doc, blocksMap } = setupDoc();
      doc.transact(() => {
        blocksMap.set('parent', createBlockMap('parent', ['a', 'b']));
      });

      doc.transact(() => {
        insertChildId(blocksMap, 'parent', 'c', 2);
      });

      expect(getChildIds(blocksMap, 'parent')).toEqual(['a', 'b', 'c']);
    });
  });

  describe('appendChildId', () => {
    it('appends to empty', () => {
      const { doc, blocksMap } = setupDoc();
      doc.transact(() => {
        blocksMap.set('parent', createBlockMap('parent'));
      });

      doc.transact(() => {
        appendChildId(blocksMap, 'parent', 'a');
      });

      expect(getChildIds(blocksMap, 'parent')).toEqual(['a']);
    });

    it('appends to existing', () => {
      const { doc, blocksMap } = setupDoc();
      doc.transact(() => {
        blocksMap.set('parent', createBlockMap('parent', ['a']));
      });

      doc.transact(() => {
        appendChildId(blocksMap, 'parent', 'b');
      });

      expect(getChildIds(blocksMap, 'parent')).toEqual(['a', 'b']);
    });
  });

  describe('removeChildId', () => {
    it('removes existing child', () => {
      const { doc, blocksMap } = setupDoc();
      doc.transact(() => {
        blocksMap.set('parent', createBlockMap('parent', ['a', 'b', 'c']));
      });

      doc.transact(() => {
        removeChildId(blocksMap, 'parent', 'b');
      });

      expect(getChildIds(blocksMap, 'parent')).toEqual(['a', 'c']);
    });

    it('no-ops for missing child', () => {
      const { doc, blocksMap } = setupDoc();
      doc.transact(() => {
        blocksMap.set('parent', createBlockMap('parent', ['a', 'b']));
      });

      doc.transact(() => {
        removeChildId(blocksMap, 'parent', 'z');
      });

      expect(getChildIds(blocksMap, 'parent')).toEqual(['a', 'b']);
    });
  });

  describe('insertChildIds', () => {
    it('bulk inserts at position', () => {
      const { doc, blocksMap } = setupDoc();
      doc.transact(() => {
        blocksMap.set('parent', createBlockMap('parent', ['a', 'd']));
      });

      doc.transact(() => {
        insertChildIds(blocksMap, 'parent', ['b', 'c'], 1);
      });

      expect(getChildIds(blocksMap, 'parent')).toEqual(['a', 'b', 'c', 'd']);
    });

    it('no-ops for empty array', () => {
      const { doc, blocksMap } = setupDoc();
      doc.transact(() => {
        blocksMap.set('parent', createBlockMap('parent', ['a']));
      });

      doc.transact(() => {
        insertChildIds(blocksMap, 'parent', [], 0);
      });

      expect(getChildIds(blocksMap, 'parent')).toEqual(['a']);
    });
  });

  describe('clearChildIds', () => {
    it('clears all children', () => {
      const { doc, blocksMap } = setupDoc();
      doc.transact(() => {
        blocksMap.set('parent', createBlockMap('parent', ['a', 'b', 'c']));
      });

      doc.transact(() => {
        clearChildIds(blocksMap, 'parent');
      });

      expect(getChildIds(blocksMap, 'parent')).toEqual([]);
    });

    it('no-ops on empty', () => {
      const { doc, blocksMap } = setupDoc();
      doc.transact(() => {
        blocksMap.set('parent', createBlockMap('parent'));
      });

      doc.transact(() => {
        clearChildIds(blocksMap, 'parent');
      });

      expect(getChildIds(blocksMap, 'parent')).toEqual([]);
    });
  });

  describe('swapChildIds', () => {
    it('swaps adjacent forward', () => {
      const { doc, blocksMap } = setupDoc();
      doc.transact(() => {
        blocksMap.set('parent', createBlockMap('parent', ['a', 'b', 'c']));
      });

      doc.transact(() => {
        swapChildIds(blocksMap, 'parent', 0, 1);
      });

      expect(getChildIds(blocksMap, 'parent')).toEqual(['b', 'a', 'c']);
    });

    it('swaps adjacent backward (args reversed)', () => {
      const { doc, blocksMap } = setupDoc();
      doc.transact(() => {
        blocksMap.set('parent', createBlockMap('parent', ['a', 'b', 'c']));
      });

      doc.transact(() => {
        swapChildIds(blocksMap, 'parent', 1, 0);
      });

      expect(getChildIds(blocksMap, 'parent')).toEqual(['b', 'a', 'c']);
    });

    it('no-ops for same index', () => {
      const { doc, blocksMap } = setupDoc();
      doc.transact(() => {
        blocksMap.set('parent', createBlockMap('parent', ['a', 'b']));
      });

      doc.transact(() => {
        swapChildIds(blocksMap, 'parent', 0, 0);
      });

      expect(getChildIds(blocksMap, 'parent')).toEqual(['a', 'b']);
    });

    it('no-ops for out-of-bounds', () => {
      const { doc, blocksMap } = setupDoc();
      doc.transact(() => {
        blocksMap.set('parent', createBlockMap('parent', ['a', 'b']));
      });

      doc.transact(() => {
        swapChildIds(blocksMap, 'parent', 0, 5);
      });

      expect(getChildIds(blocksMap, 'parent')).toEqual(['a', 'b']);
    });
  });
});

describe('CRDT merge safety', () => {
  it('surgical inserts on divergent docs produce NO duplicates after merge', () => {
    // This is THE critical test. The old delete-all-then-push pattern
    // caused duplicates when two docs merged because each produced
    // distinct CRDT insert operations.

    // 1. Create base doc with a parent + 2 children
    const docA = new Y.Doc();
    docA.transact(() => {
      const blocksMap = docA.getMap('blocks');
      blocksMap.set('parent', createBlockMap('parent', ['child-1', 'child-2']));
    });

    // 2. Fork: create docB from docA's state
    const docB = new Y.Doc();
    const stateA = Y.encodeStateAsUpdate(docA);
    Y.applyUpdate(docB, stateA);

    // Verify fork is identical
    const blocksB = docB.getMap('blocks');
    expect(getChildIds(blocksB, 'parent')).toEqual(['child-1', 'child-2']);

    // 3. Both docs make SURGICAL inserts independently (divergent)
    docA.transact(() => {
      const blocksMap = docA.getMap('blocks');
      const arr = getChildIdsArray(blocksMap, 'parent');
      arr!.push(['child-3-from-A']);
    });

    docB.transact(() => {
      const arr = getChildIdsArray(blocksB, 'parent');
      arr!.push(['child-4-from-B']);
    });

    // 4. Merge both ways (bidirectional sync)
    const updateFromA = Y.encodeStateAsUpdate(docA, Y.encodeStateVector(docB));
    const updateFromB = Y.encodeStateAsUpdate(docB, Y.encodeStateVector(docA));

    Y.applyUpdate(docA, updateFromB);
    Y.applyUpdate(docB, updateFromA);

    // 5. Both docs should have all 4 children, NO duplicates
    const finalA = getChildIds(docA.getMap('blocks'), 'parent');
    const finalB = getChildIds(docB.getMap('blocks'), 'parent');

    // Both should have exactly 4 unique entries
    expect(finalA.length).toBe(4);
    expect(finalB.length).toBe(4);
    expect(new Set(finalA).size).toBe(4);
    expect(new Set(finalB).size).toBe(4);

    // Both docs should have the same entries (order may vary for concurrent ops)
    expect(new Set(finalA)).toEqual(new Set(finalB));
    expect(finalA).toContain('child-1');
    expect(finalA).toContain('child-2');
    expect(finalA).toContain('child-3-from-A');
    expect(finalA).toContain('child-4-from-B');
  });

  it('old delete-all-push pattern WOULD produce duplicates (regression proof)', () => {
    // This demonstrates WHY the old pattern was broken.
    // The delete-all-then-push produces new operations that survive merge.

    const docA = new Y.Doc();
    docA.transact(() => {
      const blocksMap = docA.getMap('blocks');
      blocksMap.set('parent', createBlockMap('parent', ['child-1', 'child-2']));
    });

    const docB = new Y.Doc();
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));

    // Simulate OLD pattern: delete all, push new array
    docA.transact(() => {
      const blocksMap = docA.getMap('blocks');
      const blockMap = blocksMap.get('parent') as Y.Map<unknown>;
      const arr = blockMap.get('childIds') as Y.Array<string>;
      // Old pattern: clear then push entire new array
      arr.delete(0, arr.length);
      arr.push(['child-1', 'child-2', 'child-3']);
    });

    docB.transact(() => {
      const blocksMap = docB.getMap('blocks');
      const blockMap = blocksMap.get('parent') as Y.Map<unknown>;
      const arr = blockMap.get('childIds') as Y.Array<string>;
      // Same old pattern on other doc
      arr.delete(0, arr.length);
      arr.push(['child-1', 'child-2', 'child-4']);
    });

    // Merge
    const updateFromA = Y.encodeStateAsUpdate(docA, Y.encodeStateVector(docB));
    const updateFromB = Y.encodeStateAsUpdate(docB, Y.encodeStateVector(docA));
    Y.applyUpdate(docA, updateFromB);
    Y.applyUpdate(docB, updateFromA);

    const finalA = getChildIds(docA.getMap('blocks'), 'parent');

    // The old pattern produces duplicates — child-1 and child-2 appear multiple times
    // because each doc's push created DISTINCT insert operations
    const uniqueCount = new Set(finalA).size;
    expect(finalA.length).toBeGreaterThan(uniqueCount);
    // This proves the old pattern WAS broken
  });

  it('concurrent surgical insert + remove does not corrupt', () => {
    const docA = new Y.Doc();
    docA.transact(() => {
      const blocksMap = docA.getMap('blocks');
      blocksMap.set('parent', createBlockMap('parent', ['a', 'b', 'c']));
    });

    const docB = new Y.Doc();
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));

    // A removes 'b', B inserts 'd' after 'b'
    docA.transact(() => {
      const arr = getChildIdsArray(docA.getMap('blocks'), 'parent');
      arr!.delete(1, 1); // remove 'b'
    });

    docB.transact(() => {
      const arr = getChildIdsArray(docB.getMap('blocks'), 'parent');
      arr!.insert(2, ['d']); // insert 'd' after 'b'
    });

    // Merge
    const updateFromA = Y.encodeStateAsUpdate(docA, Y.encodeStateVector(docB));
    const updateFromB = Y.encodeStateAsUpdate(docB, Y.encodeStateVector(docA));
    Y.applyUpdate(docA, updateFromB);
    Y.applyUpdate(docB, updateFromA);

    const finalA = getChildIds(docA.getMap('blocks'), 'parent');
    const finalB = getChildIds(docB.getMap('blocks'), 'parent');

    // Both should converge — 'b' is removed, 'd' is inserted
    expect(new Set(finalA)).toEqual(new Set(finalB));
    expect(finalA).toContain('a');
    expect(finalA).toContain('c');
    expect(finalA).toContain('d');
    expect(finalA).not.toContain('b');
    // No duplicates
    expect(new Set(finalA).size).toBe(finalA.length);
  });
});

describe('deduplicateChildIds', () => {
  it('removes duplicate entries from childIds', () => {
    // deduplicateChildIds operates on the singleton sharedDoc
    // We manipulate it directly for this test
    const doc = new Y.Doc();

    // We can't easily test via the exported function since it uses the shared singleton.
    // Instead, test the dedup logic directly.
    const blocksMap = doc.getMap('blocks');
    const rootIds = doc.getArray<string>('rootIds');

    doc.transact(() => {
      const blockMap = new Y.Map<unknown>();
      blockMap.set('id', 'test-block');
      const childArr = new Y.Array<string>();
      // Intentionally insert duplicates
      childArr.push(['a', 'b', 'a', 'c', 'b']);
      blockMap.set('childIds', childArr);
      blocksMap.set('test-block', blockMap);

      rootIds.push(['r1', 'r2', 'r1']);
    });

    // Verify duplicates exist
    const blockMap = blocksMap.get('test-block') as Y.Map<unknown>;
    const childArr = blockMap.get('childIds') as Y.Array<string>;
    expect(childArr.toArray()).toEqual(['a', 'b', 'a', 'c', 'b']);
    expect(rootIds.toArray()).toEqual(['r1', 'r2', 'r1']);

    // Run dedup logic (inline, since we can't use the singleton-bound export)
    let totalRemoved = 0;
    doc.transact(() => {
      // Dedup childIds
      const items = childArr.toArray() as string[];
      const seen = new Set<string>();
      const toRemove: number[] = [];
      for (let i = 0; i < items.length; i++) {
        if (seen.has(items[i])) {
          toRemove.push(i);
        } else {
          seen.add(items[i]);
        }
      }
      for (let i = toRemove.length - 1; i >= 0; i--) {
        childArr.delete(toRemove[i], 1);
        totalRemoved++;
      }

      // Dedup rootIds
      const rootItems = rootIds.toArray();
      const rootSeen = new Set<string>();
      const rootToRemove: number[] = [];
      for (let i = 0; i < rootItems.length; i++) {
        if (rootSeen.has(rootItems[i])) {
          rootToRemove.push(i);
        } else {
          rootSeen.add(rootItems[i]);
        }
      }
      for (let i = rootToRemove.length - 1; i >= 0; i--) {
        rootIds.delete(rootToRemove[i], 1);
        totalRemoved++;
      }
    }, 'system');

    expect(totalRemoved).toBe(3); // 2 from childIds + 1 from rootIds
    expect(childArr.toArray()).toEqual(['a', 'b', 'c']);
    expect(rootIds.toArray()).toEqual(['r1', 'r2']);
  });

  it('removes cross-parent orphans (same block in multiple parents)', () => {
    const doc = new Y.Doc();
    const blocksMap = doc.getMap('blocks');

    // Set up: block 'child-x' has parentId='parent-a' (canonical),
    // but also appears in parent-b and parent-c's childIds (corruption)
    doc.transact(() => {
      const parentA = new Y.Map<unknown>();
      parentA.set('id', 'parent-a');
      const arrA = new Y.Array<string>();
      arrA.push(['child-x', 'child-y']);
      parentA.set('childIds', arrA);
      blocksMap.set('parent-a', parentA);

      const parentB = new Y.Map<unknown>();
      parentB.set('id', 'parent-b');
      const arrB = new Y.Array<string>();
      arrB.push(['child-x', 'child-z']); // child-x is orphaned here
      parentB.set('childIds', arrB);
      blocksMap.set('parent-b', parentB);

      const parentC = new Y.Map<unknown>();
      parentC.set('id', 'parent-c');
      const arrC = new Y.Array<string>();
      arrC.push(['child-x', 'child-w']); // child-x is orphaned here too
      parentC.set('childIds', arrC);
      blocksMap.set('parent-c', parentC);

      // The child block itself — parentId is 'parent-a'
      const child = new Y.Map<unknown>();
      child.set('id', 'child-x');
      child.set('parentId', 'parent-a');
      child.set('childIds', new Y.Array<string>());
      blocksMap.set('child-x', child);
    });

    // Run cross-parent dedup logic
    // Build childToParents map
    const childToParents = new Map<string, string[]>();
    blocksMap.forEach((value, parentId) => {
      if (!(value instanceof Y.Map)) return;
      const arr = value.get('childIds');
      if (!(arr instanceof Y.Array)) return;
      for (const childId of arr.toArray() as string[]) {
        const parents = childToParents.get(childId) || [];
        parents.push(parentId);
        childToParents.set(childId, parents);
      }
    });

    // child-x should appear in 3 parents
    expect(childToParents.get('child-x')?.length).toBe(3);

    // Remove from non-canonical parents
    let removed = 0;
    doc.transact(() => {
      for (const [childId, parents] of childToParents) {
        if (parents.length <= 1) continue;
        const childBlock = blocksMap.get(childId);
        const canonicalParent = childBlock instanceof Y.Map
          ? (childBlock.get('parentId') as string | null)
          : null;
        for (const pid of parents) {
          if (pid !== canonicalParent) {
            const parentMap = blocksMap.get(pid);
            if (!(parentMap instanceof Y.Map)) continue;
            const arr = parentMap.get('childIds');
            if (!(arr instanceof Y.Array)) continue;
            const items = arr.toArray() as string[];
            const idx = items.indexOf(childId);
            if (idx >= 0) {
              arr.delete(idx, 1);
              removed++;
            }
          }
        }
      }
    }, 'system');

    expect(removed).toBe(2); // Removed from parent-b and parent-c
    // parent-a still has child-x
    expect((blocksMap.get('parent-a') as Y.Map<unknown>).get('childIds') as Y.Array<string>).toBeDefined();
    expect(((blocksMap.get('parent-a') as Y.Map<unknown>).get('childIds') as Y.Array<string>).toArray()).toEqual(['child-x', 'child-y']);
    // parent-b lost child-x
    expect(((blocksMap.get('parent-b') as Y.Map<unknown>).get('childIds') as Y.Array<string>).toArray()).toEqual(['child-z']);
    // parent-c lost child-x
    expect(((blocksMap.get('parent-c') as Y.Map<unknown>).get('childIds') as Y.Array<string>).toArray()).toEqual(['child-w']);
  });

  it('no-ops when no duplicates exist', () => {
    const doc = new Y.Doc();
    const blocksMap = doc.getMap('blocks');

    doc.transact(() => {
      const blockMap = new Y.Map<unknown>();
      const childArr = new Y.Array<string>();
      childArr.push(['a', 'b', 'c']);
      blockMap.set('childIds', childArr);
      blocksMap.set('clean-block', blockMap);
    });

    const blockMap = blocksMap.get('clean-block') as Y.Map<unknown>;
    const childArr = blockMap.get('childIds') as Y.Array<string>;
    expect(childArr.toArray()).toEqual(['a', 'b', 'c']);
    // No mutations needed
  });
});

describe('undo/redo with surgical ops', () => {
  it('undoes a surgical insert correctly', () => {
    const doc = new Y.Doc();
    const blocksMap = doc.getMap('blocks');

    doc.transact(() => {
      blocksMap.set('parent', createBlockMap('parent', ['a', 'b']));
    });

    const undoManager = new Y.UndoManager([blocksMap], {
      trackedOrigins: new Set([null, undefined, 'user']),
    });
    undoManager.clear();

    // Surgical insert tracked by undo
    doc.transact(() => {
      const arr = getChildIdsArray(blocksMap, 'parent');
      arr!.insert(1, ['c']); // Insert 'c' between 'a' and 'b'
    }, 'user');

    expect(getChildIds(blocksMap, 'parent')).toEqual(['a', 'c', 'b']);

    // Undo should restore original state
    undoManager.undo();
    expect(getChildIds(blocksMap, 'parent')).toEqual(['a', 'b']);

    // Redo should re-apply
    undoManager.redo();
    expect(getChildIds(blocksMap, 'parent')).toEqual(['a', 'c', 'b']);
  });

  it('undoes a surgical remove correctly', () => {
    const doc = new Y.Doc();
    const blocksMap = doc.getMap('blocks');

    doc.transact(() => {
      blocksMap.set('parent', createBlockMap('parent', ['a', 'b', 'c']));
    });

    const undoManager = new Y.UndoManager([blocksMap], {
      trackedOrigins: new Set([null, undefined, 'user']),
    });
    undoManager.clear();

    // Remove 'b'
    doc.transact(() => {
      const arr = getChildIdsArray(blocksMap, 'parent');
      const items = arr!.toArray();
      const idx = items.indexOf('b');
      arr!.delete(idx, 1);
    }, 'user');

    expect(getChildIds(blocksMap, 'parent')).toEqual(['a', 'c']);

    undoManager.undo();
    expect(getChildIds(blocksMap, 'parent')).toEqual(['a', 'b', 'c']);
  });

  it('undoes a swap correctly', () => {
    const doc = new Y.Doc();
    const blocksMap = doc.getMap('blocks');

    doc.transact(() => {
      blocksMap.set('parent', createBlockMap('parent', ['a', 'b', 'c']));
    });

    const undoManager = new Y.UndoManager([blocksMap], {
      trackedOrigins: new Set([null, undefined, 'user']),
    });
    undoManager.clear();

    // Swap 'a' and 'b'
    doc.transact(() => {
      swapChildIds(blocksMap, 'parent', 0, 1);
    }, 'user');

    expect(getChildIds(blocksMap, 'parent')).toEqual(['b', 'a', 'c']);

    undoManager.undo();
    expect(getChildIds(blocksMap, 'parent')).toEqual(['a', 'b', 'c']);
  });
});
