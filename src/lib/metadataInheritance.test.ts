import { describe, it, expect } from 'vitest';
import {
  computeEffectiveMetadata,
  markerKey,
  findNewMarkers,
} from './metadataInheritance';
import type { Block } from './blockTypes';
import type { Marker } from '../generated/Marker';

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════

function makeBlock(overrides: Partial<Block> & { id: string }): Block {
  return {
    parentId: null,
    childIds: [],
    content: '',
    type: 'text',
    collapsed: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    metadata: null,
    ...overrides,
  };
}

function makeMarker(markerType: string, value: string | null = null): Marker {
  return { markerType, value };
}

function createLookup(blocks: Block[]): (id: string) => Block | undefined {
  const map = new Map(blocks.map(b => [b.id, b]));
  return (id: string) => map.get(id);
}

// ═══════════════════════════════════════════════════════════════
// computeEffectiveMetadata
// ═══════════════════════════════════════════════════════════════

describe('computeEffectiveMetadata', () => {
  it('returns empty metadata for block with no markers', () => {
    const blocks = [makeBlock({ id: 'a' })];
    const result = computeEffectiveMetadata('a', createLookup(blocks));

    expect(result.markers).toEqual([]);
    expect(result.outlinks).toEqual([]);
    expect(result.isStub).toBe(false);
    expect(result.extractedAt).toBeNull();
  });

  it('returns own markers for a root block', () => {
    const blocks = [
      makeBlock({
        id: 'a',
        metadata: {
          markers: [makeMarker('project', 'floatty')],
          outlinks: [],
          isStub: false,
          extractedAt: 1000,
        },
      }),
    ];
    const result = computeEffectiveMetadata('a', createLookup(blocks));

    expect(result.markers).toEqual([makeMarker('project', 'floatty')]);
    expect(result.extractedAt).toBe(1000);
  });

  it('inherits parent markers additively', () => {
    const blocks = [
      makeBlock({
        id: 'parent',
        metadata: {
          markers: [makeMarker('project', 'floatty')],
          outlinks: [],
          isStub: false,
          extractedAt: 1000,
        },
      }),
      makeBlock({
        id: 'child',
        parentId: 'parent',
        metadata: {
          markers: [makeMarker('mode', 'dev')],
          outlinks: [],
          isStub: false,
          extractedAt: 2000,
        },
      }),
    ];
    const result = computeEffectiveMetadata('child', createLookup(blocks));

    expect(result.markers).toHaveLength(2);
    expect(result.markers).toContainEqual(makeMarker('project', 'floatty'));
    expect(result.markers).toContainEqual(makeMarker('mode', 'dev'));
  });

  it('merges 3-level deep ancestor chain', () => {
    const blocks = [
      makeBlock({
        id: 'root',
        metadata: {
          markers: [makeMarker('project', 'floatty')],
          outlinks: [],
          isStub: false,
          extractedAt: null,
        },
      }),
      makeBlock({
        id: 'mid',
        parentId: 'root',
        metadata: {
          markers: [makeMarker('mode', 'dev')],
          outlinks: [],
          isStub: false,
          extractedAt: null,
        },
      }),
      makeBlock({
        id: 'leaf',
        parentId: 'mid',
        metadata: {
          markers: [makeMarker('issue', '123')],
          outlinks: [],
          isStub: false,
          extractedAt: null,
        },
      }),
    ];
    const result = computeEffectiveMetadata('leaf', createLookup(blocks));

    expect(result.markers).toHaveLength(3);
    expect(result.markers).toContainEqual(makeMarker('project', 'floatty'));
    expect(result.markers).toContainEqual(makeMarker('mode', 'dev'));
    expect(result.markers).toContainEqual(makeMarker('issue', '123'));
  });

  it('deduplicates markers by type+value', () => {
    const blocks = [
      makeBlock({
        id: 'parent',
        metadata: {
          markers: [makeMarker('project', 'floatty')],
          outlinks: [],
          isStub: false,
          extractedAt: null,
        },
      }),
      makeBlock({
        id: 'child',
        parentId: 'parent',
        metadata: {
          markers: [
            makeMarker('project', 'floatty'), // Same as parent
            makeMarker('mode', 'dev'),
          ],
          outlinks: [],
          isStub: false,
          extractedAt: null,
        },
      }),
    ];
    const result = computeEffectiveMetadata('child', createLookup(blocks));

    // Should have 2, not 3 (deduped project::floatty)
    expect(result.markers).toHaveLength(2);
    expect(result.markers).toContainEqual(makeMarker('project', 'floatty'));
    expect(result.markers).toContainEqual(makeMarker('mode', 'dev'));
  });

  it('does NOT inherit outlinks from parent', () => {
    const blocks = [
      makeBlock({
        id: 'parent',
        metadata: {
          markers: [],
          outlinks: ['Page A', 'Page B'],
          isStub: false,
          extractedAt: null,
        },
      }),
      makeBlock({
        id: 'child',
        parentId: 'parent',
        metadata: {
          markers: [],
          outlinks: ['Page C'],
          isStub: false,
          extractedAt: null,
        },
      }),
    ];
    const result = computeEffectiveMetadata('child', createLookup(blocks));

    // Only child's own outlinks
    expect(result.outlinks).toEqual(['Page C']);
  });

  it('does NOT inherit isStub from parent', () => {
    const blocks = [
      makeBlock({
        id: 'parent',
        metadata: {
          markers: [],
          outlinks: [],
          isStub: true,
          extractedAt: null,
        },
      }),
      makeBlock({
        id: 'child',
        parentId: 'parent',
        metadata: {
          markers: [],
          outlinks: [],
          isStub: false,
          extractedAt: null,
        },
      }),
    ];
    const result = computeEffectiveMetadata('child', createLookup(blocks));

    expect(result.isStub).toBe(false);
  });

  it('handles block with null metadata', () => {
    const blocks = [
      makeBlock({ id: 'parent', metadata: null }),
      makeBlock({
        id: 'child',
        parentId: 'parent',
        metadata: {
          markers: [makeMarker('ctx')],
          outlinks: [],
          isStub: false,
          extractedAt: null,
        },
      }),
    ];
    const result = computeEffectiveMetadata('child', createLookup(blocks));

    expect(result.markers).toEqual([makeMarker('ctx')]);
  });

  it('handles block with undefined metadata', () => {
    const blocks = [
      makeBlock({ id: 'parent' }), // metadata defaults to null
      makeBlock({
        id: 'child',
        parentId: 'parent',
        metadata: {
          markers: [makeMarker('issue', '42')],
          outlinks: [],
          isStub: false,
          extractedAt: null,
        },
      }),
    ];
    const result = computeEffectiveMetadata('child', createLookup(blocks));

    expect(result.markers).toEqual([makeMarker('issue', '42')]);
  });

  it('returns empty metadata for nonexistent block', () => {
    const result = computeEffectiveMetadata('missing', () => undefined);

    expect(result.markers).toEqual([]);
    expect(result.outlinks).toEqual([]);
    expect(result.isStub).toBe(false);
    expect(result.extractedAt).toBeNull();
  });

  it('handles broken ancestor chain gracefully', () => {
    // Child references a parent that doesn't exist
    const blocks = [
      makeBlock({
        id: 'orphan',
        parentId: 'missing-parent',
        metadata: {
          markers: [makeMarker('ctx')],
          outlinks: [],
          isStub: false,
          extractedAt: null,
        },
      }),
    ];
    const result = computeEffectiveMetadata('orphan', createLookup(blocks));

    // Should still return own markers
    expect(result.markers).toEqual([makeMarker('ctx')]);
  });

  it('differentiates markers with same type but different values', () => {
    const blocks = [
      makeBlock({
        id: 'parent',
        metadata: {
          markers: [makeMarker('project', 'floatty')],
          outlinks: [],
          isStub: false,
          extractedAt: null,
        },
      }),
      makeBlock({
        id: 'child',
        parentId: 'parent',
        metadata: {
          markers: [makeMarker('project', 'float-hub')],
          outlinks: [],
          isStub: false,
          extractedAt: null,
        },
      }),
    ];
    const result = computeEffectiveMetadata('child', createLookup(blocks));

    // Both project markers should exist (different values)
    expect(result.markers).toHaveLength(2);
    expect(result.markers).toContainEqual(makeMarker('project', 'floatty'));
    expect(result.markers).toContainEqual(makeMarker('project', 'float-hub'));
  });

  it('uses extractedAt from self only', () => {
    const blocks = [
      makeBlock({
        id: 'parent',
        metadata: {
          markers: [],
          outlinks: [],
          isStub: false,
          extractedAt: 1000,
        },
      }),
      makeBlock({
        id: 'child',
        parentId: 'parent',
        metadata: {
          markers: [],
          outlinks: [],
          isStub: false,
          extractedAt: 2000,
        },
      }),
    ];
    const result = computeEffectiveMetadata('child', createLookup(blocks));

    expect(result.extractedAt).toBe(2000);
  });
});

