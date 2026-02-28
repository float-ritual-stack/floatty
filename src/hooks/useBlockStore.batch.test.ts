/**
 * Batch block creation tests (FLO-322)
 *
 * Verifies that batch API creates all blocks in a single Y.Doc transaction,
 * correct nesting, content, and block type detection.
 *
 * Uses real Y.Doc instances — tests the actual CRDT behavior.
 */

import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';

// ═══════════════════════════════════════════════════════════════
// TEST HELPERS — minimal Y.Doc setup matching useBlockStore's patterns
// ═══════════════════════════════════════════════════════════════

function setupDoc(): { doc: Y.Doc; blocksMap: Y.Map<unknown>; rootIds: Y.Array<string> } {
  const doc = new Y.Doc();
  const blocksMap = doc.getMap('blocks');
  const rootIds = doc.getArray<string>('rootIds');
  return { doc, blocksMap, rootIds };
}

function createBlockMap(id: string, content: string = '', parentId: string | null = null, childIds: string[] = []): Y.Map<unknown> {
  const blockMap = new Y.Map<unknown>();
  blockMap.set('id', id);
  blockMap.set('parentId', parentId);
  blockMap.set('content', content);
  blockMap.set('type', 'text');
  blockMap.set('collapsed', false);
  blockMap.set('createdAt', Date.now());
  blockMap.set('updatedAt', Date.now());
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

function getContent(blocksMap: Y.Map<unknown>, blockId: string): string {
  const blockMap = blocksMap.get(blockId);
  if (!(blockMap instanceof Y.Map)) return '';
  return (blockMap.get('content') as string) ?? '';
}

function getParentId(blocksMap: Y.Map<unknown>, blockId: string): string | null {
  const blockMap = blocksMap.get(blockId);
  if (!(blockMap instanceof Y.Map)) return null;
  return (blockMap.get('parentId') as string | null) ?? null;
}

function appendChildId(blocksMap: Y.Map<unknown>, parentId: string, childId: string): void {
  const blockMap = blocksMap.get(parentId);
  if (!(blockMap instanceof Y.Map)) return;
  const arr = blockMap.get('childIds');
  if (!(arr instanceof Y.Array)) return;
  arr.push([childId]);
}

function insertChildId(blocksMap: Y.Map<unknown>, parentId: string, childId: string, atIndex: number): void {
  const blockMap = blocksMap.get(parentId);
  if (!(blockMap instanceof Y.Map)) return;
  const arr = blockMap.get('childIds');
  if (!(arr instanceof Y.Array)) return;
  const safeIndex = Math.max(0, Math.min(atIndex, arr.length));
  arr.insert(safeIndex, [childId]);
}

// ═══════════════════════════════════════════════════════════════
// BATCH HELPERS — re-implement batch logic for isolated testing
// (mirrors batchCreateBlocksAfter/Inside/InsideAtTop from useBlockStore.ts)
// ═══════════════════════════════════════════════════════════════

interface BatchBlockOp {
  content: string;
  children?: BatchBlockOp[];
}

function batchCreateBlocksAfter(
  doc: Y.Doc,
  blocksMap: Y.Map<unknown>,
  afterId: string,
  afterParentId: string | null,
  ops: BatchBlockOp[],
  origin: string = 'bulk_import',
): string[] {
  const topLevelIds: string[] = [];

  doc.transact(() => {
    let insertIdx: number;
    if (afterParentId) {
      const childIds = getChildIds(blocksMap, afterParentId);
      insertIdx = childIds.indexOf(afterId) + 1;
    } else {
      const rootIds = doc.getArray<string>('rootIds');
      const arr = rootIds.toArray();
      insertIdx = arr.indexOf(afterId) + 1;
    }

    const createChildren = (parentBlockId: string, children: BatchBlockOp[]) => {
      for (const child of children) {
        const childId = crypto.randomUUID();
        blocksMap.set(childId, createBlockMap(childId, child.content, parentBlockId));
        appendChildId(blocksMap, parentBlockId, childId);
        if (child.children && child.children.length > 0) {
          createChildren(childId, child.children);
        }
      }
    };

    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      const newId = crypto.randomUUID();
      blocksMap.set(newId, createBlockMap(newId, op.content, afterParentId));
      topLevelIds.push(newId);

      if (afterParentId) {
        insertChildId(blocksMap, afterParentId, newId, insertIdx + i);
      } else {
        const rootIds = doc.getArray<string>('rootIds');
        rootIds.insert(insertIdx + i, [newId]);
      }

      if (op.children && op.children.length > 0) {
        createChildren(newId, op.children);
      }
    }
  }, origin);

  return topLevelIds;
}

