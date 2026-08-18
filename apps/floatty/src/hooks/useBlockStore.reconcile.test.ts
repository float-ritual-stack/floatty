/**
 * reconcileStoreFromYDoc against the REAL store singleton ([[FLO-895]]).
 *
 * The planner's decisions are unit-tested in `lib/storeReconcile.test.ts`.
 * What can only be tested here is the adapter property that makes the feature
 * safe to run every 2 minutes on a live 27k-block outline:
 *
 *   a store materialized by `toBlock` must fingerprint IDENTICALLY to the
 *   Y.Doc it came from.
 *
 * If those two normalizations ever drift — one coercing a missing field, the
 * other reading it raw — every block reports stale on every pass, and the
 * "self-heal" becomes a permanent repair loop that rewrites the whole store
 * twice a minute. These tests are the guard against shipping that.
 *
 * The singleton initializes once per module instance, so this file owns one
 * doc for its whole run.
 *
 * ## Coverage note — what is deliberately NOT tested here
 *
 * The repair branches (materialize / refresh / drop / replace rootIds) are
 * tested against the pure planner in `lib/storeReconcile.test.ts`, not here,
 * because a test cannot stage the divergence they respond to. The observer is
 * registered for the app's lifetime and yjs fires it synchronously at
 * transaction end, so every mutation this file can make reaches the store
 * before the reconciler runs — there is no supported way to make the singleton
 * store disagree with its Y.Doc on purpose. The production divergence comes
 * from a race inside a single merged transaction, which is not reachable from
 * outside.
 *
 * Stating that plainly rather than writing a test that stages a fake store and
 * proves only that the fake was staged.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import * as Y from 'yjs';
import { blockStore } from './useBlockStore';
import { getSyncDiagnostics } from '../lib/syncDiagnostics';

const doc = new Y.Doc();
const blocksMap = doc.getMap('blocks');
const rootIds = doc.getArray<string>('rootIds');

/** A fully-populated block Y.Map, as the app writes them. */
function fullBlock(id: string, content: string, childIds: string[] = []): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  m.set('id', id);
  m.set('parentId', null);
  m.set('content', content);
  m.set('type', 'text');
  m.set('collapsed', false);
  m.set('createdAt', 1000);
  m.set('updatedAt', 2000);
  const arr = new Y.Array<string>();
  if (childIds.length > 0) arr.push(childIds);
  m.set('childIds', arr);
  return m;
}

/**
 * A block missing the optional fields entirely.
 *
 * This is the shape that breaks a naive fingerprint: `toBlock` turns absent
 * `content` into `''` and absent `childIds` into `[]`, so comparing the raw
 * Y.Map values against the materialized ones reports permanent staleness.
 */
function sparseBlock(id: string): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  m.set('id', id);
  return m;
}

beforeAll(() => {
  doc.transact(() => {
    blocksMap.set('root', fullBlock('root', 'root block', ['child-a', 'child-b']));
    blocksMap.set('child-a', fullBlock('child-a', 'child a'));
    blocksMap.set('child-b', fullBlock('child-b', ''));
    blocksMap.set('sparse', sparseBlock('sparse'));
    rootIds.push(['root']);
  });
  blockStore.initFromYDoc(doc);
});

