import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

// Mock logger so we can assert on bail-out diagnostic warns.
// FLO-587 (commit 010cb5f): every moveBlock bail-out was silent, which
// violated ydoc-patterns.md rule 14.6 ("every bail-out gets a diagnostic
// counter"). Tests below guard the six named bail-out paths so a future
// edit that removes a warn (or renames its text) fails loudly.
const warnSpy = vi.fn();
vi.mock('../lib/logger', () => ({
  createLogger: () => ({
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: (...args: unknown[]) => warnSpy(...args),
    error: vi.fn(),
  }),
}));

function createBlockMap(id: string, parentId: string | null, childIds: string[] = []): Y.Map<unknown> {
  const map = new Y.Map<unknown>();
  map.set('id', id);
  map.set('parentId', parentId);
  map.set('content', id);
  map.set('type', 'text');
  map.set('metadata', null);
  map.set('collapsed', false);
  map.set('createdAt', 1);
  map.set('updatedAt', 1);
  const arr = new Y.Array<string>();
  if (childIds.length > 0) arr.push(childIds);
  map.set('childIds', arr);
  return map;
}

function getChildIds(blocksMap: Y.Map<unknown>, blockId: string): string[] {
  const block = blocksMap.get(blockId);
  if (!(block instanceof Y.Map)) return [];
  const arr = block.get('childIds');
  if (!(arr instanceof Y.Array)) return [];
  return arr.toArray();
}

function getParentId(blocksMap: Y.Map<unknown>, blockId: string): string | null {
  const block = blocksMap.get(blockId);
  if (!(block instanceof Y.Map)) return null;
  return (block.get('parentId') as string | null) ?? null;
}

async function setupStore(
  seed: (doc: Y.Doc, blocksMap: Y.Map<unknown>, rootIds: Y.Array<string>) => void
) {
  vi.resetModules();
  const [{ blockStore }, events] = await Promise.all([
    import('./useBlockStore'),
    import('../lib/events'),
  ]);

  const doc = new Y.Doc();
  const blocksMap = doc.getMap('blocks');
  const rootIds = doc.getArray<string>('rootIds');

  doc.transact(() => {
    seed(doc, blocksMap, rootIds);
  });

  blockStore.initFromYDoc(doc);
  events.blockEventBus.clear();

  return {
    doc,
    blocksMap,
    rootIds,
    blockStore,
    events,
  };
}

describe('useBlockStore.moveBlock', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('rejects parent -> own grandchild moves (cycle prevention)', async () => {
    const { blockStore, blocksMap, rootIds } = await setupStore((_doc, blocksMap, rootIds) => {
      blocksMap.set('p', createBlockMap('p', null, ['c']));
      blocksMap.set('c', createBlockMap('c', 'p', ['g']));
      blocksMap.set('g', createBlockMap('g', 'c', []));
      rootIds.push(['p']);
    });

    const moved = blockStore.moveBlock('p', 'g', 0, {
      position: 'inside',
      targetId: 'g',
      origin: 'user-drag',
    });

    expect(moved).toBe(false);
    expect(rootIds.toArray()).toEqual(['p']);
    expect(getChildIds(blocksMap, 'p')).toEqual(['c']);
    expect(getChildIds(blocksMap, 'c')).toEqual(['g']);
    expect(getParentId(blocksMap, 'p')).toBeNull();
    expect(getParentId(blocksMap, 'g')).toBe('c');
  });

  it('adjusts index correctly when moving within same parent', async () => {
    const { blockStore, blocksMap } = await setupStore((_doc, blocksMap, rootIds) => {
      blocksMap.set('parent', createBlockMap('parent', null, ['a', 'b', 'c']));
      blocksMap.set('a', createBlockMap('a', 'parent'));
      blocksMap.set('b', createBlockMap('b', 'parent'));
      blocksMap.set('c', createBlockMap('c', 'parent'));
      rootIds.push(['parent']);
    });

    const moved = blockStore.moveBlock('b', 'parent', 3, {
      position: 'below',
      targetId: 'c',
      origin: 'user-drag',
    });

    expect(moved).toBe(true);
    expect(getChildIds(blocksMap, 'parent')).toEqual(['a', 'c', 'b']);
    expect(getParentId(blocksMap, 'b')).toBe('parent');
  });

  it('moves whole subtree without duplication or orphaning', async () => {
    const { blockStore, blocksMap, rootIds } = await setupStore((_doc, blocksMap, rootIds) => {
      blocksMap.set('a', createBlockMap('a', null, ['a1']));
      blocksMap.set('a1', createBlockMap('a1', 'a'));
      blocksMap.set('b', createBlockMap('b', null, []));
      rootIds.push(['a', 'b']);
    });

    const moved = blockStore.moveBlock('a', 'b', 0, {
      position: 'inside',
      targetId: 'b',
      origin: 'user-drag',
    });

    expect(moved).toBe(true);
    expect(rootIds.toArray()).toEqual(['b']);
    expect(getChildIds(blocksMap, 'b')).toEqual(['a']);
    expect(getParentId(blocksMap, 'a')).toBe('b');
    expect(getChildIds(blocksMap, 'a')).toEqual(['a1']);
    expect(getParentId(blocksMap, 'a1')).toBe('a');
  });

  it('emits block:move with details and still emits block:update', async () => {
    const { blockStore, events } = await setupStore((_doc, blocksMap, rootIds) => {
      blocksMap.set('parent', createBlockMap('parent', null, ['a', 'b']));
      blocksMap.set('a', createBlockMap('a', 'parent'));
      blocksMap.set('b', createBlockMap('b', 'parent'));
      rootIds.push(['parent']);
    });

    const envelopes: Array<{ origin: string; events: Array<{ type: string; blockId: string; move?: unknown }> }> = [];
    const subId = events.blockEventBus.subscribe((envelope) => {
      envelopes.push(envelope as unknown as { origin: string; events: Array<{ type: string; blockId: string; move?: unknown }> });
    });

    try {
      const moved = blockStore.moveBlock('a', 'parent', 2, {
        position: 'below',
        targetId: 'b',
        sourcePaneId: 'pane-a',
        targetPaneId: 'pane-b',
        origin: 'user-drag',
      });
      expect(moved).toBe(true);
    } finally {
      events.blockEventBus.unsubscribe(subId);
    }

    const envelope = envelopes[envelopes.length - 1];
    expect(envelope).toBeDefined();
    expect(envelope.origin).toBe(events.Origin.User);

    const moveEvent = envelope.events.find((e) => e.type === 'block:move' && e.blockId === 'a');
    expect(moveEvent).toBeDefined();
    expect(moveEvent?.move).toMatchObject({
      oldParentId: 'parent',
      newParentId: 'parent',
      oldIndex: 0,
      newIndex: 1,
      position: 'below',
      targetId: 'b',
      sourcePaneId: 'pane-a',
      targetPaneId: 'pane-b',
    });
    expect(envelope.events.some((e) => e.type === 'block:update' && e.blockId === 'a')).toBe(true);
  });

  it('is a single undo step for user-drag transaction origin', async () => {
    const { blockStore, blocksMap, rootIds } = await setupStore((_doc, blocksMap, rootIds) => {
      blocksMap.set('parent', createBlockMap('parent', null, ['a', 'b']));
      blocksMap.set('a', createBlockMap('a', 'parent'));
      blocksMap.set('b', createBlockMap('b', 'parent'));
      rootIds.push(['parent']);
    });

    const undoManager = new Y.UndoManager([blocksMap, rootIds], {
      trackedOrigins: new Set([null, undefined, 'user', 'user-drag']),
    });
    undoManager.clear();

    const moved = blockStore.moveBlock('a', 'parent', 2, {
      position: 'below',
      targetId: 'b',
      origin: 'user-drag',
    });

    expect(moved).toBe(true);
    expect(undoManager.undoStack.length).toBe(1);
    expect(getChildIds(blocksMap, 'parent')).toEqual(['b', 'a']);

    undoManager.undo();
    expect(getChildIds(blocksMap, 'parent')).toEqual(['a', 'b']);

    undoManager.redo();
    expect(getChildIds(blocksMap, 'parent')).toEqual(['b', 'a']);
  });
});