// ═══════════════════════════════════════════════════════════════
// markerKey
// ═══════════════════════════════════════════════════════════════

describe('markerKey', () => {
  it('creates key from type and value', () => {
    expect(markerKey(makeMarker('project', 'floatty'))).toBe('project::floatty');
  });

  it('handles null value', () => {
    expect(markerKey(makeMarker('ctx'))).toBe('ctx::');
  });

  it('handles empty string value', () => {
    expect(markerKey(makeMarker('ctx', ''))).toBe('ctx::');
  });
});

// ═══════════════════════════════════════════════════════════════
// findNewMarkers
// ═══════════════════════════════════════════════════════════════

describe('findNewMarkers', () => {
  it('returns all proposed when no existing markers', () => {
    const proposed = [makeMarker('issue', '123'), makeMarker('ctx')];
    const result = findNewMarkers([], proposed);

    expect(result).toEqual(proposed);
  });

  it('filters out existing markers', () => {
    const existing = [makeMarker('issue', '123')];
    const proposed = [makeMarker('issue', '123'), makeMarker('issue', '456')];
    const result = findNewMarkers(existing, proposed);

    expect(result).toEqual([makeMarker('issue', '456')]);
  });

  it('returns empty when all proposed already exist', () => {
    const existing = [makeMarker('issue', '123'), makeMarker('ctx')];
    const proposed = [makeMarker('issue', '123'), makeMarker('ctx')];
    const result = findNewMarkers(existing, proposed);

    expect(result).toEqual([]);
  });

  it('returns empty when proposed is empty', () => {
    const existing = [makeMarker('issue', '123')];
    const result = findNewMarkers(existing, []);

    expect(result).toEqual([]);
  });
});