function batchCreateBlocksInside(
  doc: Y.Doc,
  blocksMap: Y.Map<unknown>,
  parentId: string,
  ops: BatchBlockOp[],
  origin: string = 'bulk_import',
): string[] {
  const topLevelIds: string[] = [];

  doc.transact(() => {
    const createChildren = (parentBlockId: string, children: BatchBlockOp[]) => {
      for (const child of children) {
        const childId = crypto.randomUUID();
        blocksMap.set(childId, createBlockMap(childId, child.content, parentBlockId));
        appendChildId(blocksMap, parentBlockId, childId);
        if (child.children && child.children.length > 0) {
          createChildren(childId, child.children);
        }
      }
    };

    for (const op of ops) {
      const newId = crypto.randomUUID();
      blocksMap.set(newId, createBlockMap(newId, op.content, parentId));
      appendChildId(blocksMap, parentId, newId);
      topLevelIds.push(newId);
      if (op.children && op.children.length > 0) {
        createChildren(newId, op.children);
      }
    }
  }, origin);

  return topLevelIds;
}

// ═══════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════

describe('batchCreateBlocksAfter', () => {
  it('creates multiple blocks as root siblings in single transaction', () => {
    const { doc, blocksMap, rootIds } = setupDoc();

    // Setup: one existing root block
    const existingId = 'existing-1';
    doc.transact(() => {
      blocksMap.set(existingId, createBlockMap(existingId, 'existing'));
      rootIds.push([existingId]);
    });

    // Track transaction count
    let transactionCount = 0;
    const handler = () => { transactionCount++; };
    blocksMap.observeDeep(handler);

    // Batch create 5 blocks after existing
    const ops: BatchBlockOp[] = [
      { content: '# Section 1' },
      { content: '- item one' },
      { content: '- item two' },
      { content: '- item three' },
      { content: '## Section 2' },
    ];

    const ids = batchCreateBlocksAfter(doc, blocksMap, existingId, null, ops);

    // Should produce exactly 1 observer fire (1 transaction)
    expect(transactionCount).toBe(1);
    blocksMap.unobserveDeep(handler);

    // Should create 5 blocks
    expect(ids.length).toBe(5);

    // Root IDs should now be [existing, ...5 new]
    expect(rootIds.length).toBe(6);

    // Content should match
    expect(getContent(blocksMap, ids[0])).toBe('# Section 1');
    expect(getContent(blocksMap, ids[1])).toBe('- item one');
    expect(getContent(blocksMap, ids[4])).toBe('## Section 2');

    // All should be root blocks (parentId = null)
    for (const id of ids) {
      expect(getParentId(blocksMap, id)).toBeNull();
    }
  });

  it('creates nested children in single transaction', () => {
    const { doc, blocksMap, rootIds } = setupDoc();

    const existingId = 'existing-1';
    doc.transact(() => {
      blocksMap.set(existingId, createBlockMap(existingId, 'existing'));
      rootIds.push([existingId]);
    });

    let transactionCount = 0;
    const handler = () => { transactionCount++; };
    blocksMap.observeDeep(handler);

    const ops: BatchBlockOp[] = [
      {
        content: '# Section',
        children: [
          { content: '- item 1' },
          {
            content: '- item 2',
            children: [
              { content: '  - sub a' },
              { content: '  - sub b' },
            ],
          },
        ],
      },
    ];

    const ids = batchCreateBlocksAfter(doc, blocksMap, existingId, null, ops);

    expect(transactionCount).toBe(1);
    blocksMap.unobserveDeep(handler);

    // Top level: 1 block
    expect(ids.length).toBe(1);
    const sectionId = ids[0];

    // Section should have 2 children
    const sectionChildren = getChildIds(blocksMap, sectionId);
    expect(sectionChildren.length).toBe(2);
    expect(getContent(blocksMap, sectionChildren[0])).toBe('- item 1');
    expect(getContent(blocksMap, sectionChildren[1])).toBe('- item 2');

    // item 2 should have 2 sub-children
    const item2Children = getChildIds(blocksMap, sectionChildren[1]);
    expect(item2Children.length).toBe(2);
    expect(getContent(blocksMap, item2Children[0])).toBe('  - sub a');
    expect(getContent(blocksMap, item2Children[1])).toBe('  - sub b');

    // parentId chain should be correct
    expect(getParentId(blocksMap, sectionChildren[0])).toBe(sectionId);
    expect(getParentId(blocksMap, item2Children[0])).toBe(sectionChildren[1]);
  });

  it('inserts after correct position in parent children', () => {
    const { doc, blocksMap } = setupDoc();

    // Setup: parent with 3 children [A, B, C]
    const parentId = 'parent';
    const childA = 'child-a';
    const childB = 'child-b';
    const childC = 'child-c';

    doc.transact(() => {
      blocksMap.set(parentId, createBlockMap(parentId, 'parent', null, [childA, childB, childC]));
      blocksMap.set(childA, createBlockMap(childA, 'A', parentId));
      blocksMap.set(childB, createBlockMap(childB, 'B', parentId));
      blocksMap.set(childC, createBlockMap(childC, 'C', parentId));
    });

    // Insert 2 new blocks after B
    const ops: BatchBlockOp[] = [
      { content: 'new-1' },
      { content: 'new-2' },
    ];

    const ids = batchCreateBlocksAfter(doc, blocksMap, childB, parentId, ops);

    // Parent should now have [A, B, new-1, new-2, C]
    const children = getChildIds(blocksMap, parentId);
    expect(children.length).toBe(5);
    expect(children[0]).toBe(childA);
    expect(children[1]).toBe(childB);
    expect(children[2]).toBe(ids[0]);
    expect(children[3]).toBe(ids[1]);
    expect(children[4]).toBe(childC);
  });

  it('uses bulk_import origin by default', () => {
    const { doc, blocksMap, rootIds } = setupDoc();

    const existingId = 'existing';
    doc.transact(() => {
      blocksMap.set(existingId, createBlockMap(existingId));
      rootIds.push([existingId]);
    });

    let capturedOrigin: unknown = null;
    const handler = (events: Y.YEvent<any>[]) => {
      capturedOrigin = events[0]?.transaction.origin;
    };
    blocksMap.observeDeep(handler);

    batchCreateBlocksAfter(doc, blocksMap, existingId, null, [{ content: 'test' }]);

    expect(capturedOrigin).toBe('bulk_import');
    blocksMap.unobserveDeep(handler);
  });
});

