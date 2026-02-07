import { describe, it, expect } from 'vitest';
import type { Block } from '../lib/blockTypes';
import { computeChangedFields } from './useBlockStore';

function createBlock(overrides: Partial<Block> = {}): Block {
  return {
    id: 'b1',
    parentId: null,
    childIds: [],
    content: 'hello',
    type: 'text',
    metadata: null,
    collapsed: false,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('computeChangedFields', () => {
  it('returns empty array when only timestamp changes', () => {
    const previous = createBlock({ updatedAt: 1 });
    const current = createBlock({ updatedAt: 2 });

    expect(computeChangedFields(current, previous)).toEqual([]);
  });

  it('detects core block field changes', () => {
    const previous = createBlock({
      content: 'old',
      type: 'text',
      collapsed: false,
      parentId: 'p1',
      childIds: ['c1'],
    });
    const current = createBlock({
      content: 'new',
      type: 'h1',
      collapsed: true,
      parentId: 'p2',
      childIds: ['c1', 'c2'],
    });

    expect(computeChangedFields(current, previous)).toEqual([
      'content',
      'type',
      'collapsed',
      'parentId',
      'childIds',
    ]);
  });

  it('detects metadata and output field changes', () => {
    const previous = createBlock({
      metadata: { markers: [], outlinks: [], isStub: false, extractedAt: null },
      output: { lines: ['a'] },
      outputType: 'daily-view',
      outputStatus: 'running',
    });
    const current = createBlock({
      metadata: { markers: [{ markerType: 'project', value: 'floatty' }], outlinks: [], isStub: false, extractedAt: null },
      output: { lines: ['a', 'b'] },
      outputType: 'kanban-view',
      outputStatus: 'complete',
    });

    expect(computeChangedFields(current, previous)).toEqual([
      'metadata',
      'output',
      'outputType',
      'outputStatus',
    ]);
  });
});
