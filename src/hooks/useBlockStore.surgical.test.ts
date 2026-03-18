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

  it('re-homes parentId when canonical parent does not claim the block', () => {
    const doc = new Y.Doc();
    const blocksMap = doc.getMap('blocks');

    // Block declares parentId='stale-parent', but stale-parent doesn't have it.
    // Only 'real-parent-a' and 'real-parent-b' have it in childIds.
    doc.transact(() => {
      const staleParent = new Y.Map<unknown>();
      staleParent.set('id', 'stale-parent');
      staleParent.set('childIds', new Y.Array<string>()); // empty!
      blocksMap.set('stale-parent', staleParent);

      const realA = new Y.Map<unknown>();
      realA.set('id', 'real-parent-a');
      const arrA = new Y.Array<string>();
      arrA.push(['orphan-child', 'other-a']);
      realA.set('childIds', arrA);
      blocksMap.set('real-parent-a', realA);

      const realB = new Y.Map<unknown>();
      realB.set('id', 'real-parent-b');
      const arrB = new Y.Array<string>();
      arrB.push(['orphan-child', 'other-b']);
      realB.set('childIds', arrB);
      blocksMap.set('real-parent-b', realB);

      const child = new Y.Map<unknown>();
      child.set('id', 'orphan-child');
      child.set('parentId', 'stale-parent'); // stale!
      child.set('childIds', new Y.Array<string>());
      blocksMap.set('orphan-child', child);
    });

    // Run cross-parent logic (inline)
    const childToParents = new Map<string, string[]>();
    blocksMap.forEach((value, parentId) => {
      if (!(value instanceof Y.Map)) return;
      const arr = value.get('childIds');
      if (!(arr instanceof Y.Array)) return;
      for (const cid of arr.toArray() as string[]) {
        const p = childToParents.get(cid) || [];
        p.push(parentId);
        childToParents.set(cid, p);
      }
    });

    const removals: Array<{ parentId: string; childId: string }> = [];
    const updates: Array<{ childId: string; newParentId: string }> = [];

    for (const [childId, parents] of childToParents) {
      if (parents.length <= 1) continue;
      const childBlock = blocksMap.get(childId);
      const declared = childBlock instanceof Y.Map ? (childBlock.get('parentId') as string | null) : null;
      const declaredClaims = declared !== null && parents.includes(declared);
      const keep = declaredClaims ? declared : parents[0];
      if (keep !== declared) updates.push({ childId, newParentId: keep });
      for (const pid of parents) {
        if (pid !== keep) removals.push({ parentId: pid, childId });
      }
    }

    doc.transact(() => {
      for (const { parentId, childId } of removals) {
        const pm = blocksMap.get(parentId) as Y.Map<unknown>;
        const arr = pm.get('childIds') as Y.Array<string>;
        const idx = arr.toArray().indexOf(childId);
        if (idx >= 0) arr.delete(idx, 1);
      }
      for (const { childId, newParentId } of updates) {
        const cb = blocksMap.get(childId) as Y.Map<unknown>;
        cb.set('parentId', newParentId);
      }
    }, 'system');

    // orphan-child should now belong to real-parent-a (first in list)
    expect(updates.length).toBe(1);
    expect(updates[0].newParentId).toBe('real-parent-a');
    const child = blocksMap.get('orphan-child') as Y.Map<unknown>;
    expect(child.get('parentId')).toBe('real-parent-a');
    // real-parent-a still has it
    expect(((blocksMap.get('real-parent-a') as Y.Map<unknown>).get('childIds') as Y.Array<string>).toArray()).toContain('orphan-child');
    // real-parent-b lost it
    expect(((blocksMap.get('real-parent-b') as Y.Map<unknown>).get('childIds') as Y.Array<string>).toArray()).not.toContain('orphan-child');
  });

  it('removes phantom children (childIds referencing non-existent blocks)', () => {
    const doc = new Y.Doc();
    const blocksMap = doc.getMap('blocks');

    doc.transact(() => {
      const parent = new Y.Map<unknown>();
      parent.set('id', 'parent');
      const arr = new Y.Array<string>();
      arr.push(['real-child', 'phantom-1', 'real-child-2', 'phantom-2']);
      parent.set('childIds', arr);
      blocksMap.set('parent', parent);

      // Only create the real children — phantoms don't exist
      const child1 = new Y.Map<unknown>();
      child1.set('id', 'real-child');
      child1.set('childIds', new Y.Array<string>());
      blocksMap.set('real-child', child1);

      const child2 = new Y.Map<unknown>();
      child2.set('id', 'real-child-2');
      child2.set('childIds', new Y.Array<string>());
      blocksMap.set('real-child-2', child2);
    });

    // Detect phantoms
    const phantoms: Array<{ parentId: string; childId: string }> = [];
    blocksMap.forEach((value, parentId) => {
      if (!(value instanceof Y.Map)) return;
      const arr = value.get('childIds');
      if (!(arr instanceof Y.Array)) return;
      for (const cid of arr.toArray() as string[]) {
        if (!blocksMap.has(cid)) phantoms.push({ parentId, childId: cid });
      }
    });

    expect(phantoms.length).toBe(2);

    // Remove phantoms
    doc.transact(() => {
      for (const { parentId, childId } of phantoms) {
        const pm = blocksMap.get(parentId) as Y.Map<unknown>;
        const arr = pm.get('childIds') as Y.Array<string>;
        const idx = (arr.toArray() as string[]).indexOf(childId);
        if (idx >= 0) arr.delete(idx, 1);
      }
    }, 'system');

    const finalArr = (blocksMap.get('parent') as Y.Map<unknown>).get('childIds') as Y.Array<string>;
    expect(finalArr.toArray()).toEqual(['real-child', 'real-child-2']);
  });

  it('deletes orphan blocks (unreachable from any parent)', () => {
    const doc = new Y.Doc();
    const blocksMap = doc.getMap('blocks');
    const rootIds = doc.getArray<string>('rootIds');

    doc.transact(() => {
      rootIds.push(['root-1']);
      const root = new Y.Map<unknown>();
      root.set('id', 'root-1');
      const arr = new Y.Array<string>();
      arr.push(['child-1']);
      root.set('childIds', arr);
      blocksMap.set('root-1', root);

      const child = new Y.Map<unknown>();
      child.set('id', 'child-1');
      child.set('parentId', 'root-1');
      child.set('childIds', new Y.Array<string>());
      blocksMap.set('child-1', child);

      // Orphan: exists but not referenced by anyone
      const orphan = new Y.Map<unknown>();
      orphan.set('id', 'orphan-1');
      orphan.set('parentId', 'non-existent');
      orphan.set('content', 'ghost block');
      orphan.set('childIds', new Y.Array<string>());
      blocksMap.set('orphan-1', orphan);
    });

    expect(blocksMap.has('orphan-1')).toBe(true);

    // Detect orphans
    const referenced = new Set<string>(rootIds.toArray());
    blocksMap.forEach((value) => {
      if (!(value instanceof Y.Map)) return;
      const arr = value.get('childIds');
      if (!(arr instanceof Y.Array)) return;
      for (const cid of arr.toArray() as string[]) referenced.add(cid);
    });
    const orphans: string[] = [];
    blocksMap.forEach((_value, blockId) => {
      if (!referenced.has(blockId)) orphans.push(blockId);
    });

    expect(orphans).toEqual(['orphan-1']);

    // Delete orphans
    doc.transact(() => {
      for (const oid of orphans) blocksMap.delete(oid);
    }, 'system');

    expect(blocksMap.has('orphan-1')).toBe(false);
    expect(blocksMap.has('root-1')).toBe(true);
    expect(blocksMap.has('child-1')).toBe(true);
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

// ═══════════════════════════════════════════════════════════════
// FLO-498: Position-dependent outdent
// ═══════════════════════════════════════════════════════════════

function getValue(blocksMap: Y.Map<unknown>, blockId: string, field: string): unknown {
  const blockMap = blocksMap.get(blockId);
  if (!(blockMap instanceof Y.Map)) return undefined;
  return blockMap.get(field);
}

function setField(blocksMap: Y.Map<unknown>, blockId: string, field: string, value: unknown): void {
  const blockMap = blocksMap.get(blockId);
  if (!(blockMap instanceof Y.Map)) return;
  blockMap.set(field, value);
}

/**
 * Build a tree structure in a Y.Doc for outdent testing.
 *
 * Example: setupTree(doc, { root: ['parent'], parent: ['a', 'b', 'c'] })
 * Creates blocks root, parent, a, b, c with parent relationships and childIds.
 * Returns blocksMap and rootIds.
 */
function setupTree(
  doc: Y.Doc,
  tree: Record<string, string[]>,
  rootIds: string[] = Object.keys(tree).filter(id => {
    // Roots are keys that aren't anyone's child
    const allChildren = Object.values(tree).flat();
    return !allChildren.includes(id);
  }),
): { blocksMap: Y.Map<unknown>; rootIdsArr: Y.Array<string> } {
  const blocksMap = doc.getMap('blocks');
  const rootIdsArr = doc.getArray<string>('rootIds');

  doc.transact(() => {
    // Create all blocks
    for (const [id, children] of Object.entries(tree)) {
      blocksMap.set(id, createBlockMap(id, children));
    }
    // Create leaf blocks that aren't keys in tree
    const allChildren = Object.values(tree).flat();
    for (const childId of allChildren) {
      if (!tree[childId]) {
        blocksMap.set(childId, createBlockMap(childId));
      }
    }
    // Set parentIds
    for (const [parentId, children] of Object.entries(tree)) {
      for (const childId of children) {
        setField(blocksMap, childId, 'parentId', parentId);
      }
    }
    // Set rootIds
    rootIdsArr.push(rootIds);
    // Roots have null parentId (already default)
  });

  return { blocksMap, rootIdsArr };
}

/**
 * Simulate simple outdent: extract block from parent, insert after parent.
 * This mirrors _outdentBlockSimple in useBlockStore.ts.
 */
function simpleOutdent(doc: Y.Doc, blocksMap: Y.Map<unknown>, rootIdsArr: Y.Array<string>, id: string): void {
  const blockMap = blocksMap.get(id) as Y.Map<unknown>;
  const parentId = blockMap.get('parentId') as string;
  const parentMap = blocksMap.get(parentId) as Y.Map<unknown>;
  const grandparentId = parentMap.get('parentId') as string | null;

  doc.transact(() => {
    removeChildId(blocksMap, parentId, id);

    if (grandparentId) {
      const gpChildIds = getChildIds(blocksMap, grandparentId);
      const parentIndex = gpChildIds.indexOf(parentId);
      insertChildId(blocksMap, grandparentId, id, parentIndex + 1);
    } else {
      const arr = rootIdsArr.toArray();
      const parentIndex = arr.indexOf(parentId);
      rootIdsArr.insert(parentIndex + 1, [id]);
    }

    setField(blocksMap, id, 'parentId', grandparentId);
  }, 'user');
}

/**
 * Simulate position-dependent outdent (FLO-498):
 * - First child: extract + adopt younger siblings
 * - Non-first child: simple extract
 */
function positionDependentOutdent(
  doc: Y.Doc, blocksMap: Y.Map<unknown>, rootIdsArr: Y.Array<string>, id: string,
): void {
  const blockMap = blocksMap.get(id) as Y.Map<unknown>;
  const parentId = blockMap.get('parentId') as string;
  const parentMap = blocksMap.get(parentId) as Y.Map<unknown>;
  const grandparentId = parentMap.get('parentId') as string | null;

  // Get siblings BEFORE mutation
  const siblings = getChildIds(blocksMap, parentId);
  const myIndex = siblings.indexOf(id);

  if (myIndex !== 0) {
    simpleOutdent(doc, blocksMap, rootIdsArr, id);
    return;
  }

  // First child: extract and adopt
  const youngerSiblingIds = siblings.slice(1);
  const existingChildIds = getChildIds(blocksMap, id);

  doc.transact(() => {
    // Remove self from parent
    removeChildId(blocksMap, parentId, id);

    // Remove younger siblings from parent (reverse for stable indices)
    for (let i = youngerSiblingIds.length - 1; i >= 0; i--) {
      removeChildId(blocksMap, parentId, youngerSiblingIds[i]);
    }

    // Adopt younger siblings after existing children
    if (youngerSiblingIds.length > 0) {
      insertChildIds(blocksMap, id, youngerSiblingIds, existingChildIds.length);
      for (const sibId of youngerSiblingIds) {
        setField(blocksMap, sibId, 'parentId', id);
      }
    }

    // Insert self after parent
    if (grandparentId) {
      const gpChildIds = getChildIds(blocksMap, grandparentId);
      const parentIndex = gpChildIds.indexOf(parentId);
      insertChildId(blocksMap, grandparentId, id, parentIndex + 1);
    } else {
      const arr = rootIdsArr.toArray();
      const parentIndex = arr.indexOf(parentId);
      rootIdsArr.insert(parentIndex + 1, [id]);
    }

    setField(blocksMap, id, 'parentId', grandparentId);
  }, 'user');
}

describe('FLO-498: position-dependent outdent', () => {
  describe('non-first child (simple extract)', () => {
    it('extracts middle child without affecting siblings', () => {
      // parent: [a, b, c] → outdent b → parent: [a, c], b is sibling after parent
      const doc = new Y.Doc();
      const { blocksMap, rootIdsArr } = setupTree(doc, { parent: ['a', 'b', 'c'] });

      positionDependentOutdent(doc, blocksMap, rootIdsArr, 'b');

      expect(getChildIds(blocksMap, 'parent')).toEqual(['a', 'c']);
      expect(rootIdsArr.toArray()).toEqual(['parent', 'b']);
      expect(getValue(blocksMap, 'b', 'parentId')).toBeNull();
    });

    it('extracts last child without affecting siblings', () => {
      // parent: [a, b, c] → outdent c → parent: [a, b], c is sibling after parent
      const doc = new Y.Doc();
      const { blocksMap, rootIdsArr } = setupTree(doc, { parent: ['a', 'b', 'c'] });

      positionDependentOutdent(doc, blocksMap, rootIdsArr, 'c');

      expect(getChildIds(blocksMap, 'parent')).toEqual(['a', 'b']);
      expect(rootIdsArr.toArray()).toEqual(['parent', 'c']);
    });
  });

  describe('first child (extract and adopt)', () => {
    it('adopts younger siblings as children', () => {
      // parent: [a, b, c] → outdent a → parent: [], a: [b, c], a is sibling after parent
      const doc = new Y.Doc();
      const { blocksMap, rootIdsArr } = setupTree(doc, { parent: ['a', 'b', 'c'] });

      positionDependentOutdent(doc, blocksMap, rootIdsArr, 'a');

      expect(getChildIds(blocksMap, 'parent')).toEqual([]);
      expect(getChildIds(blocksMap, 'a')).toEqual(['b', 'c']);
      expect(rootIdsArr.toArray()).toEqual(['parent', 'a']);
      expect(getValue(blocksMap, 'b', 'parentId')).toBe('a');
      expect(getValue(blocksMap, 'c', 'parentId')).toBe('a');
      expect(getValue(blocksMap, 'a', 'parentId')).toBeNull();
    });

    it('only child acts as simple extract (no siblings to adopt)', () => {
      // parent: [a] → outdent a → parent: [], a is sibling after parent
      const doc = new Y.Doc();
      const { blocksMap, rootIdsArr } = setupTree(doc, { parent: ['a'] });

      positionDependentOutdent(doc, blocksMap, rootIdsArr, 'a');

      expect(getChildIds(blocksMap, 'parent')).toEqual([]);
      expect(getChildIds(blocksMap, 'a')).toEqual([]);
      expect(rootIdsArr.toArray()).toEqual(['parent', 'a']);
    });

    it('adopted siblings go AFTER existing children', () => {
      // parent: [a, b, c], a: [x, y] → outdent a → a: [x, y, b, c]
      const doc = new Y.Doc();
      const { blocksMap, rootIdsArr } = setupTree(doc, {
        parent: ['a', 'b', 'c'],
        a: ['x', 'y'],
      });

      positionDependentOutdent(doc, blocksMap, rootIdsArr, 'a');

      expect(getChildIds(blocksMap, 'a')).toEqual(['x', 'y', 'b', 'c']);
      expect(getChildIds(blocksMap, 'parent')).toEqual([]);
      expect(getValue(blocksMap, 'b', 'parentId')).toBe('a');
      expect(getValue(blocksMap, 'c', 'parentId')).toBe('a');
      // Existing children's parentId unchanged
      expect(getValue(blocksMap, 'x', 'parentId')).toBe('a');
    });

    it('works in nested context (grandparent exists)', () => {
      // grandparent: [parent], parent: [a, b] → outdent a
      // → grandparent: [parent, a], a: [b]
      const doc = new Y.Doc();
      const { blocksMap, rootIdsArr } = setupTree(doc, {
        grandparent: ['parent'],
        parent: ['a', 'b'],
      });

      positionDependentOutdent(doc, blocksMap, rootIdsArr, 'a');

      expect(getChildIds(blocksMap, 'grandparent')).toEqual(['parent', 'a']);
      expect(getChildIds(blocksMap, 'parent')).toEqual([]);
      expect(getChildIds(blocksMap, 'a')).toEqual(['b']);
      expect(getValue(blocksMap, 'a', 'parentId')).toBe('grandparent');
      expect(getValue(blocksMap, 'b', 'parentId')).toBe('a');
    });
  });

  describe('atomic undo', () => {
    it('first-child outdent is one undo step', () => {
      const doc = new Y.Doc();
      const { blocksMap, rootIdsArr } = setupTree(doc, { parent: ['a', 'b', 'c'] });

      const undoManager = new Y.UndoManager([blocksMap, rootIdsArr], {
        trackedOrigins: new Set(['user']),
      });
      undoManager.clear();

      positionDependentOutdent(doc, blocksMap, rootIdsArr, 'a');

      // Should be exactly 1 undo step
      expect(undoManager.undoStack.length).toBe(1);

      // Undo should restore original state
      undoManager.undo();

      expect(getChildIds(blocksMap, 'parent')).toEqual(['a', 'b', 'c']);
      expect(getChildIds(blocksMap, 'a')).toEqual([]);
      expect(rootIdsArr.toArray()).toEqual(['parent']);
      expect(getValue(blocksMap, 'a', 'parentId')).toBe('parent');
      expect(getValue(blocksMap, 'b', 'parentId')).toBe('parent');
      expect(getValue(blocksMap, 'c', 'parentId')).toBe('parent');
    });
  });

  describe('moveBlockUp/Down escape uses simple outdent', () => {
    it('simple outdent does NOT adopt siblings when first child', () => {
      // This verifies the moveBlockUp/Down escape path behavior:
      // first child + simpleOutdent → just extract, siblings stay with parent
      const doc = new Y.Doc();
      const { blocksMap, rootIdsArr } = setupTree(doc, { parent: ['a', 'b', 'c'] });

      simpleOutdent(doc, blocksMap, rootIdsArr, 'a');

      expect(getChildIds(blocksMap, 'parent')).toEqual(['b', 'c']);
      expect(getChildIds(blocksMap, 'a')).toEqual([]);
      expect(rootIdsArr.toArray()).toEqual(['parent', 'a']);
      // b and c stay with parent
      expect(getValue(blocksMap, 'b', 'parentId')).toBe('parent');
      expect(getValue(blocksMap, 'c', 'parentId')).toBe('parent');
    });
  });

  describe('CRDT merge safety', () => {
    it('first-child outdent with surgical mutations survives bidirectional merge', () => {
      const docA = new Y.Doc();
      const { blocksMap: blocksA, rootIdsArr: rootA } = setupTree(docA, {
        parent: ['a', 'b', 'c'],
      });

      // Fork
      const docB = new Y.Doc();
      Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));

      // A: outdent first child (extract + adopt)
      positionDependentOutdent(docA, blocksA, rootA, 'a');

      // B: add a new child to parent (concurrent edit)
      const blocksB = docB.getMap('blocks');
      docB.transact(() => {
        appendChildId(blocksB, 'parent', 'd');
        blocksB.set('d', createBlockMap('d'));
        setField(blocksB, 'd', 'parentId', 'parent');
      }, 'user');

      // Merge
      const updateFromA = Y.encodeStateAsUpdate(docA, Y.encodeStateVector(docB));
      const updateFromB = Y.encodeStateAsUpdate(docB, Y.encodeStateVector(docA));
      Y.applyUpdate(docA, updateFromB);
      Y.applyUpdate(docB, updateFromA);

      // Both docs should converge — no duplicates
      const finalARoots = rootA.toArray();
      const finalAParentChildren = getChildIds(blocksA, 'parent');
      const finalAChildren = getChildIds(blocksA, 'a');

      // No duplicates in any array
      expect(new Set(finalARoots).size).toBe(finalARoots.length);
      expect(new Set(finalAParentChildren).size).toBe(finalAParentChildren.length);
      expect(new Set(finalAChildren).size).toBe(finalAChildren.length);

      // 'a' should be a root-level sibling of parent
      expect(finalARoots).toContain('parent');
      expect(finalARoots).toContain('a');

      // 'b' and 'c' should be children of 'a' (adopted)
      expect(finalAChildren).toContain('b');
      expect(finalAChildren).toContain('c');

      // Verify docB converged to same state
      const rootB = docB.getArray<string>('rootIds');
      const finalBRoots = rootB.toArray();
      const finalBParentChildren = getChildIds(blocksB, 'parent');
      const finalBChildren = getChildIds(blocksB, 'a');

      // No duplicates in docB
      expect(new Set(finalBRoots).size).toBe(finalBRoots.length);
      expect(new Set(finalBParentChildren).size).toBe(finalBParentChildren.length);
      expect(new Set(finalBChildren).size).toBe(finalBChildren.length);

      // Same structural assertions
      expect(finalBRoots).toContain('parent');
      expect(finalBRoots).toContain('a');
      expect(finalBChildren).toContain('b');
      expect(finalBChildren).toContain('c');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // mergeBlocks — atomic merge: lift children + merge content + delete source
  // ═══════════════════════════════════════════════════════════════

  describe('mergeBlocks', () => {
    /**
     * Re-implements mergeBlocks from useBlockStore.ts for isolated Y.Doc testing.
     * Mirrors the atomic transaction: lift source children → merge content → delete source.
     */
    function mergeBlocks(
      doc: Y.Doc,
      blocksMap: Y.Map<unknown>,
      rootIdsArr: Y.Array<string>,
      targetId: string,
      sourceId: string,
    ): boolean {
      if (targetId === sourceId) return false;

      const targetMap = blocksMap.get(targetId);
      const sourceMap = blocksMap.get(sourceId);
      if (!(targetMap instanceof Y.Map) || !(sourceMap instanceof Y.Map)) return false;

      const childrenToLift = getChildIds(blocksMap, sourceId);
      const targetContent = (targetMap.get('content') as string) || '';
      const sourceContent = (sourceMap.get('content') as string) || '';
      const targetParentId = targetMap.get('parentId') as string | null;
      const sourceParentId = sourceMap.get('parentId') as string | null;

      let success = true;

      doc.transact(() => {
        // 1. Lift source's children to be siblings after target
        let liftOk = true;
        if (childrenToLift.length > 0) {
          liftOk = false;

          if (targetParentId) {
            const parentData = blocksMap.get(targetParentId);
            if (parentData instanceof Y.Map) {
              const parentChildIds = getChildIds(blocksMap, targetParentId);
              const afterIndex = parentChildIds.indexOf(targetId);
              if (afterIndex >= 0) {
                clearChildIds(blocksMap, sourceId);
                insertChildIds(blocksMap, targetParentId, childrenToLift, afterIndex + 1);
                liftOk = true;
              }
            }
          } else {
            const arr = rootIdsArr.toArray();
            const afterIndex = arr.indexOf(targetId);
            if (afterIndex >= 0) {
              clearChildIds(blocksMap, sourceId);
              rootIdsArr.insert(afterIndex + 1, childrenToLift);
              liftOk = true;
            }
          }

          if (liftOk) {
            for (const childId of childrenToLift) {
              setField(blocksMap, childId, 'parentId', targetParentId);
            }
          }
        }

        if (!liftOk) {
          success = false;
          return;
        }

        // 2. Merge content
        const separator = (targetContent && sourceContent) ? '\n' : '';
        const mergedContent = targetContent + separator + sourceContent;
        setField(blocksMap, targetId, 'content', mergedContent);

        // 3. Delete source
        if (sourceParentId) {
          removeChildId(blocksMap, sourceParentId, sourceId);
        } else {
          const arr = rootIdsArr.toArray();
          const index = arr.indexOf(sourceId);
          if (index >= 0) {
            rootIdsArr.delete(index, 1);
          }
        }
        blocksMap.delete(sourceId);
      }, 'user');

      return success;
    }

    it('merges content with newline separator', () => {
      const doc = new Y.Doc();
      const { blocksMap, rootIdsArr } = setupTree(doc, { parent: ['target', 'source'] });
      setField(blocksMap, 'target', 'content', 'hello');
      setField(blocksMap, 'source', 'content', 'world');

      const result = mergeBlocks(doc, blocksMap, rootIdsArr, 'target', 'source');

      expect(result).toBe(true);
      expect(getValue(blocksMap, 'target', 'content')).toBe('hello\nworld');
      expect(blocksMap.get('source')).toBeUndefined();
      expect(getChildIds(blocksMap, 'parent')).toEqual(['target']);
    });

    it('merges with empty source (no trailing separator)', () => {
      const doc = new Y.Doc();
      const { blocksMap, rootIdsArr } = setupTree(doc, { parent: ['target', 'source'] });
      setField(blocksMap, 'target', 'content', 'hello');
      setField(blocksMap, 'source', 'content', '');

      const result = mergeBlocks(doc, blocksMap, rootIdsArr, 'target', 'source');

      expect(result).toBe(true);
      expect(getValue(blocksMap, 'target', 'content')).toBe('hello');
      expect(blocksMap.get('source')).toBeUndefined();
    });

    it('merges with empty target', () => {
      const doc = new Y.Doc();
      const { blocksMap, rootIdsArr } = setupTree(doc, { parent: ['target', 'source'] });
      setField(blocksMap, 'target', 'content', '');
      setField(blocksMap, 'source', 'content', 'world');

      const result = mergeBlocks(doc, blocksMap, rootIdsArr, 'target', 'source');

      expect(result).toBe(true);
      expect(getValue(blocksMap, 'target', 'content')).toBe('world');
    });

    it('lifts source children to siblings after target (nested)', () => {
      const doc = new Y.Doc();
      const { blocksMap, rootIdsArr } = setupTree(doc, {
        parent: ['target', 'source'],
        source: ['child1', 'child2'],
      });
      setField(blocksMap, 'target', 'content', 'hello');
      setField(blocksMap, 'source', 'content', 'world');

      const result = mergeBlocks(doc, blocksMap, rootIdsArr, 'target', 'source');

      expect(result).toBe(true);
      expect(getChildIds(blocksMap, 'parent')).toEqual(['target', 'child1', 'child2']);
      expect(getValue(blocksMap, 'child1', 'parentId')).toBe('parent');
      expect(getValue(blocksMap, 'child2', 'parentId')).toBe('parent');
      expect(getChildIds(blocksMap, 'source')).toEqual([]); // source deleted, but check before delete
      expect(blocksMap.get('source')).toBeUndefined();
    });

    it('lifts source children to siblings after target (root level)', () => {
      const doc = new Y.Doc();
      const blocksMap = doc.getMap('blocks');
      const rootIdsArr = doc.getArray<string>('rootIds');
      doc.transact(() => {
        blocksMap.set('target', createBlockMap('target'));
        blocksMap.set('source', createBlockMap('source', ['child1']));
        blocksMap.set('child1', createBlockMap('child1'));
        setField(blocksMap, 'child1', 'parentId', 'source');
        rootIdsArr.push(['target', 'source']);
      });
      setField(blocksMap, 'target', 'content', 'hello');
      setField(blocksMap, 'source', 'content', 'world');

      const result = mergeBlocks(doc, blocksMap, rootIdsArr, 'target', 'source');

      expect(result).toBe(true);
      expect(rootIdsArr.toArray()).toEqual(['target', 'child1']);
      expect(getValue(blocksMap, 'child1', 'parentId')).toBeNull();
      expect(blocksMap.get('source')).toBeUndefined();
    });

    it('returns false for self-merge', () => {
      const doc = new Y.Doc();
      const { blocksMap, rootIdsArr } = setupTree(doc, { parent: ['target'] });

      const result = mergeBlocks(doc, blocksMap, rootIdsArr, 'target', 'target');

      expect(result).toBe(false);
      expect(blocksMap.get('target')).toBeDefined();
    });

    it('returns false when target or source not found', () => {
      const doc = new Y.Doc();
      const { blocksMap, rootIdsArr } = setupTree(doc, { parent: ['target'] });

      expect(mergeBlocks(doc, blocksMap, rootIdsArr, 'target', 'nonexistent')).toBe(false);
      expect(mergeBlocks(doc, blocksMap, rootIdsArr, 'nonexistent', 'target')).toBe(false);
    });

    it('is a single undo step', () => {
      const doc = new Y.Doc();
      const { blocksMap, rootIdsArr } = setupTree(doc, {
        parent: ['target', 'source'],
        source: ['child'],
      });
      // Set content inside a transaction so it's part of setup, not undo-tracked
      doc.transact(() => {
        setField(blocksMap, 'target', 'content', 'hello');
        setField(blocksMap, 'source', 'content', 'world');
      });

      const undoManager = new Y.UndoManager([blocksMap, rootIdsArr], {
        trackedOrigins: new Set(['user']),
      });
      undoManager.clear();

      mergeBlocks(doc, blocksMap, rootIdsArr, 'target', 'source');

      expect(undoManager.undoStack.length).toBe(1);

      undoManager.undo();

      // Full tree restored
      expect(getValue(blocksMap, 'target', 'content')).toBe('hello');
      expect(blocksMap.get('source')).toBeDefined();
      expect(getValue(blocksMap, 'source', 'content')).toBe('world');
      expect(getChildIds(blocksMap, 'parent')).toEqual(['target', 'source']);
      expect(getChildIds(blocksMap, 'source')).toEqual(['child']);
      expect(getValue(blocksMap, 'child', 'parentId')).toBe('source');
    });

    it('survives bidirectional CRDT merge', () => {
      const docA = new Y.Doc();
      const { blocksMap: blocksA, rootIdsArr: rootA } = setupTree(docA, {
        parent: ['target', 'source'],
        source: ['child1', 'child2'],
      });
      setField(blocksA, 'target', 'content', 'hello');
      setField(blocksA, 'source', 'content', 'world');

      // Fork
      const docB = new Y.Doc();
      Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));

      // A: merge blocks
      mergeBlocks(docA, blocksA, rootA, 'target', 'source');

      // B: concurrent edit to target content
      const blocksB = docB.getMap('blocks');
      docB.transact(() => {
        setField(blocksB, 'target', 'content', 'hello edited');
      }, 'user');

      // Bidirectional sync
      const updateFromA = Y.encodeStateAsUpdate(docA, Y.encodeStateVector(docB));
      const updateFromB = Y.encodeStateAsUpdate(docB, Y.encodeStateVector(docA));
      Y.applyUpdate(docA, updateFromB);
      Y.applyUpdate(docB, updateFromA);

      // No duplicates in parent's children
      const parentChildrenA = getChildIds(blocksA, 'parent');
      expect(new Set(parentChildrenA).size).toBe(parentChildrenA.length);

      // Source should be deleted in both docs
      expect(blocksA.get('source')).toBeUndefined();

      // Children were lifted
      expect(parentChildrenA).toContain('child1');
      expect(parentChildrenA).toContain('child2');

      // Both docs converge
      const rootB = docB.getArray<string>('rootIds');
      const parentChildrenB = getChildIds(blocksB, 'parent');
      expect(new Set(parentChildrenB).size).toBe(parentChildrenB.length);
      expect(parentChildrenB).toContain('child1');
      expect(parentChildrenB).toContain('child2');
    });
  });
});
