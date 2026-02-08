import { describe, it, expect } from 'vitest';
import type { Block } from '../lib/blockTypes';
import { computeChangedFields, deepEqualJsonLike } from './useBlockStore';

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

describe('deepEqualJsonLike', () => {
  it('null vs undefined are not equal', () => {
    expect(deepEqualJsonLike(null, undefined)).toBe(false);
  });

  it('empty objects are equal', () => {
    expect(deepEqualJsonLike({}, {})).toBe(true);
  });

  it('array order matters', () => {
    expect(deepEqualJsonLike([1, 2], [2, 1])).toBe(false);
  });

  it('identical arrays are equal', () => {
    expect(deepEqualJsonLike([1, 2, 3], [1, 2, 3])).toBe(true);
  });

  it('nested objects are deeply compared', () => {
    expect(deepEqualJsonLike(
      { a: { b: [1, 2] } },
      { a: { b: [1, 2] } },
    )).toBe(true);

    expect(deepEqualJsonLike(
      { a: { b: [1, 2] } },
      { a: { b: [1, 3] } },
    )).toBe(false);
  });

  it('mixed types are not equal (0 vs false)', () => {
    expect(deepEqualJsonLike(0, false)).toBe(false);
  });

  it('undefined metadata normalized via ?? null are equal', () => {
    // Simulates: block.metadata ?? null (where metadata is undefined)
    const undef: unknown = undefined;
    const a = undef ?? null;
    const b = undef ?? null;
    expect(deepEqualJsonLike(a, b)).toBe(true);
  });

  it('undefined vs undefined are equal via Object.is', () => {
    expect(deepEqualJsonLike(undefined, undefined)).toBe(true);
  });
});

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
