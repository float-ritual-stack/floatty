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
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as Y from 'yjs';
import { blockStore } from './useBlockStore';

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

  it('advances the window across calls', () => {
    // Two passes of 2 over 4 blocks covers the doc; a third wraps.
    const scans = [
      blockStore.reconcileStoreFromYDoc({ windowSize: 2 })?.scanned,
      blockStore.reconcileStoreFromYDoc({ windowSize: 2 })?.scanned,
      blockStore.reconcileStoreFromYDoc({ windowSize: 2 })?.scanned,
    ];

    expect(scans).toEqual([2, 2, 2]);
  });
});

describe('reconcileStoreFromYDoc — rootIds', () => {
  it('repairs a diverged root list', () => {
    // rootIds has its own observer; this asserts the reconciler agrees with it
    // rather than fighting it.
    doc.transact(() => {
      rootIds.push(['sparse']);
    }, 'remote');

    expect(blockStore.reconcileStoreFromYDoc()?.rootIdsRepaired).toBe(false);
    expect(blockStore.rootIds).toEqual(['root', 'sparse']);
  });
});
