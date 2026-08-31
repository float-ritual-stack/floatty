/**
 * Canonical backlink index fixtures. All ids/content are synthetic and PII-free.
 *
 * @vitest-environment jsdom
 */

import { createRoot } from 'solid-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import type { Block } from './blockTypes';
import { buildBacklinkIndex, createBacklinkIndex } from './backlinkIndex';

const IDS = {
  pages: '00000000-0000-4000-8000-000000000001',
  datePage: '00000000-0000-4000-8000-000000000002',
  alphaPage: '00000000-0000-4000-8000-000000000003',
  sourceA: '00000000-0000-4000-8000-000000000004',
  sourceB: '00000000-0000-4000-8000-000000000005',
  collisionA: 'abcdef12-0000-4000-8000-000000000006',
  collisionB: 'abcdef12-1111-4000-8000-000000000007',
  uniquePrefix: '12345678-2222-4000-8000-000000000008',
} as const;

function block(
  id: string,
  content: string,
  parentId: string | null = null,
  childIds: string[] = [],
  createdAt = 1,
): Block {
  return {
    id,
    parentId,
    childIds,
    content,
    type: 'text',
    collapsed: false,
    createdAt,
    updatedAt: createdAt,
  };
}

function fixture(extra: Block[] = []): Record<string, Block> {
  const blocks = [
    block(IDS.pages, 'pages::', null, [IDS.datePage, IDS.alphaPage]),
    block(IDS.datePage, '# 2026-08-11', IDS.pages, [], 10),
    block(IDS.alphaPage, '# Demo Alpha', IDS.pages, [], 20),
    ...extra,
  ];
  return Object.fromEntries(blocks.map((item) => [item.id, item]));
}

