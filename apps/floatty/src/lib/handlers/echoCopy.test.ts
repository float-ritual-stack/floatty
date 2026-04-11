import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── extractBlockRef is private, test via handler behavior ───

// Mock dependencies
vi.mock('../../hooks/useBlockStore', () => ({
  blockStore: {
    blocks: {
      'c229bfa9-1234-5678-9abc-def012345678': { id: 'c229bfa9-1234-5678-9abc-def012345678' },
      'deadbeef-0000-1111-2222-333344445555': { id: 'deadbeef-0000-1111-2222-333344445555' },
    },
  },
}));

vi.mock('../../hooks/useBacklinkNavigation', () => ({
  findPage: vi.fn((name: string) => {
    if (name === 'My Render Page') {
      return { id: 'page-uuid-1234', content: '# My Render Page' };
    }
    return null;
  }),
}));

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { echoCopyHandler } from './echoCopy';
import type { ExecutorActions } from './types';

function createMockActions(blockData?: Record<string, unknown>): ExecutorActions & {
  calls: Record<string, unknown[][]>;
} {
  const calls: Record<string, unknown[][]> = {
    updateBlockContent: [],
    batchCreateBlocksInside: [],
    setBlockStatus: [],
  };

  return {
    calls,
    createBlockInside: vi.fn(() => 'new-block-id'),
    updateBlockContent: vi.fn((...args: unknown[]) => { calls.updateBlockContent.push(args); }),
    batchCreateBlocksInside: vi.fn((...args: unknown[]) => {
      calls.batchCreateBlocksInside.push(args);
      return ['child-1', 'child-2'];
    }),
    setBlockStatus: vi.fn((...args: unknown[]) => { calls.setBlockStatus.push(args); }),
    getBlock: vi.fn((id: string) => blockData?.[id] ?? undefined),
  };
}

describe('echoCopyHandler', () => {
  it('has correct prefix', () => {
    expect(echoCopyHandler.prefixes).toEqual(['echoCopy::']);
  });

  it('errors when no block reference provided', async () => {
    const actions = createMockActions();
    await echoCopyHandler.execute('block-1', 'echoCopy::', actions);
    expect(actions.calls.updateBlockContent[0]).toEqual([
      'block-1',
      'echoCopy:: error — no block reference',
    ]);
  });

  it('errors when block not found', async () => {
    const actions = createMockActions({});
    await echoCopyHandler.execute('block-1', 'echoCopy:: [[abcdef99]]', actions);
    expect(actions.calls.updateBlockContent[0][1]).toContain('block not found');
  });

  it('errors when block has no rendered content', async () => {
    const targetId = 'c229bfa9-1234-5678-9abc-def012345678';
    const actions = createMockActions({
      [targetId]: { id: targetId, metadata: {}, output: null },
    });
    await echoCopyHandler.execute('block-1', 'echoCopy:: [[c229bfa9]]', actions);
    expect(actions.calls.updateBlockContent[0][1]).toContain('no rendered content');
  });

  it('creates blocks from renderedMarkdown metadata', async () => {
    const targetId = 'c229bfa9-1234-5678-9abc-def012345678';
    const markdown = '# Title\n\nSome content here\n\n## Section\n\n- item one\n- item two';
    const actions = createMockActions({
      [targetId]: {
        id: targetId,
        metadata: { renderedMarkdown: markdown },
        output: { data: {} },
        outputType: 'door',
      },
    });

    await echoCopyHandler.execute('block-1', 'echoCopy:: [[c229bfa9]]', actions);

    // Should have called batchCreateBlocksInside
    expect(actions.calls.batchCreateBlocksInside.length).toBe(1);
    expect(actions.calls.batchCreateBlocksInside[0][0]).toBe('block-1');

    // Should have updated content with summary
    const lastUpdate = actions.calls.updateBlockContent[actions.calls.updateBlockContent.length - 1];
    expect(lastUpdate[1]).toContain('[[c229bfa9]]');
    expect(lastUpdate[1]).toContain('sections');

    // Should have set status
    expect(actions.calls.setBlockStatus[0]).toEqual(['block-1', 'complete']);
  });

  it('falls back to flattenSpecToMarkdown when no metadata', async () => {
    const targetId = 'deadbeef-0000-1111-2222-333344445555';
    const actions = createMockActions({
      [targetId]: {
        id: targetId,
        metadata: {},
        output: {
          data: {
            title: 'Test Doc',
            spec: {
              root: 'root-1',
              elements: {
                'root-1': {
                  type: 'DocLayout',
                  props: {},
                  children: ['header-1', 'body-1'],
                },
                'header-1': {
                  type: 'EntryHeader',
                  props: { title: 'Test Document', date: '2026-04-07' },
                  children: [],
                },
                'body-1': {
                  type: 'EntryBody',
                  props: { markdown: 'This is the body content.\n\nWith paragraphs.' },
                  children: [],
                },
              },
            },
          },
        },
        outputType: 'door',
      },
    });

    await echoCopyHandler.execute('block-1', 'echoCopy:: [[deadbeef]]', actions);

    // Should have created blocks via batch
    expect(actions.calls.batchCreateBlocksInside.length).toBe(1);
    expect(actions.calls.setBlockStatus[0]).toEqual(['block-1', 'complete']);
  });

  it('resolves page name references', async () => {
    const actions = createMockActions({
      'page-uuid-1234': {
        id: 'page-uuid-1234',
        metadata: { renderedMarkdown: '# My Page\n\nContent here' },
        output: {},
        outputType: 'door',
      },
    });

    await echoCopyHandler.execute('block-1', 'echoCopy:: [[My Render Page]]', actions);

    expect(actions.calls.batchCreateBlocksInside.length).toBe(1);
    expect(actions.calls.setBlockStatus[0]).toEqual(['block-1', 'complete']);
  });

  it('handles bare hex prefix', async () => {
    const targetId = 'c229bfa9-1234-5678-9abc-def012345678';
    const actions = createMockActions({
      [targetId]: {
        id: targetId,
        metadata: { renderedMarkdown: '# Title\n\nBody' },
        output: {},
      },
    });

    await echoCopyHandler.execute('block-1', 'echoCopy:: c229bfa9', actions);
    expect(actions.calls.batchCreateBlocksInside.length).toBe(1);
  });
});