// ═════════════════════════════════════════════════════════════════════
// FLO-587 — bail-out diagnostic coverage (rule 14.6)
//
// moveBlock has six early-return paths. Before commit 010cb5f they were
// silent; chirpWriteHandler logged "store rejected move" with no reason.
// These tests assert each path fires a specific logger.warn so the
// diagnostic never regresses to silence.
// ═════════════════════════════════════════════════════════════════════

describe('useBlockStore.moveBlock — bail-out diagnostics (rule 14.6)', () => {
  beforeEach(() => {
    vi.resetModules();
    warnSpy.mockClear();
  });

  it('logs when source block not in state.blocks', async () => {
    const { blockStore } = await setupStore((_doc, blocksMap, rootIds) => {
      blocksMap.set('parent', createBlockMap('parent', null, []));
      rootIds.push(['parent']);
    });

    const moved = blockStore.moveBlock('ghost', 'parent', 0);

    expect(moved).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('source block not in state.blocks'),
      expect.objectContaining({ blockId: 'ghost' }),
    );
  });

  it('logs when source block === target parent (self-move)', async () => {
    const { blockStore } = await setupStore((_doc, blocksMap, rootIds) => {
      blocksMap.set('a', createBlockMap('a', null, []));
      rootIds.push(['a']);
    });

    const moved = blockStore.moveBlock('a', 'a', 0);

    expect(moved).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('self-move'),
      expect.objectContaining({ blockId: 'a' }),
    );
  });

  it('logs when target parent not in state.blocks', async () => {
    const { blockStore } = await setupStore((_doc, blocksMap, rootIds) => {
      blocksMap.set('a', createBlockMap('a', null, []));
      rootIds.push(['a']);
    });

    const moved = blockStore.moveBlock('a', 'ghost-parent', 0);

    expect(moved).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('target parent not in state.blocks'),
      expect.objectContaining({ blockId: 'a', targetParentId: 'ghost-parent' }),
    );
  });

  it('logs when target is descendant of source (cycle)', async () => {
    const { blockStore } = await setupStore((_doc, blocksMap, rootIds) => {
      blocksMap.set('p', createBlockMap('p', null, ['c']));
      blocksMap.set('c', createBlockMap('c', 'p', ['g']));
      blocksMap.set('g', createBlockMap('g', 'c', []));
      rootIds.push(['p']);
    });

    const moved = blockStore.moveBlock('p', 'g', 0);

    expect(moved).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('target is descendant of source (cycle)'),
      expect.objectContaining({ blockId: 'p', targetParentId: 'g' }),
    );
  });

  it('logs when no-op (same parent, same adjusted index)', async () => {
    const { blockStore } = await setupStore((_doc, blocksMap, rootIds) => {
      blocksMap.set('parent', createBlockMap('parent', null, ['a', 'b']));
      blocksMap.set('a', createBlockMap('a', 'parent'));
      blocksMap.set('b', createBlockMap('b', 'parent'));
      rootIds.push(['parent']);
    });

    // Move 'a' onto itself — index 0 in same parent = no-op after adjust
    const moved = blockStore.moveBlock('a', 'parent', 0);

    expect(moved).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('no-op (same position)'),
      expect.objectContaining({ blockId: 'a', oldParentId: 'parent' }),
    );
  });
});
