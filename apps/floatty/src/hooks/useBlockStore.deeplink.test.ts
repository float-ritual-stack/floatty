/**
 * Deep link helper tests: findChildByPrefix + upsertChildByPrefix
 *
 * Tests the Y.Doc-backed helpers used by floatty:// deep link verbs.
 * Mirrors the surgical test pattern — re-implements helpers for isolation.
 */

import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';

// ═══════════════════════════════════════════════════════════════
// TEST HELPERS — mirror private helpers from useBlockStore.ts
// ═══════════════════════════════════════════════════════════════

function setupDoc(): { doc: Y.Doc; blocksMap: Y.Map<unknown> } {
  const doc = new Y.Doc();
  const blocksMap = doc.getMap('blocks');
  return { doc, blocksMap };
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

// ═══════════════════════════════════════════════════════════════
// RE-IMPLEMENTED HELPERS (mirrors useBlockStore.ts logic)
// ═══════════════════════════════════════════════════════════════

function findChildByPrefix(doc: Y.Doc, parentId: string, prefix: string): string | null {
  const blocksMap = doc.getMap('blocks');
  const parentData = blocksMap.get(parentId);
  if (!(parentData instanceof Y.Map)) return null;
  const childIdsArr = parentData.get('childIds');
  const childIds = childIdsArr instanceof Y.Array
    ? (childIdsArr.toArray() as string[])
    : [];
  for (const childId of childIds) {
    const childData = blocksMap.get(childId);
    if (!(childData instanceof Y.Map)) continue;
    const content = (childData.get('content') as string) || '';
    if (content.startsWith(prefix)) return childId;
  }
  return null;
}

function upsertChildByPrefix(doc: Y.Doc, parentId: string, prefix: string, content: string): string | null {
  let resultId: string | null = null;

  doc.transact(() => {
    const blocksMap = doc.getMap('blocks');
    if (!blocksMap.has(parentId)) return;
    const parentData = blocksMap.get(parentId);
    if (!(parentData instanceof Y.Map)) return;
    const childIdsArr = parentData.get('childIds');
    const childIds = childIdsArr instanceof Y.Array
      ? (childIdsArr.toArray() as string[])
      : [];

    for (const childId of childIds) {
      const childData = blocksMap.get(childId);
      if (!(childData instanceof Y.Map)) continue;
      const childContent = (childData.get('content') as string) || '';
      if (childContent.startsWith(prefix)) {
        resultId = childId;
        return;
      }
    }

    // Create new child
    const newId = crypto.randomUUID();
    const newBlock = createBlockMap(newId, content, parentId);
    blocksMap.set(newId, newBlock);
    // Append to parent childIds
    const arr = parentData.get('childIds');
    if (arr instanceof Y.Array) {
      arr.push([newId]);
    }
    resultId = newId;
  }, 'system');

  return resultId;
}

// ═══════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════

describe('findChildByPrefix', () => {
  it('returns null when parent does not exist', () => {
    const { doc } = setupDoc();
    expect(findChildByPrefix(doc, 'nonexistent', 'render::')).toBeNull();
  });

  it('returns null when parent has no children', () => {
    const { doc, blocksMap } = setupDoc();
    blocksMap.set('parent', createBlockMap('parent', 'root'));
    expect(findChildByPrefix(doc, 'parent', 'render::')).toBeNull();
  });

  it('returns null when no child matches prefix', () => {
    const { doc, blocksMap } = setupDoc();
    doc.transact(() => {
      blocksMap.set('child1', createBlockMap('child1', 'daily:: today'));
      blocksMap.set('parent', createBlockMap('parent', 'root', null, ['child1']));
    });
    expect(findChildByPrefix(doc, 'parent', 'render::')).toBeNull();
  });

  it('returns matching child ID when prefix matches', () => {
    const { doc, blocksMap } = setupDoc();
    doc.transact(() => {
      blocksMap.set('child1', createBlockMap('child1', 'render:: demo'));
      blocksMap.set('parent', createBlockMap('parent', 'root', null, ['child1']));
    });
    expect(findChildByPrefix(doc, 'parent', 'render::')).toBe('child1');
  });

  it('returns first match when multiple children match', () => {
    const { doc, blocksMap } = setupDoc();
    doc.transact(() => {
      blocksMap.set('child1', createBlockMap('child1', 'render:: first'));
      blocksMap.set('child2', createBlockMap('child2', 'render:: second'));
      blocksMap.set('parent', createBlockMap('parent', 'root', null, ['child1', 'child2']));
    });
    expect(findChildByPrefix(doc, 'parent', 'render::')).toBe('child1');
  });

  it('works with empty prefix (matches everything)', () => {
    const { doc, blocksMap } = setupDoc();
    doc.transact(() => {
      blocksMap.set('child1', createBlockMap('child1', 'any content'));
      blocksMap.set('parent', createBlockMap('parent', 'root', null, ['child1']));
    });
    expect(findChildByPrefix(doc, 'parent', '')).toBe('child1');
  });

  it('prefix matching is exact (not case-insensitive)', () => {
    const { doc, blocksMap } = setupDoc();
    doc.transact(() => {
      blocksMap.set('child1', createBlockMap('child1', 'Render:: demo'));
      blocksMap.set('parent', createBlockMap('parent', 'root', null, ['child1']));
    });
    expect(findChildByPrefix(doc, 'parent', 'render::')).toBeNull();
    expect(findChildByPrefix(doc, 'parent', 'Render::')).toBe('child1');
  });
});

describe('upsertChildByPrefix', () => {
  it('creates child when no match exists', () => {
    const { doc, blocksMap } = setupDoc();
    blocksMap.set('parent', createBlockMap('parent', 'root'));

    const result = upsertChildByPrefix(doc, 'parent', 'render::', 'render:: demo');
    expect(result).not.toBeNull();

    // Verify child was created
    const childData = blocksMap.get(result!);
    expect(childData).toBeInstanceOf(Y.Map);
    expect((childData as Y.Map<unknown>).get('content')).toBe('render:: demo');

    // Verify parent's childIds includes new child
    const childIds = getChildIds(blocksMap, 'parent');
    expect(childIds).toContain(result);
  });

  it('returns existing child when match exists (idempotent)', () => {
    const { doc, blocksMap } = setupDoc();
    doc.transact(() => {
      blocksMap.set('child1', createBlockMap('child1', 'render:: demo'));
      blocksMap.set('parent', createBlockMap('parent', 'root', null, ['child1']));
    });

    const result = upsertChildByPrefix(doc, 'parent', 'render::', 'render:: different');
    expect(result).toBe('child1');

    // Content should NOT be updated (upsert finds existing, doesn't overwrite)
    const childData = blocksMap.get('child1') as Y.Map<unknown>;
    expect(childData.get('content')).toBe('render:: demo');
  });

  it('calling twice with same prefix returns same ID (no duplicate)', () => {
    const { doc, blocksMap } = setupDoc();
    blocksMap.set('parent', createBlockMap('parent', 'root'));

    const first = upsertChildByPrefix(doc, 'parent', 'render::', 'render:: demo');
    const second = upsertChildByPrefix(doc, 'parent', 'render::', 'render:: demo');
    expect(first).toBe(second);

    // Only one child should exist
    const childIds = getChildIds(blocksMap, 'parent');
    expect(childIds).toHaveLength(1);
  });

  it('returns null when parent does not exist', () => {
    const { doc } = setupDoc();
    const result = upsertChildByPrefix(doc, 'nonexistent', 'render::', 'render:: demo');
    expect(result).toBeNull();
  });

  it('created child has correct parentId', () => {
    const { doc, blocksMap } = setupDoc();
    blocksMap.set('parent', createBlockMap('parent', 'root'));

    const result = upsertChildByPrefix(doc, 'parent', 'render::', 'render:: demo');
    expect(result).not.toBeNull();

    const childData = blocksMap.get(result!) as Y.Map<unknown>;
    expect(childData.get('parentId')).toBe('parent');
  });

  it('created child appears in parent childIds', () => {
    const { doc, blocksMap } = setupDoc();
    blocksMap.set('parent', createBlockMap('parent', 'root'));

    const result = upsertChildByPrefix(doc, 'parent', 'render::', 'render:: demo');
    const childIds = getChildIds(blocksMap, 'parent');
    expect(childIds).toContain(result);
  });

  it('different prefixes create separate children', () => {
    const { doc, blocksMap } = setupDoc();
    blocksMap.set('parent', createBlockMap('parent', 'root'));

    const first = upsertChildByPrefix(doc, 'parent', 'render::', 'render:: demo');
    const second = upsertChildByPrefix(doc, 'parent', 'daily::', 'daily:: today');
    expect(first).not.toBe(second);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();

    const childIds = getChildIds(blocksMap, 'parent');
    expect(childIds).toHaveLength(2);
  });
});
