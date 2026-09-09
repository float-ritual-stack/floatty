import { createRoot, createSignal, type Accessor } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { buildMarkerIndex, createMarkerIndex } from './markerIndex';
import { getEffectiveMarkers, type MarkerBlock } from './blockContext';

function block(id: string, parentId: string | null = null, value?: string): MarkerBlock {
  return { id, parentId, metadata: { markers: value === undefined ? [] : [{ markerType: 'project', value }] } };
}
function fixture(): Record<string, MarkerBlock> {
  return { board: block('board', null, 'demo'), column: block('column', 'board'), card: block('card', 'column'), other: block('other', null, 'other') };
}
function put(doc: Y.Doc, block: MarkerBlock): Y.Map<unknown> {
  const value = new Y.Map<unknown>();
  value.set('parentId', block.parentId);
  value.set('metadata', block.metadata);
  doc.getMap('blocks').set(block.id, value);
  return value;
}
function harness(onBuild = vi.fn(), pagesContainerId?: Accessor<string | null>) {
  const doc = new Y.Doc();
  const blocks = Object.fromEntries(Object.values(fixture()).map((block) => [block.id, put(doc, block)]));
  const queued = new Map<number, FrameRequestCallback>();
  let next = 0;
  const requestFrame = vi.fn((callback: FrameRequestCallback) => { queued.set(++next, callback); return next; });
  const cancelFrame = vi.fn((id: number) => { queued.delete(id); });
  const reactive = createMarkerIndex(doc, { requestFrame, cancelFrame, onBuild, pagesContainerId });
  const flush = () => {
    const [id, callback] = [...queued][0];
    queued.delete(id);
    callback(16);
  };
  return { doc, blocks, reactive, requestFrame, cancelFrame, flush, onBuild };
}

describe('buildMarkerIndex', () => {
  it('indexes inherited values, distinct type membership, null values and block counts', () => {
    const blocks = fixture();
    blocks.column.metadata = { markers: [
      { markerType: 'mode', value: null },
      { markerType: 'mode', value: 'doing' },
      { markerType: 'mode', value: 'doing' },
    ] };
    const index = buildMarkerIndex(blocks);
    expect(index.having('project', 'demo')).toEqual(['board', 'column', 'card']);
    expect(index.having('project')).toEqual(['board', 'column', 'card', 'other']);
    expect(index.having('mode')).toEqual(['column', 'card']);
    expect(index.having('mode', '')).toEqual(['column', 'card']);
    expect([...index.vocabulary.get('mode')!]).toEqual([['', 2], ['doing', 2]]);
    expect(index.vocabulary.get('project')?.get('demo')).toBe(3);
    expect(index.having('missing')).toEqual([]);
    index.having('project').pop();
    expect(index.having('project')).toHaveLength(4);
  });

  it('matches guarded independent walks for cycles, missing ancestors, and reversed input', () => {
    const blocks = fixture();
    blocks.board.parentId = 'card';
    blocks.other.parentId = 'missing';
    const index = buildMarkerIndex(Object.fromEntries(Object.entries(blocks).reverse()));
    for (const value of ['demo', 'other']) {
      const expected = Object.values(blocks).filter((block) => getEffectiveMarkers((id) => blocks[id], block.id)
        .markers.some((marker) => marker.markerType === 'project' && marker.value === value)).map((block) => block.id).sort();
      expect(index.having('project', value).sort()).toEqual(expected);
    }
  });

  it.each([20_000, 32_000])('measures a warm %i-block synthetic tree rebuild', (size) => {
    const blocks: Record<string, MarkerBlock> = {};
    const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    // Insert leaves first to prove memoisation does not rely on store order.
    for (let n = size; n > 0; n--) blocks[id(n)] = block(id(n), n === 1 ? null : id(Math.floor(n / 2)), n === 1 ? 'demo' : undefined);
    for (let n = 0; n < 3; n++) buildMarkerIndex(blocks);
    const samples = [];
    for (let n = 0; n < 5; n++) {
      const start = performance.now();
      const index = buildMarkerIndex(blocks);
      samples.push(performance.now() - start);
      expect(index.having('project', 'demo')).toHaveLength(size);
    }
    const median = samples.sort((a, b) => a - b)[2];
    // Literal measurement is included in gate output and the PR. A generous CI
    // ceiling catches quadratic walks without turning shared-runner noise red.
    process.stdout.write(`marker index ${size} blocks warm median: ${median.toFixed(2)}ms\n`);
    expect(median).toBeLessThan(500);
  });
});

