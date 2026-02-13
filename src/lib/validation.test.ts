/**
 * validation.test.ts - Tests for non-blocking export validation
 *
 * FLO-349: Validation must NEVER block export.
 */

import { describe, it, expect } from 'vitest';
import {
  validateForExport,
  groupWarnings,
  WARNING_LABELS,
  type ValidationWarning,
} from './validation';
import type { ExportedOutline } from './jsonExport';

const makeOutline = (overrides?: Partial<ExportedOutline>): ExportedOutline => ({
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
      content: 'Child block',
      parentId: 'root',
      childIds: [],
      type: 'text',
      collapsed: false,
      createdAt: 0,
      updatedAt: 0,
      metadata: {},
    },
  },
  ...overrides,
});

describe('validateForExport', () => {
  it('returns no warnings for valid outline', () => {
    const result = validateForExport(makeOutline());

    expect(result.canExport).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it('always returns canExport: true even with warnings', () => {
    const outline = makeOutline();
    outline.blocks['child'].parentId = 'nonexistent';

    const result = validateForExport(outline);

    expect(result.canExport).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('detects orphaned blocks (missing parent)', () => {
    const outline = makeOutline();
    outline.blocks['child'].parentId = 'ghost-parent';

    const result = validateForExport(outline);

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].type).toBe('orphaned-block');
    expect(result.warnings[0].blockId).toBe('child');
    expect(result.warnings[0].message).toContain('Child block');
  });

  it('detects missing child references', () => {
    const outline = makeOutline();
    outline.blocks['root'].childIds = ['child', 'ghost-child'];

    const result = validateForExport(outline);

    const missingChild = result.warnings.find(w => w.type === 'missing-child');
    expect(missingChild).toBeDefined();
    expect(missingChild!.blockId).toBe('root');
  });

  it('detects missing root blocks', () => {
    const outline = makeOutline();
    outline.rootIds = ['root', 'missing-root'];

    const result = validateForExport(outline);

    const missingRoot = result.warnings.find(w => w.type === 'missing-root');
    expect(missingRoot).toBeDefined();
    expect(missingRoot!.blockId).toBe('missing-root');
  });

  it('detects block count mismatch', () => {
    const outline = makeOutline();
    outline.blockCount = 999;

    const result = validateForExport(outline);

    const mismatch = result.warnings.find(w => w.type === 'count-mismatch');
    expect(mismatch).toBeDefined();
    expect(mismatch!.message).toContain('999');
    expect(mismatch!.message).toContain('2');
  });

  it('detects root block with non-null parentId', () => {
    const outline = makeOutline();
    outline.blocks['root'].parentId = 'some-parent';

    const result = validateForExport(outline);

    const rootParent = result.warnings.find(w => w.type === 'root-has-parent');
    expect(rootParent).toBeDefined();
    expect(rootParent!.blockId).toBe('root');
  });

  it('returns empty warnings for empty outline', () => {
    const outline: ExportedOutline = {
      version: 1,
      exported: new Date().toISOString(),
      blockCount: 0,
      rootIds: [],
      blocks: {},
    };

    const result = validateForExport(outline);

    expect(result.canExport).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it('collects multiple warning types', () => {
    const outline: ExportedOutline = {
      version: 1,
      exported: new Date().toISOString(),
      blockCount: 100,
      rootIds: ['missing-root'],
      blocks: {
        'orphan': {
          content: 'Orphan block',
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

    const result = validateForExport(outline);

    expect(result.canExport).toBe(true);
    const types = new Set(result.warnings.map(w => w.type));
    expect(types.size).toBeGreaterThan(1);
  });

  it('truncates long block content in messages', () => {
    const outline = makeOutline();
    outline.blocks['child'].content = 'A'.repeat(100);
    outline.blocks['child'].parentId = 'nonexistent';

    const result = validateForExport(outline);

    const warning = result.warnings.find(w => w.type === 'orphaned-block');
    expect(warning).toBeDefined();
    // Message should contain truncated content, not full 100 chars
    expect(warning!.message.length).toBeLessThan(120);
  });
});

describe('groupWarnings', () => {
  it('groups warnings by type', () => {
    const warnings: ValidationWarning[] = [
      { type: 'orphaned-block', message: 'orphan 1', blockId: 'a' },
      { type: 'orphaned-block', message: 'orphan 2', blockId: 'b' },
      { type: 'missing-child', message: 'missing child 1', blockId: 'c' },
    ];

    const groups = groupWarnings(warnings);

    expect(groups.get('orphaned-block')).toHaveLength(2);
    expect(groups.get('missing-child')).toHaveLength(1);
    expect(groups.has('missing-root')).toBe(false);
  });

  it('returns empty map for no warnings', () => {
    const groups = groupWarnings([]);
    expect(groups.size).toBe(0);
  });
});

describe('WARNING_LABELS', () => {
  it('has labels for all warning types', () => {
    const types = ['orphaned-block', 'missing-child', 'missing-root', 'count-mismatch', 'root-has-parent'] as const;
    for (const type of types) {
      expect(WARNING_LABELS[type]).toBeDefined();
      expect(typeof WARNING_LABELS[type]).toBe('string');
    }
  });
});
