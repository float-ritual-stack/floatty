/**
 * useOutlinerSelection.deleteSelection — zoom-root invariants
 * (quirk-audit cluster A, live-test follow-up 2026-07-10)
 *
 * Cmd+A escalates to block selection; Backspace routes through
 * deleteSelection. Deleting the last block(s) of a zoomed page used to
 * unzoom to the full tree. Now: the first selected child is spared and
 * CLEARED, the zoom holds. Normal selection deletes are unchanged.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRoot } from 'solid-js';
import { useOutlinerSelection } from './useOutlinerSelection';

interface FakeBlock { content: string; parentId: string | null; childIds: string[] }

function makeHarness(opts: {
  blocks: Record<string, FakeBlock>;
  rootIds?: string[];
  zoomedRootId?: string | null;
  focusedId?: string | null;
}) {
  const blocks = opts.blocks;
  const deleteBlocks = vi.fn((ids: string[]) => {
    for (const id of ids) {
      const b = blocks[id];
      if (!b) continue;
      if (b.parentId && blocks[b.parentId]) {
        blocks[b.parentId].childIds = blocks[b.parentId].childIds.filter(c => c !== id);
      }
      delete blocks[id];
    }
  });
  const updateBlockContent = vi.fn((id: string, content: string) => {
    if (blocks[id]) blocks[id].content = content;
  });
  const createBlockInside = vi.fn((parentId: string) => {
    const id = `fresh-${parentId}`;
    blocks[id] = { content: '', parentId, childIds: [] };
    blocks[parentId]?.childIds.push(id);
    return id;
  });
  const setZoomedRoot = vi.fn();
  const setFocusedBlockId = vi.fn();

  let selection!: ReturnType<typeof useOutlinerSelection>;
  createRoot(() => {
    selection = useOutlinerSelection({
      blockStore: {
        blocks,
        rootIds: opts.rootIds ?? [],
        deleteBlocks,
        updateBlockContent,
        createBlockInside,
      },
      paneStore: { setZoomedRoot },
      paneId: 'pane-1',
      focusedBlockId: () => opts.focusedId ?? null,
      setFocusedBlockId,
      zoomedRootId: () => opts.zoomedRootId ?? null,
      getVisibleBlockIds: () => Object.keys(blocks),
      getAncestors: (id: string) => {
        const chain: string[] = [];
        let cur: string | null = id;
        while (cur) { chain.unshift(cur); cur = blocks[cur]?.parentId ?? null; }
        return chain;
      },
      findFocusAfterDelete: () => null,
    });
  });
  return { selection, blocks, deleteBlocks, updateBlockContent, createBlockInside, setZoomedRoot, setFocusedBlockId };
}

function pageWithChildren(childContents: string[]): Record<string, FakeBlock> {
  const blocks: Record<string, FakeBlock> = {
    'page': { content: '# My Page', parentId: 'pages-root', childIds: childContents.map((_, i) => `c${i}`) },
  };
  childContents.forEach((content, i) => {
    blocks[`c${i}`] = { content, parentId: 'page', childIds: [] };
  });
  return blocks;
}

beforeEach(() => vi.clearAllMocks());

describe('toggle seeds the focused block (FLO-805 cmd+click)', () => {
  const threeBlocks = () => ({
    a: { content: 'a', parentId: null, childIds: [] },
    b: { content: 'b', parentId: null, childIds: [] },
    c: { content: 'c', parentId: null, childIds: [] },
  });

  it('cmd+click from an empty selection includes the focused block AND the clicked one', () => {
    const h = makeHarness({ blocks: threeBlocks(), focusedId: 'a' });
    h.selection.handleSelect('c', 'toggle'); // cmd+click c while editing a
    expect([...h.selection.selectedBlockIds()].sort()).toEqual(['a', 'c']);
  });

  it('cmd+click the block you are already in selects just it (no seed-then-remove)', () => {
    const h = makeHarness({ blocks: threeBlocks(), focusedId: 'a' });
    h.selection.handleSelect('a', 'toggle');
    expect([...h.selection.selectedBlockIds()]).toEqual(['a']);
  });

  it('a second cmd+click does not re-seed (selection already non-empty)', () => {
    const h = makeHarness({ blocks: threeBlocks(), focusedId: 'a' });
    h.selection.handleSelect('c', 'toggle'); // {a, c}
    h.selection.handleSelect('b', 'toggle'); // {a, c, b} — no fresh seed
    expect([...h.selection.selectedBlockIds()].sort()).toEqual(['a', 'b', 'c']);
  });

  it('toggling the clicked block off leaves the seeded focused block', () => {
    const h = makeHarness({ blocks: threeBlocks(), focusedId: 'a' });
    h.selection.handleSelect('c', 'toggle'); // {a, c}
    h.selection.handleSelect('c', 'toggle'); // remove c -> {a}
    expect([...h.selection.selectedBlockIds()]).toEqual(['a']);
  });

  it('no focused block: cmd+click adds only the clicked one (unchanged)', () => {
    const h = makeHarness({ blocks: threeBlocks(), focusedId: null });
    h.selection.handleSelect('c', 'toggle');
    expect([...h.selection.selectedBlockIds()]).toEqual(['c']);
  });
});

describe('deleteSelection — zoomed page keeps a typeable child', () => {
  it('Cmd+A → Backspace on the LAST block clears it in place (no delete, no unzoom)', () => {
    const h = makeHarness({ blocks: pageWithChildren(['only child text']), zoomedRootId: 'page' });
    h.selection.handleSelect('c0', 'anchor');

    h.selection.deleteSelection();

    expect(h.deleteBlocks).not.toHaveBeenCalled();       // block survives...
    expect(h.blocks['c0'].content).toBe('');             // ...emptied in place
    expect(h.setZoomedRoot).not.toHaveBeenCalled();      // zoom holds
    expect(h.setFocusedBlockId).toHaveBeenCalledWith('c0');
  });

  it('select-all across N blocks spares the FIRST child cleared, deletes the rest', () => {
    const h = makeHarness({ blocks: pageWithChildren(['one', 'two', 'three']), zoomedRootId: 'page' });
    for (const id of ['c0', 'c1', 'c2']) h.selection.handleSelect(id, 'toggle');

    h.selection.deleteSelection();

    expect(h.deleteBlocks).toHaveBeenCalledWith(expect.arrayContaining(['c1', 'c2']));
    expect(h.deleteBlocks.mock.calls[0][0]).not.toContain('c0');
    expect(h.blocks['c0'].content).toBe('');
    expect(h.setZoomedRoot).not.toHaveBeenCalled();
    expect(h.setFocusedBlockId).toHaveBeenCalledWith('c0');
  });

  it('partial selection inside a zoomed page deletes normally (no clearing)', () => {
    const h = makeHarness({ blocks: pageWithChildren(['one', 'two']), zoomedRootId: 'page' });
    h.selection.handleSelect('c1', 'anchor');

    h.selection.deleteSelection();

    expect(h.deleteBlocks).toHaveBeenCalledWith(['c1']);
    expect(h.blocks['c0'].content).toBe('one');          // untouched
    expect(h.updateBlockContent).not.toHaveBeenCalled();
    expect(h.setZoomedRoot).not.toHaveBeenCalled();
  });

  it('unzoomed selection delete is unchanged (block actually deleted)', () => {
    const h = makeHarness({ blocks: pageWithChildren(['one']), zoomedRootId: null });
    h.selection.handleSelect('c0', 'anchor');

    h.selection.deleteSelection();

    expect(h.deleteBlocks).toHaveBeenCalledWith(['c0']);
    expect(h.updateBlockContent).not.toHaveBeenCalled();
  });

  it('defensive fallback: page emptied through the normal path gets a fresh child, not an unzoom', () => {
    // Selection includes a nested block whose deletion cascades — simulate a
    // state where the guard misses and the page ends up childless.
    const blocks: Record<string, FakeBlock> = {
      'page': { content: '# P', parentId: null, childIds: ['c0'] },
      'c0': { content: 'kid', parentId: 'page', childIds: [] },
    };
    const h = makeHarness({ blocks, zoomedRootId: 'page' });
    // Bypass the clear-in-place branch by making the guard see a survivor
    // that the delete then removes: select c0 AND a phantom the guard
    // can't see. Simplest honest simulation: call with page having gained
    // a second selected child whose id sorts after removal.
    h.selection.handleSelect('c0', 'anchor');
    // Force the guard off by removing c0 from childIds pre-delete (stale
    // selection state — the cleanup effect normally handles this).
    blocks['page'].childIds = ['ghost'];
    blocks['ghost'] = { content: 'g', parentId: 'page', childIds: [] };
    blocks['page'].childIds = ['ghost'];
    // ghost is NOT selected → guard sees a survivor → normal delete path.
    // Now make the delete cascade take ghost too:
    h.deleteBlocks.mockImplementationOnce((ids: string[]) => {
      for (const id of [...ids, 'ghost']) {
        const b = blocks[id]; if (!b) continue;
        if (b.parentId && blocks[b.parentId]) blocks[b.parentId].childIds = blocks[b.parentId].childIds.filter(c => c !== id);
        delete blocks[id];
      }
    });

    h.selection.deleteSelection();

    // Invariant restored via fresh child — and NO unzoom bounce.
    expect(h.createBlockInside).toHaveBeenCalledWith('page');
    expect(h.setZoomedRoot).not.toHaveBeenCalled();
    expect(h.setFocusedBlockId).toHaveBeenCalledWith('fresh-page');
  });

  it('deleting the zoomed page itself still exits the zoom', () => {
    const blocks: Record<string, FakeBlock> = {
      'page': { content: '# P', parentId: null, childIds: ['c0'] },
      'c0': { content: 'kid', parentId: 'page', childIds: [] },
    };
    const h = makeHarness({ blocks, zoomedRootId: 'page' });
    h.selection.handleSelect('page', 'anchor');
    h.deleteBlocks.mockImplementationOnce(() => { delete blocks['page']; delete blocks['c0']; });

    h.selection.deleteSelection();

    expect(h.setZoomedRoot).toHaveBeenCalledWith('pane-1', null);
  });
});