function putYBlock(doc: Y.Doc, value: Block): void {
  const yBlock = new Y.Map<unknown>();
  yBlock.set('id', value.id);
  yBlock.set('parentId', value.parentId);
  yBlock.set('content', value.content);
  yBlock.set('type', value.type);
  yBlock.set('collapsed', value.collapsed);
  yBlock.set('createdAt', value.createdAt);
  yBlock.set('updatedAt', value.updatedAt);
  const children = new Y.Array<string>();
  children.push(value.childIds);
  yBlock.set('childIds', children);
  doc.getMap('blocks').set(value.id, yBlock);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('buildBacklinkIndex', () => {
  it('resolves page names before the hex test, including all-digit dates', () => {
    const index = buildBacklinkIndex(fixture([
      block(IDS.sourceA, 'See [[2026-08-11]]'),
    ]));

    expect(index.referencing(IDS.datePage)).toEqual([IDS.sourceA]);
  });

  it('indexes every nested wikilink level', () => {
    const index = buildBacklinkIndex(fixture([
      block(IDS.sourceA, '[[Demo Alpha [[2026-08-11]]]]'),
    ]));

    expect(index.referencing(IDS.alphaPage)).toEqual([]);
    expect(index.referencing(IDS.datePage)).toEqual([IDS.sourceA]);
    expect(index.referencing('page:demo alpha [[2026-08-11]]')).toEqual([IDS.sourceA]);
  });

  it('resolves exact full ids, compact ids, and genuinely short unique prefixes', () => {
    const index = buildBacklinkIndex(fixture([
      block(IDS.uniquePrefix, 'Unique target'),
      block(IDS.sourceA, `[[${IDS.alphaPage}]] [[12345678]]`),
      block(IDS.sourceB, '[[00000000000040008000000000000003]]'),
    ]));

    expect(index.referencing(IDS.alphaPage)).toEqual([IDS.sourceA, IDS.sourceB]);
    expect(index.referencing(IDS.uniquePrefix)).toEqual([IDS.sourceA]);
  });

  it('lets an exact full id win even when its short prefix is ambiguous', () => {
    const index = buildBacklinkIndex(fixture([
      block(IDS.collisionA, 'Collision A'),
      block(IDS.collisionB, 'Collision B'),
      block(IDS.sourceA, `[[${IDS.collisionA}]]`),
    ]));

    expect(index.referencing(IDS.collisionA)).toEqual([IDS.sourceA]);
    expect(index.ambiguousTargets).toEqual([]);
  });

  it('fails ambiguous prefixes closed and reports the dropped target', () => {
    const index = buildBacklinkIndex(fixture([
      block(IDS.collisionA, 'Collision A'),
      block(IDS.collisionB, 'Collision B'),
      block(IDS.sourceA, '[[abcdef12]]'),
    ]));

    expect(index.referencing(IDS.collisionA)).toEqual([]);
    expect(index.referencing(IDS.collisionB)).toEqual([]);
    expect(index.ambiguousTargets).toEqual(['abcdef12']);
  });

  it('deduplicates repeated targets from one source block', () => {
    const index = buildBacklinkIndex(fixture([
      block(IDS.sourceA, '[[Demo Alpha]] then [[Demo Alpha]]'),
    ]));

    expect(index.referencing(IDS.alphaPage)).toEqual([IDS.sourceA]);
  });

  it('rebuilds a synthetic 26k-block worst-case fixture within the async budget', () => {
    const blocks = fixture();
    for (let i = 9; i < 26_006; i++) {
      const suffix = i.toString().padStart(12, '0');
      const id = `10000000-0000-4000-8000-${suffix}`;
      blocks[id] = block(id, 'revision [[Demo Alpha [[2026-08-11]]]] tail [[100000000]]');
    }

    const startedAt = performance.now();
    const index = buildBacklinkIndex(blocks);
    const elapsedMs = performance.now() - startedAt;

    expect(index.referencing(IDS.datePage)).toHaveLength(25_997);
    expect(index.ambiguousTargets).toEqual(['100000000']);
    // The production measurement is ~37ms. Keep the test generous enough for
    // shared CI while still catching accidental quadratic rebuilds.
    expect(elapsedMs).toBeLessThan(500);
  });

  it('ignores orphan pages containers when authoritative root ids are supplied', () => {
    const orphanContainerId = '00000000-0000-4000-8000-000000000009';
    const orphanPageId = '00000000-0000-4000-8000-000000000010';
    const blocks = fixture([
      block(orphanContainerId, 'pages::', null, [orphanPageId]),
      block(orphanPageId, '# Orphan Page', orphanContainerId),
      block(IDS.sourceA, '[[Orphan Page]]'),
    ]);

    const index = buildBacklinkIndex(blocks, [IDS.pages]);

    expect(index.referencing(orphanPageId)).toEqual([]);
    expect(index.referencing('page:orphan page')).toEqual([IDS.sourceA]);
  });

  it('does not let an unknown-age duplicate page steal canonical resolution', () => {
    const unknownId = '00000000-0000-4000-8000-000000000011';
    const blocks = fixture([
      block(unknownId, '# Demo Alpha', IDS.pages, [], 0),
      block(IDS.sourceA, '[[Demo Alpha]]'),
    ]);
    blocks[IDS.pages] = block(IDS.pages, 'pages::', null, [unknownId, IDS.alphaPage]);

    const index = buildBacklinkIndex(blocks, [IDS.pages]);

    expect(index.referencing(IDS.alphaPage)).toEqual([IDS.sourceA]);
    expect(index.referencing(unknownId)).toEqual([]);
  });

  it('uses the oldest duplicate page as the canonical target', () => {
    const older = block(IDS.alphaPage, '# Demo Alpha', IDS.pages, [], 5);
    const newerId = '00000000-0000-4000-8000-000000000008';
    const newer = block(newerId, '# Demo Alpha', IDS.pages, [], 50);
    const blocks = fixture([older, newer, block(IDS.sourceA, '[[Demo Alpha]]')]);
    blocks[IDS.pages] = block(IDS.pages, 'pages::', null, [IDS.datePage, IDS.alphaPage, newerId]);

    const index = buildBacklinkIndex(blocks);

    expect(index.referencing(IDS.alphaPage)).toEqual([IDS.sourceA]);
    expect(index.referencing(newerId)).toEqual([]);
  });
});

describe('createBacklinkIndex', () => {
  it('coalesces a multi-event Y.Doc transaction into one frame rebuild and swaps atomically', () => {
    const doc = new Y.Doc();
    for (const value of Object.values(fixture([
      block(IDS.sourceA, 'No links yet'),
    ]))) putYBlock(doc, value);
    doc.getArray<string>('rootIds').push([IDS.pages]);

    const queued = new Map<number, FrameRequestCallback>();
    let nextFrame = 1;
    const requestFrame = vi.fn((callback: FrameRequestCallback) => {
      const id = nextFrame++;
      queued.set(id, callback);
      return id;
    });
    const cancelFrame = vi.fn((id: number) => queued.delete(id));
    const onBuild = vi.fn();

    createRoot((disposeRoot) => {
      const reactive = createBacklinkIndex(doc, { requestFrame, cancelFrame, onBuild });
      expect(onBuild).toHaveBeenCalledTimes(1); // initial complete snapshot

      const source = doc.getMap('blocks').get(IDS.sourceA) as Y.Map<unknown>;
      doc.transact(() => {
        source.set('content', '[[Demo Alpha]]');
        source.set('updatedAt', 2);
        source.set('collapsed', true);
      }, 'user');
      // A second observer callback before the frame must coalesce too.
      source.set('content', '[[Demo Alpha]] final');

      expect(requestFrame).toHaveBeenCalledTimes(1);
      expect(onBuild).toHaveBeenCalledTimes(1);
      expect(reactive.index().referencing(IDS.alphaPage)).toEqual([]);

      const [[frameId, callback]] = [...queued.entries()];
      queued.delete(frameId);
      callback(16);

      expect(onBuild).toHaveBeenCalledTimes(2);
      expect(reactive.index().referencing(IDS.alphaPage)).toEqual([IDS.sourceA]);

      reactive.dispose();
      disposeRoot();
    });
  });

  it('does not rebuild for metadata, collapse, output, or updatedAt-only writes', () => {
    const doc = new Y.Doc();
    putYBlock(doc, block(IDS.sourceA, 'No links'));
    const source = doc.getMap('blocks').get(IDS.sourceA) as Y.Map<unknown>;
    const requestFrame = vi.fn(() => 1);
    const reactive = createBacklinkIndex(doc, { requestFrame });

    doc.transact(() => {
      source.set('metadata', { outlinks: [] });
      source.set('collapsed', true);
      source.set('output', 'demo');
      source.set('updatedAt', 2);
    }, 'hook');

    expect(requestFrame).not.toHaveBeenCalled();
    reactive.dispose();
  });

  it('schedules a trailing rebuild when the doc changes during publication', () => {
    const doc = new Y.Doc();
    for (const value of Object.values(fixture([block(IDS.sourceA, 'No links')]))) putYBlock(doc, value);
    doc.getArray<string>('rootIds').push([IDS.pages]);
    const source = doc.getMap('blocks').get(IDS.sourceA) as Y.Map<unknown>;
    const queued: FrameRequestCallback[] = [];
    const requestFrame = vi.fn((callback: FrameRequestCallback) => {
      queued.push(callback);
      return queued.length;
    });
    let builds = 0;
    const reactive = createBacklinkIndex(doc, {
      requestFrame,
      onBuild: () => {
        builds++;
        if (builds === 2) source.set('content', '[[2026-08-11]]');
      },
    });

    source.set('content', '[[Demo Alpha]]');
    queued.shift()?.(16);

    expect(requestFrame).toHaveBeenCalledTimes(2);
    expect(reactive.index().referencing(IDS.alphaPage)).toEqual([IDS.sourceA]);
    queued.shift()?.(32);
    expect(reactive.index().referencing(IDS.datePage)).toEqual([IDS.sourceA]);
    reactive.dispose();
  });

  it('unobserves and cancels queued work on dispose', () => {
    const doc = new Y.Doc();
    putYBlock(doc, block(IDS.sourceA, 'No links'));
    const requestFrame = vi.fn(() => 42);
    const cancelFrame = vi.fn();

    const reactive = createBacklinkIndex(doc, { requestFrame, cancelFrame });
    (doc.getMap('blocks').get(IDS.sourceA) as Y.Map<unknown>).set('content', '[[Demo Alpha]]');
    reactive.dispose();

    expect(cancelFrame).toHaveBeenCalledWith(42);
    (doc.getMap('blocks').get(IDS.sourceA) as Y.Map<unknown>).set('content', '[[2026-08-11]]');
    expect(requestFrame).toHaveBeenCalledTimes(1);
  });
});