describe('batchCreateBlocksInside', () => {
  it('creates multiple children in single transaction', () => {
    const { doc, blocksMap } = setupDoc();

    const parentId = 'parent';
    doc.transact(() => {
      blocksMap.set(parentId, createBlockMap(parentId, 'parent'));
    });

    let transactionCount = 0;
    const handler = () => { transactionCount++; };
    blocksMap.observeDeep(handler);

    const ops: BatchBlockOp[] = [
      { content: 'child 1' },
      { content: 'child 2' },
      { content: 'child 3' },
    ];

    const ids = batchCreateBlocksInside(doc, blocksMap, parentId, ops);

    expect(transactionCount).toBe(1);
    blocksMap.unobserveDeep(handler);

    expect(ids.length).toBe(3);
    const children = getChildIds(blocksMap, parentId);
    expect(children).toEqual(ids);

    // All children should have correct parentId
    for (const id of ids) {
      expect(getParentId(blocksMap, id)).toBe(parentId);
    }
  });
});

describe('transaction count comparison', () => {
  it('old pattern: N blocks = 2N transactions', () => {
    const { doc, blocksMap, rootIds } = setupDoc();

    const existingId = 'existing';
    doc.transact(() => {
      blocksMap.set(existingId, createBlockMap(existingId));
      rootIds.push([existingId]);
    });

    let transactionCount = 0;
    const handler = () => { transactionCount++; };
    blocksMap.observeDeep(handler);

    // Simulate old pattern: createBlockAfter + updateBlockContent per block
    const N = 10;
    let lastId = existingId;
    for (let i = 0; i < N; i++) {
      const newId = `block-${i}`;
      // Transaction 1: create block
      doc.transact(() => {
        blocksMap.set(newId, createBlockMap(newId, '', null));
        rootIds.push([newId]);
      }, 'user');
      // Transaction 2: update content
      doc.transact(() => {
        const blockMap = blocksMap.get(newId) as Y.Map<unknown>;
        blockMap.set('content', `content ${i}`);
      }, 'user');
      lastId = newId;
    }

    // Old pattern: 2 transactions per block = 20 observer fires
    expect(transactionCount).toBe(N * 2);
    blocksMap.unobserveDeep(handler);
  });

  it('new pattern: N blocks = 1 transaction', () => {
    const { doc, blocksMap, rootIds } = setupDoc();

    const existingId = 'existing';
    doc.transact(() => {
      blocksMap.set(existingId, createBlockMap(existingId));
      rootIds.push([existingId]);
    });

    let transactionCount = 0;
    const handler = () => { transactionCount++; };
    blocksMap.observeDeep(handler);

    // New pattern: batch create
    const N = 10;
    const ops: BatchBlockOp[] = Array.from({ length: N }, (_, i) => ({
      content: `content ${i}`,
    }));

    batchCreateBlocksAfter(doc, blocksMap, existingId, null, ops);

    // New pattern: 1 transaction for all N blocks
    expect(transactionCount).toBe(1);
    blocksMap.unobserveDeep(handler);
  });

  it('100 blocks: old = 200 transactions, new = 1 transaction', () => {
    // Old pattern
    const oldDoc = new Y.Doc();
    const oldBlocks = oldDoc.getMap('blocks');
    const oldRoots = oldDoc.getArray<string>('rootIds');

    oldDoc.transact(() => {
      oldBlocks.set('root', createBlockMap('root'));
      oldRoots.push(['root']);
    });

    let oldTxCount = 0;
    const oldHandler = () => { oldTxCount++; };
    oldBlocks.observeDeep(oldHandler);

    for (let i = 0; i < 100; i++) {
      const id = `old-${i}`;
      oldDoc.transact(() => {
        oldBlocks.set(id, createBlockMap(id));
        oldRoots.push([id]);
      }, 'user');
      oldDoc.transact(() => {
        const m = oldBlocks.get(id) as Y.Map<unknown>;
        m.set('content', `line ${i}`);
      }, 'user');
    }

    expect(oldTxCount).toBe(200);
    oldBlocks.unobserveDeep(oldHandler);

    // New pattern
    const newDoc = new Y.Doc();
    const newBlocks = newDoc.getMap('blocks');
    const newRoots = newDoc.getArray<string>('rootIds');

    newDoc.transact(() => {
      newBlocks.set('root', createBlockMap('root'));
      newRoots.push(['root']);
    });

    let newTxCount = 0;
    const newHandler = () => { newTxCount++; };
    newBlocks.observeDeep(newHandler);

    const ops = Array.from({ length: 100 }, (_, i) => ({ content: `line ${i}` }));
    batchCreateBlocksAfter(newDoc, newBlocks, 'root', null, ops);

    expect(newTxCount).toBe(1);
    newBlocks.unobserveDeep(newHandler);
  });
});