describe('reconcileStoreFromYDoc — no false positives', () => {
  it('materialized the doc at init', () => {
    expect(blockStore.isInitialized).toBe(true);
    expect(Object.keys(blockStore.blocks).sort()).toEqual([
      'child-a',
      'child-b',
      'root',
      'sparse',
    ]);
  });

  it('reports a clean store as clean', () => {
    const report = blockStore.reconcileStoreFromYDoc();

    expect(report).not.toBeNull();
    expect(report).toMatchObject({
      missing: 0,
      extra: 0,
      stale: 0,
      unreadable: 0,
      rootIdsRepaired: false,
      docBlocks: 4,
      storeBlocks: 4,
    });
  });

  it('stays clean across repeated passes', () => {
    // The churn failure mode is not visible in a single pass — it shows up as
    // the same repair being reported forever.
    for (let i = 0; i < 5; i++) {
      const report = blockStore.reconcileStoreFromYDoc();
      expect(report?.missing).toBe(0);
      expect(report?.stale).toBe(0);
      expect(report?.extra).toBe(0);
    }
  });

  it('stays clean for blocks whose optional fields are absent', () => {
    // Scoped to the sparse block alone: content/childIds normalization is the
    // exact place where doc-side and store-side reads drift apart.
    const report = blockStore.reconcileStoreFromYDoc();

    expect(report?.stale).toBe(0);
    expect(blockStore.blocks['sparse']).toMatchObject({ content: '', childIds: [] });
  });

  it('stays clean after a remote-shaped edit lands', () => {
    doc.transact(() => {
      const m = blocksMap.get('child-a') as Y.Map<unknown>;
      m.set('content', 'child a, edited');
      m.set('updatedAt', 3000);
    }, 'remote');

    // The observer already applied this; the reconciler must agree, not
    // re-report it.
    expect(blockStore.blocks['child-a'].content).toBe('child a, edited');
    expect(blockStore.reconcileStoreFromYDoc()?.stale).toBe(0);
  });

  it('stays clean after a structural change', () => {
    doc.transact(() => {
      blocksMap.set('child-c', fullBlock('child-c', 'child c'));
      const rootMap = blocksMap.get('root') as Y.Map<unknown>;
      (rootMap.get('childIds') as Y.Array<string>).push(['child-c']);
    }, 'remote');

    const report = blockStore.reconcileStoreFromYDoc();
    expect(report).toMatchObject({ missing: 0, stale: 0, extra: 0, docBlocks: 5 });
  });

  it('stays clean after a delete', () => {
    doc.transact(() => {
      blocksMap.delete('child-c');
      const rootMap = blocksMap.get('root') as Y.Map<unknown>;
      const arr = rootMap.get('childIds') as Y.Array<string>;
      arr.delete(arr.toArray().indexOf('child-c'), 1);
    }, 'remote');

    const report = blockStore.reconcileStoreFromYDoc();
    expect(report).toMatchObject({ missing: 0, stale: 0, extra: 0, docBlocks: 4 });
    expect(blockStore.blocks['child-c']).toBeUndefined();
  });
});

describe('reconcileStoreFromYDoc — windowing', () => {
  it('reports only the window it scanned', () => {
    const report = blockStore.reconcileStoreFromYDoc({ windowSize: 2 });

    expect(report?.scanned).toBe(2);
    expect(report?.docBlocks).toBe(4);
  });

  it('advances the cursor across calls rather than rescanning the head', () => {
    // Window 3 over 4 blocks: a cursor pinned at 0 reports 3 forever. Only a
    // moving cursor produces a short pass and then wraps.
    //
    // The cursor carries over from earlier tests in this file, so drive to a
    // known point first — the short pass IS the wrap — then assert the cycle.
    let guard = 0;
    while ((blockStore.reconcileStoreFromYDoc({ windowSize: 3 })?.scanned ?? 0) === 3) {
      if (++guard > 10) throw new Error('cursor never wrapped — it is not advancing');
    }

    const afterWrap = [
      blockStore.reconcileStoreFromYDoc({ windowSize: 3 })?.scanned,
      blockStore.reconcileStoreFromYDoc({ windowSize: 3 })?.scanned,
    ];

    // A full cycle covers every block exactly once: 3 + 1 === docBlocks.
    expect(afterWrap).toEqual([3, 1]);
  });
});

describe('reconcileStoreFromYDoc — side effects on a clean pass', () => {
  it('does not touch lastUpdateOrigin when there is nothing to repair', () => {
    // The origin stamp lives INSIDE the repair branch on purpose. Hoisting it
    // out would fire every block's content-sync effect on every 120s poll,
    // for a pass that wrote nothing.
    doc.transact(() => {
      (blocksMap.get('child-a') as Y.Map<unknown>).set('content', 'marker edit');
    }, 'remote');
    const originAfterEdit = blockStore.lastUpdateOrigin;

    const report = blockStore.reconcileStoreFromYDoc();

    expect(report).toMatchObject({ missing: 0, stale: 0, extra: 0 });
    expect(blockStore.lastUpdateOrigin).toBe(originAfterEdit);
  });
});

