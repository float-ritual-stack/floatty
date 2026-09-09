/**
 * help:: — guides are bundled into the frontend at build time, so the
 * handler must work on any machine, not only the one holding the checkout
 * (the old read_help_file command baked CARGO_MANIFEST_DIR into the binary).
 */
import { describe, it, expect, vi } from 'vitest';
import { helpHandler, helpDocFor } from './help';
import type { ExecutorActions } from './types';

function createMockActions() {
  const calls = { updateBlockContent: [] as unknown[][], batch: [] as unknown[][], setBlockStatus: [] as unknown[][] };
  const actions = {
    createBlockInside: vi.fn(() => 'out-1'),
    updateBlockContent: vi.fn((...args: unknown[]) => { calls.updateBlockContent.push(args); }),
    batchCreateBlocksInsideAtTop: vi.fn((...args: unknown[]) => { calls.batch.push(args); return []; }),
    setBlockStatus: vi.fn((...args: unknown[]) => { calls.setBlockStatus.push(args); }),
  } as unknown as ExecutorActions;
  return { actions, calls };
}

describe('help:: handler', () => {
  it('bundles every mapped guide — no topic points at a file the build left out', () => {
    for (const topic of ['keyboard', 'handlers', 'hooks', 'events', 'backup', 'full-width', 'eval', 'func', 'doors', 'echocopy', 'kanban', 'query', 'props']) {
      expect(helpDocFor(topic), topic).toMatch(/\S/);
    }
    expect(helpDocFor('nope')).toBeUndefined();
  });

  it('help:: query inserts the bundled QUERY.md as blocks without touching the filesystem', async () => {
    const { actions, calls } = createMockActions();
    await helpHandler.execute('block-1', 'help:: query', actions);
    expect(calls.batch).toHaveLength(1);
    const [parentId, ops] = calls.batch[0] as [string, Array<{ content: string }>];
    expect(parentId).toBe('block-1');
    expect(ops.some((op) => op.content.includes('query::'))).toBe(true);
    expect(calls.setBlockStatus.at(-1)).toEqual(['block-1', 'complete']);
  });

  it('unknown topic lists the available ones and errors', async () => {
    const { actions, calls } = createMockActions();
    await helpHandler.execute('block-1', 'help:: nope', actions);
    expect(String(calls.updateBlockContent[0][1])).toContain('Unknown topic: "nope"');
    expect(calls.setBlockStatus.at(-1)).toEqual(['block-1', 'error']);
  });
});
