/**
 * Conversation Handler — cursor-advance regression tests
 *
 * Asserts that both executeConversationTurn and executeSingleTurn focus the
 * newly-created continuation block so the user can keep typing while the LLM
 * responds. Mirrors the pattern from send.ts.
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
    // Install a rAF shim that runs synchronously so tests don't need to wait.
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

  it('executeSingleTurn focuses the continuation block after response lands', async () => {
    mockInvoke.mockResolvedValue('hello back');

    // No tree navigation -> falls through to executeSingleTurn.
    // createBlockInsideAtTop is used for the placeholder (when provided);
    // createBlockInside is used once for the empty continuation block.
    const actions = makeActions();
    await conversationHandler.execute('b1', 'ai:: hello', actions);

    expect(actions.focusBlock).toHaveBeenCalledTimes(1);
    const createInsideCalls = (actions.createBlockInside as ReturnType<typeof vi.fn>).mock.results;
    const continuationId = createInsideCalls[createInsideCalls.length - 1].value;
    expect(actions.focusBlock).toHaveBeenCalledWith(continuationId);
  });

  it('executeConversationTurn focuses the continuation block after response lands', async () => {
    mockInvoke.mockResolvedValue('multi-turn response');

    const root = makeBlock({ id: 'root', content: 'ai:: hello', childIds: [] });
    // Tree navigation available — conversationHandler goes through
    // executeConversationTurn for a fresh-root ai:: block with no children.
    const actions = makeActions({
      getBlock: vi.fn((id: string) => (id === 'root' ? root : undefined)) as ExecutorActions['getBlock'],
      getParentId: vi.fn(() => undefined),
      getChildren: vi.fn(() => []),
    });

    await conversationHandler.execute('root', 'ai:: hello', actions);

    expect(actions.focusBlock).toHaveBeenCalledTimes(1);
    const createCalls = (actions.createBlockInside as ReturnType<typeof vi.fn>).mock.results;
    // createBlockInside is called once for nextId. The placeholder uses
    // createBlockInsideAtTop (falls back to createBlockInside only if the
    // former is undefined). With both provided, nextId is the only
    // createBlockInside call — which is what we focus.
    const continuationId = createCalls[createCalls.length - 1].value;
    expect(actions.focusBlock).toHaveBeenCalledWith(continuationId);
  });

  it('does not crash when focusBlock is undefined on actions', async () => {
    mockInvoke.mockResolvedValue('ok');

    const actions = makeActions({ focusBlock: undefined });
    await expect(
      conversationHandler.execute('b1', 'ai:: hello', actions)
    ).resolves.not.toThrow();
  });

  it('does not call focusBlock when the LLM request errors out', async () => {
    mockInvoke.mockRejectedValue(new Error('network down'));

    const actions = makeActions();
    await conversationHandler.execute('b1', 'ai:: hello', actions);

    // Error path writes `error::` to the placeholder and sets status='error'
    // — it does NOT create a continuation block, so no focus call.
    expect(actions.focusBlock).not.toHaveBeenCalled();
  });
});
