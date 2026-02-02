/**
 * jsonExport.test.ts - Tests for JSON export with validation
 */

import { describe, it, expect } from 'vitest';
import { exportOutlineToJSON, validateExport, type ExportedOutline } from './jsonExport';
import type { Block } from '../hooks/useBlockStore';

describe('exportOutlineToJSON', () => {
  it('exports empty outline correctly', () => {
    const result = exportOutlineToJSON({}, []);

    expect(result.version).toBe(1);
    expect(result.blockCount).toBe(0);
    expect(result.rootIds).toEqual([]);
    expect(result.blocks).toEqual({});
    expect(result.exported).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO date
  });

  it('exports single root block', () => {
    const blocks: Record<string, Block> = {
      'root-1': {
        id: 'root-1',
        content: 'Hello world',
        parentId: null,
        childIds: [],
        type: 'text',
        collapsed: false,
        createdAt: 1000,
        updatedAt: 2000,
        metadata: { tags: ['test'] },
      },
    };

    const result = exportOutlineToJSON(blocks, ['root-1']);

    expect(result.blockCount).toBe(1);
    expect(result.rootIds).toEqual(['root-1']);
    expect(result.blocks['root-1']).toEqual({
      content: 'Hello world',
      parentId: null,
      childIds: [],
      type: 'text',
      collapsed: false,
      createdAt: 1000,
      updatedAt: 2000,
      metadata: { tags: ['test'] },
    });
  });

  it('exports nested blocks with parent/child relationships', () => {
    const blocks: Record<string, Block> = {
      'root': {
        id: 'root',
        content: 'Parent',
        parentId: null,
        childIds: ['child-1', 'child-2'],
        type: 'text',
        collapsed: false,
        createdAt: 0,
        updatedAt: 0,
        metadata: {},
      },
      'child-1': {
        id: 'child-1',
        content: 'First child',
        parentId: 'root',
        childIds: [],
        type: 'text',
        collapsed: false,
        createdAt: 0,
        updatedAt: 0,
        metadata: {},
      },
      'child-2': {
        id: 'child-2',
        content: 'Second child',
        parentId: 'root',
        childIds: [],
        type: 'text',
        collapsed: false,
        createdAt: 0,
        updatedAt: 0,
        metadata: {},
      },
    };

    const result = exportOutlineToJSON(blocks, ['root']);

    expect(result.blockCount).toBe(3);
    expect(result.blocks['root'].childIds).toEqual(['child-1', 'child-2']);
    expect(result.blocks['child-1'].parentId).toBe('root');
    expect(result.blocks['child-2'].parentId).toBe('root');
  });

  it('handles missing optional fields with defaults', () => {
    const blocks: Record<string, Block> = {
      'minimal': {
        id: 'minimal',
        content: 'test',
        // Missing all optional fields
      } as Block,
    };

    const result = exportOutlineToJSON(blocks, ['minimal']);

    expect(result.blocks['minimal']).toEqual({
      content: 'test',
      parentId: null,
      childIds: [],
      type: 'text',
      collapsed: false,
      createdAt: 0,
      updatedAt: 0,
      metadata: {},
    });
  });
});

describe('validateExport', () => {
  const makeValidExport = (): ExportedOutline => ({
    version: 1,
    exported: new Date().toISOString(),
    blockCount: 2,
    rootIds: ['root'],
    blocks: {
      'root': {
        content: 'Parent',
        parentId: null,
        childIds: ['child'],
        type: 'text',
        collapsed: false,
        createdAt: 0,
        updatedAt: 0,
        metadata: {},
      },
      'child': {
        content: 'Child',
        parentId: 'root',
        childIds: [],
        type: 'text',
        collapsed: false,
        createdAt: 0,
        updatedAt: 0,
        metadata: {},
      },
    },
  });

  it('validates correct export', () => {
    const exported = makeValidExport();
    const result = validateExport(exported);

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('catches missing childIds reference', () => {
    const exported = makeValidExport();
    exported.blocks['root'].childIds = ['child', 'missing-block'];

    const result = validateExport(exported);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Block root has childId missing-block that doesn't exist");
  });

  it('catches missing parentId reference', () => {
    const exported = makeValidExport();
    exported.blocks['child'].parentId = 'nonexistent';

    const result = validateExport(exported);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Block child has parentId nonexistent that doesn't exist");
  });

  it('catches missing root block', () => {
    const exported = makeValidExport();
    exported.rootIds = ['root', 'ghost-root'];

    const result = validateExport(exported);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Root ghost-root doesn't exist in blocks");
  });

  it('catches blockCount mismatch', () => {
    const exported = makeValidExport();
    exported.blockCount = 999;

    const result = validateExport(exported);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain("blockCount 999 doesn't match actual 2");
  });

  it('catches root with non-null parentId', () => {
    const exported = makeValidExport();
    exported.blocks['root'].parentId = 'some-parent';

    const result = validateExport(exported);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Root root has non-null parentId: some-parent');
  });

  it('allows null parentId on roots', () => {
    const exported = makeValidExport();
    exported.blocks['root'].parentId = null;

    const result = validateExport(exported);

    expect(result.valid).toBe(true);
  });

  it('collects multiple errors', () => {
    const exported: ExportedOutline = {
      version: 1,
      exported: new Date().toISOString(),
      blockCount: 100, // wrong
      rootIds: ['missing-root'],
      blocks: {
        'orphan': {
          content: 'Orphan',
          parentId: 'ghost-parent',
          childIds: ['ghost-child'],
          type: 'text',
          collapsed: false,
          createdAt: 0,
          updatedAt: 0,
          metadata: {},
        },
      },
    };

    const result = validateExport(exported);

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(1);
  });
});
