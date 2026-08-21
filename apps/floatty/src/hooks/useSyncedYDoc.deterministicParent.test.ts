import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { deduplicateChildIds } from './useSyncedYDoc';

/**
 * FLO-922 — when a block is claimed by multiple parents and its declared
 * parentId isn't among the claimants, the repair must pick a DETERMINISTIC
 * parent (oldest createdAt, then lexicographic id), not the insertion-order
 * `parents[0]`. Y.Map iteration is local-insertion order and differs across
 * replicas even when converged; since this runs on every client and writes
 * back, a non-deterministic pick can leave a child owned by neither parent.
 */
function buildDoc(insertOrder: Array<{ id: string; createdAt: number }>): Y.Doc {
  const doc = new Y.Doc();
  const blocksMap = doc.getMap('blocks');
  const rootIds = doc.getArray<string>('rootIds');
  doc.transact(() => {
    // Parents inserted in the given order (this is what varies across replicas).
    for (const { id, createdAt } of insertOrder) {
      const p = new Y.Map<unknown>();
      p.set('id', id);
      p.set('createdAt', createdAt);
      const arr = new Y.Array<string>();
      arr.push(['child-x']); // every parent claims child-x
      p.set('childIds', arr);
      blocksMap.set(id, p);
      rootIds.push([id]); // reachable, so parents aren't themselves orphaned
    }
    // The child: content-bearing, declared parent is a GHOST not among claimants,
    // so the deterministic fallback fires.
    const child = new Y.Map<unknown>();
    child.set('id', 'child-x');
    child.set('content', 'i am claimed by two parents');
    child.set('parentId', 'ghost-parent');
    child.set('childIds', new Y.Array<string>());
    blocksMap.set('child-x', child);
  }, 'system');
  return doc;
}

function keptParentOf(doc: Y.Doc, childId: string): string {
  const blocksMap = doc.getMap('blocks');
  const child = blocksMap.get(childId) as Y.Map<unknown>;
  const parentId = child.get('parentId') as string;
  // And exactly one parent should still list the child.
  const claimants: string[] = [];
  blocksMap.forEach((v, pid) => {
    if (!(v instanceof Y.Map)) return;
    const arr = v.get('childIds');
    if (arr instanceof Y.Array && (arr.toArray() as string[]).includes(childId)) {
      claimants.push(pid);
    }
  });
  expect(claimants).toEqual([parentId]); // child owned by exactly its declared parent
  return parentId;
}

describe('deduplicateChildIds — deterministic multi-parent tie-break (FLO-922)', () => {
  it('keeps the OLDEST-createdAt parent regardless of Y.Map insertion order', () => {
    // parent-old is older; insert it FIRST here, LAST in the reversed replica.
    const forward = buildDoc([
      { id: 'parent-old', createdAt: 1000 },
      { id: 'parent-new', createdAt: 2000 },
    ]);
    const reversed = buildDoc([
      { id: 'parent-new', createdAt: 2000 },
      { id: 'parent-old', createdAt: 1000 },
    ]);

    deduplicateChildIds(forward);
    deduplicateChildIds(reversed);

    // Both converge on the oldest parent — the whole point.
    expect(keptParentOf(forward, 'child-x')).toBe('parent-old');
    expect(keptParentOf(reversed, 'child-x')).toBe('parent-old');
  });

  it('breaks a createdAt tie by lexicographic id (still order-independent)', () => {
    const forward = buildDoc([
      { id: 'parent-bbb', createdAt: 1000 },
      { id: 'parent-aaa', createdAt: 1000 },
    ]);
    const reversed = buildDoc([
      { id: 'parent-aaa', createdAt: 1000 },
      { id: 'parent-bbb', createdAt: 1000 },
    ]);

    deduplicateChildIds(forward);
    deduplicateChildIds(reversed);

    expect(keptParentOf(forward, 'child-x')).toBe('parent-aaa');
    expect(keptParentOf(reversed, 'child-x')).toBe('parent-aaa');
  });
});
