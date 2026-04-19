/**
 * Conversation Handler — cursor-advance regression tests
 *
 * Asserts that both executeConversationTurn and executeSingleTurn focus the
 * newly-created continuation block BEFORE awaiting the LLM, so the user can
 * keep typing while the response streams back. Mirrors send.ts timing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockLogger = vi.hoisted(() => ({
  trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
}));
vi.mock('../../logger', () => ({
  createLogger: () => mockLogger,
}));

const mockInvoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({
  invoke: mockInvoke,
}));

import { conversationHandler } from './index';
import type { ExecutorActions } from '../types';
import type { ConversationBlock } from './types';

function makeActions(overrides: Partial<ExecutorActions> = {}): ExecutorActions {
  let n = 0;
  return {
    createBlockInside: vi.fn(() => `new-block-${++n}`),
    createBlockInsideAtTop: vi.fn(() => `new-top-${++n}`),
    createBlockAfter: vi.fn(() => `new-after-${++n}`),
    updateBlockContent: vi.fn(),
    setBlockStatus: vi.fn(),
    focusBlock: vi.fn(),
    deleteBlock: vi.fn(() => true),
    getBlock: vi.fn(() => ({ content: '' })) as ExecutorActions['getBlock'],
    ...overrides,
  };
}

function makeBlock(overrides: Partial<ConversationBlock> = {}): ConversationBlock {
  return {
    id: 'root',
    content: 'ai:: hello',
    childIds: [],
    parentId: null,
    type: 'ai',
    collapsed: false,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as ConversationBlock;
}

describe('conversationHandler — cursor-advance on execute', () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    // rAF runs synchronously so tests don't need timers.
    (globalThis as typeof globalThis & {
      requestAnimationFrame: (cb: FrameRequestCallback) => number;
    }).requestAnimationFrame = ((cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    }) as typeof globalThis.requestAnimationFrame;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('executeSingleTurn focuses the continuation block BEFORE the LLM responds', async () => {
    // The invoke promise is parked; resolve it manually so we can observe
    // ordering. The focus call must happen while invoke is still pending.
    let resolveInvoke: (v: string) => void = () => {};
    mockInvoke.mockReturnValueOnce(new Promise<string>((res) => { resolveInvoke = res; }));

    const actions = makeActions();
    const exec = conversationHandler.execute('b1', 'ai:: hello', actions);

    // At this microtask, invoke has been called but NOT resolved.
    // focusBlock should already have fired (via sync rAF shim).
    await Promise.resolve();
    expect(actions.focusBlock).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledTimes(1);

    const createInsideCalls = (actions.createBlockInside as ReturnType<typeof vi.fn>).mock.results;
    const continuationId = createInsideCalls[createInsideCalls.length - 1].value;
    expect(actions.focusBlock).toHaveBeenCalledWith(continuationId);

    resolveInvoke('ok');
    await exec;
  });

  it('executeConversationTurn focuses the continuation block BEFORE the LLM responds', async () => {
    let resolveInvoke: (v: string) => void = () => {};
    mockInvoke.mockReturnValueOnce(new Promise<string>((res) => { resolveInvoke = res; }));

    const root = makeBlock({ id: 'root', content: 'ai:: hello', childIds: [] });
    const actions = makeActions({
      getBlock: vi.fn((id: string) => (id === 'root' ? root : { content: '' })) as ExecutorActions['getBlock'],
      getParentId: vi.fn(() => undefined),
      getChildren: vi.fn(() => []),
    });

    const exec = conversationHandler.execute('root', 'ai:: hello', actions);
    await Promise.resolve();

    expect(actions.focusBlock).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledTimes(1);

    const createCalls = (actions.createBlockInside as ReturnType<typeof vi.fn>).mock.results;
    const continuationId = createCalls[createCalls.length - 1].value;
    expect(actions.focusBlock).toHaveBeenCalledWith(continuationId);

    resolveInvoke('multi-turn response');
    await exec;
  });

  it('does not crash when focusBlock is undefined on actions', async () => {
    mockInvoke.mockResolvedValue('ok');
    const actions = makeActions({ focusBlock: undefined });
    await expect(
      conversationHandler.execute('b1', 'ai:: hello', actions)
    ).resolves.not.toThrow();
  });

  it('deletes the empty continuation block when the LLM errors out', async () => {
    mockInvoke.mockRejectedValue(new Error('network down'));

    const actions = makeActions({
      // Simulate the pre-created continuation staying empty through the error.
      getBlock: vi.fn(() => ({ content: '' })) as ExecutorActions['getBlock'],
    });
    await conversationHandler.execute('b1', 'ai:: hello', actions);

    // Focus still fires (before the invoke rejected); cleanup deletes the block.
    expect(actions.focusBlock).toHaveBeenCalledTimes(1);
    expect(actions.deleteBlock).toHaveBeenCalledTimes(1);
  });

  it('preserves the continuation block if the user has typed into it before the error', async () => {
    mockInvoke.mockRejectedValue(new Error('network down'));

    // Simulate user typing "halfway" before the error came back.
    const actions = makeActions({
      getBlock: vi.fn(() => ({ content: 'halfway typed' })) as ExecutorActions['getBlock'],
    });
    await conversationHandler.execute('b1', 'ai:: hello', actions);

    expect(actions.focusBlock).toHaveBeenCalledTimes(1);
    expect(actions.deleteBlock).not.toHaveBeenCalled();
  });
});