describe('createMarkerIndex', () => {
  it('excludes the pages container on initial and metadata-driven builds', () => {
    const h = harness(vi.fn(), () => 'board');
    expect(h.reactive.index().having('project', 'demo')).toEqual([]);
    expect(h.reactive.index().vocabulary.get('project')?.has('demo')).toBe(false);
    h.blocks.column.set('metadata', { markers: [{ markerType: 'mode', value: 'doing' }] });
    h.flush();
    expect(h.reactive.index().having('project', 'demo')).toEqual([]);
    expect(h.reactive.index().vocabulary.get('project')?.has('demo')).toBe(false);
    expect(h.reactive.index().having('mode', 'doing')).toEqual(['column', 'card']);
    expect(h.reactive.index().vocabulary.get('mode')?.get('doing')).toBe(2);
    h.reactive.dispose(); h.doc.destroy();
  });

  it('rebuilds when the boundary resolves or changes without a doc mutation', () => {
    const [boundary, setBoundary] = createSignal<string | null>(null);
    const h = harness(vi.fn(), boundary);
    expect(h.reactive.index().having('project', 'demo')).toEqual(['board', 'column', 'card']);
    setBoundary('board'); h.flush();
    expect(h.reactive.index().having('project', 'demo')).toEqual([]);
    expect(h.reactive.index().vocabulary.get('project')?.has('demo')).toBe(false);
    setBoundary('other'); h.flush();
    expect(h.reactive.index().having('project', 'demo')).toEqual(['board', 'column', 'card']);
    expect(h.reactive.index().vocabulary.get('project')?.get('demo')).toBe(3);
    expect(h.reactive.index().having('project', 'other')).toEqual([]);
    setBoundary(null); h.flush();
    expect(h.reactive.index().having('project', 'other')).toEqual(['other']);
    h.reactive.dispose();
    h.requestFrame.mockClear();
    setBoundary('board');
    expect(h.requestFrame).not.toHaveBeenCalled();
    h.doc.destroy();
  });

  it('coalesces remote metadata writes and atomically updates all descendants', () => {
    createRoot((dispose) => {
      const h = harness();
      const before = h.reactive.index();
      h.doc.transact(() => {
        h.blocks.board.set('metadata', { markers: [{ markerType: 'project', value: 'new' }] });
        h.blocks.board.set('updatedAt', 2);
      }, 'remote');
      h.blocks.column.set('metadata', { markers: [{ markerType: 'mode', value: 'doing' }] });
      expect(h.requestFrame).toHaveBeenCalledTimes(1);
      expect(h.reactive.index()).toBe(before);
      h.flush();
      expect(h.onBuild).toHaveBeenCalledTimes(2);
      expect(h.reactive.index()).not.toBe(before);
      expect(h.reactive.index().having('project', 'new')).toEqual(['board', 'column', 'card']);
      expect(before.having('project', 'demo')).toHaveLength(3);
      h.reactive.dispose(); dispose(); h.doc.destroy();
    });
  });

  it('reparents subtrees, removes deleted ancestors, and indexes newly created blocks', () => {
    const h = harness();
    h.blocks.column.set('parentId', 'other'); h.flush();
    expect(h.reactive.index().having('project', 'other')).toEqual(['column', 'card', 'other']);
    h.doc.getMap('blocks').delete('other'); h.flush();
    expect(h.reactive.index().having('project', 'other')).toEqual([]);
    put(h.doc, block('new', 'board')); h.flush();
    expect(h.reactive.index().having('project', 'demo')).toEqual(['board', 'new']);
    h.reactive.dispose(); h.doc.destroy();
  });

  it('observes nested metadata and ignores unrelated content/collapse/output writes', () => {
    const h = harness();
    h.doc.transact(() => {
      h.blocks.board.set('content', 'changed'); h.blocks.board.set('collapsed', true);
      h.blocks.board.set('output', 'demo'); h.blocks.board.set('updatedAt', 2);
    });
    expect(h.requestFrame).not.toHaveBeenCalled();
    const metadata = new Y.Map<unknown>();
    h.blocks.board.set('metadata', metadata); h.flush();
    metadata.set('markers', [{ markerType: 'project', value: 'nested' }]); h.flush();
    expect(h.reactive.index().having('project', 'nested')).toEqual(['board', 'column', 'card']);
    h.reactive.dispose(); h.doc.destroy();
  });

  it('schedules trailing work when publication changes the doc and cancels on disposal', () => {
    const h = harness();
    h.onBuild.mockImplementationOnce(() => h.blocks.board.set('metadata', { markers: [{ markerType: 'project', value: 'trailing' }] }));
    h.blocks.board.set('parentId', 'other'); h.flush();
    expect(h.requestFrame).toHaveBeenCalledTimes(2);
    h.flush();
    expect(h.reactive.index().having('project', 'trailing')).toHaveLength(3);
    h.blocks.board.set('parentId', null);
    h.reactive.dispose(); h.reactive.dispose();
    expect(h.cancelFrame).toHaveBeenCalledTimes(1);
    h.blocks.board.set('parentId', 'other');
    expect(h.requestFrame).toHaveBeenCalledTimes(3);
    h.doc.destroy();
  });
});