describe('observer store-write skips', () => {
  it('stays at zero through an edit-and-delete merge of the same block', () => {
    // Not a test of the `blocksToDelete` guard in the observer — two attempts
    // to stage that overlap (same-transaction edit+delete, and a genuine
    // two-peer merge) both failed to produce it, and the test still passed
    // with the guard disabled. It is kept as what it honestly is: a check
    // that the most delete-adjacent shape available does not dirty the
    // FLO-895 counter.
    doc.transact(() => {
      blocksMap.set('doomed', fullBlock('doomed', 'v1'));
    }, 'remote');
    expect(blockStore.blocks['doomed']).toBeDefined();

    const editor = new Y.Doc();
    Y.applyUpdate(editor, Y.encodeStateAsUpdate(doc));
    (editor.getMap('blocks').get('doomed') as Y.Map<unknown>).set('content', 'v2');
    const edit = Y.encodeStateAsUpdate(editor, Y.encodeStateVector(doc));

    const deleter = new Y.Doc();
    Y.applyUpdate(deleter, Y.encodeStateAsUpdate(doc));
    deleter.getMap('blocks').delete('doomed');
    const remove = Y.encodeStateAsUpdate(deleter, Y.encodeStateVector(doc));

    const before = getSyncDiagnostics().storeWriteSkips;
    doc.transact(() => {
      Y.applyUpdate(doc, edit);
      Y.applyUpdate(doc, remove);
    }, 'remote');

    expect(getSyncDiagnostics().storeWriteSkips).toBe(before);
    expect(blockStore.blocks['doomed']).toBeUndefined();
    expect(blockStore.reconcileStoreFromYDoc()).toMatchObject({ missing: 0, extra: 0 });
  });
});

describe('reconcileStoreFromYDoc — missed observer write', () => {
  /**
   * Drop the observer's read-back for one block, the exact silent-drop shape
   * the reconciler exists to retry: `toBlock(blocksMap.get(key))` resolves to
   * nothing, the `setState` is skipped, and the store keeps the old value.
   */
  const dropObserverWriteFor = (id: string, mutate: () => void) => {
    const realGet = blocksMap.get.bind(blocksMap);
    const spy = vi
      .spyOn(blocksMap, 'get')
      .mockImplementation((key: string) => (key === id ? undefined : realGet(key)));
    try {
      doc.transact(mutate, 'remote');
    } finally {
      spy.mockRestore();
    }
  };

  it('re-materializes a collapsed-only change the observer dropped', () => {
    // `toggleCollapsed` writes `collapsed` and nothing else — no updatedAt
    // bump — so content/updatedAt/parentId/childCount all still agree. Without
    // `collapsed` in the fingerprint the block reads as current forever and the
    // subtree renders expanded against its own Y.Doc.
    const rootMap = blocksMap.get('root') as Y.Map<unknown>;
    expect(blockStore.blocks['root'].collapsed).toBe(false);

    dropObserverWriteFor('root', () => {
      rootMap.set('collapsed', true);
    });

    // The doc moved; the store did not.
    expect(rootMap.get('collapsed')).toBe(true);
    expect(blockStore.blocks['root'].collapsed).toBe(false);

    const report = blockStore.reconcileStoreFromYDoc();
    expect(report?.stale).toBe(1);
    expect(report?.sampleIds).toContain('root');
    expect(blockStore.blocks['root'].collapsed).toBe(true);

    // And the repair settles: a second pass must not re-report the same block,
    // which is the churn failure mode a mis-normalized field would produce.
    expect(blockStore.reconcileStoreFromYDoc()).toMatchObject({
      missing: 0,
      extra: 0,
      stale: 0,
    });
  });
});

describe('reconcileStoreFromYDoc — rootIds', () => {
  it('finds nothing to repair because the rootIds observer got there first', () => {
    // Named for what it asserts: the reconciler AGREES with the live observer
    // rather than fighting it. The repair branch itself is covered by the
    // planner tests — see the coverage note in this file's header.
    doc.transact(() => {
      rootIds.push(['sparse']);
    }, 'remote');

    expect(blockStore.reconcileStoreFromYDoc()?.rootIdsRepaired).toBe(false);
    expect(blockStore.rootIds).toEqual(['root', 'sparse']);
  });
});
