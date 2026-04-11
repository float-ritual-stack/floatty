/**
 * Handler Executor Tests
 *
 * Tests the hook lifecycle integration for handler execution.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the logger module so tests can verify error logging
const mockLogger = vi.hoisted(() => ({
  trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
}));
vi.mock('../logger', () => ({
  createLogger: () => mockLogger,
}));

import { executeHandler, createHookBlockStore } from './executor';
import { hookRegistry } from '../hooks/hookRegistry';
import type { BlockHandler, ExecutorActions } from './types';
import type { Block } from '../blockTypes';
import type { HookBlockStore, Hook } from '../hooks/types';

// ═══════════════════════════════════════════════════════════════
// TEST HELPERS
// ═══════════════════════════════════════════════════════════════

function createTestBlock(
  id: string,
  content: string,
  overrides: Partial<Block> = {}
): Block {
  return {
    id,
    parentId: null,
    childIds: [],
    content,
    type: 'text' as const,
    collapsed: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function createTestStore(blocks: Record<string, Block>): HookBlockStore {
  return {
    getBlock: (id: string) => blocks[id],
    blocks,
    rootIds: Object.keys(blocks),
  };
}

function createTestHandler(executeFn?: BlockHandler['execute']): BlockHandler {
  return {
    prefixes: ['test::'],
    execute: executeFn ?? vi.fn().mockResolvedValue(undefined),
  };
}

function createTestActions(overrides: Partial<ExecutorActions> = {}): ExecutorActions {
  return {
    createBlockInside: vi.fn().mockReturnValue('new-block-id'),
    updateBlockContent: vi.fn(),
    deleteBlock: vi.fn().mockReturnValue(true),
    setBlockStatus: vi.fn(),
    getBlock: vi.fn(),
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════

describe('executeHandler', () => {
  beforeEach(() => {
    hookRegistry.clear();
  });

  afterEach(() => {
    hookRegistry.clear();
  });

  describe('basic execution', () => {
    it('executes handler when no hooks registered', async () => {
      const block = createTestBlock('b1', 'test:: hello');
      const store = createTestStore({ b1: block });
      const handler = createTestHandler();
      const actions = createTestActions();

      await executeHandler(handler, 'b1', 'test:: hello', actions, store);

      expect(handler.execute).toHaveBeenCalledTimes(1);
      expect(handler.execute).toHaveBeenCalledWith(
        'b1',
        'test:: hello',
        expect.objectContaining({
          createBlockInside: expect.any(Function),
        })
      );
    });

    it('does nothing when block not found', async () => {
      const store = createTestStore({});
      const handler = createTestHandler();
      const actions = createTestActions();

      await executeHandler(handler, 'nonexistent', 'test::', actions, store);

      expect(handler.execute).not.toHaveBeenCalled();
    });
  });

  describe('execute:before hooks', () => {
    it('runs execute:before hooks before handler', async () => {
      const order: string[] = [];

      const beforeHook: Hook = {
        id: 'test-before',
        event: 'execute:before',
        filter: () => true,
        priority: 0,
        handler: () => {
          order.push('before-hook');
          return {};
        },
      };
      hookRegistry.register(beforeHook);

      const handler = createTestHandler(async () => {
        order.push('handler');
      });

      const block = createTestBlock('b1', 'test::');
      const store = createTestStore({ b1: block });
      const actions = createTestActions();

      await executeHandler(handler, 'b1', 'test::', actions, store);

      expect(order).toEqual(['before-hook', 'handler']);
    });

    it('aborts execution when hook returns abort', async () => {
      const abortHook: Hook = {
        id: 'abort-hook',
        event: 'execute:before',
        filter: () => true,
        priority: 0,
        handler: () => ({
          abort: true,
          reason: 'Dangerous command',
        }),
      };
      hookRegistry.register(abortHook);

      const handler = createTestHandler();
      const block = createTestBlock('b1', 'test::');
      const store = createTestStore({ b1: block });
      const actions = createTestActions();

      await executeHandler(handler, 'b1', 'test::', actions, store);

      expect(handler.execute).not.toHaveBeenCalled();
      expect(actions.updateBlockContent).toHaveBeenCalledWith(
        'b1',
        'blocked:: Dangerous command'
      );
    });

    it('uses modified content from hook', async () => {
      const modifyHook: Hook = {
        id: 'modify-hook',
        event: 'execute:before',
        filter: () => true,
        priority: 0,
        handler: () => ({
          content: 'test:: modified content',
        }),
      };
      hookRegistry.register(modifyHook);

      const handler = createTestHandler();
      const block = createTestBlock('b1', 'test:: original');
      const store = createTestStore({ b1: block });
      const actions = createTestActions();

      await executeHandler(handler, 'b1', 'test:: original', actions, store);

      expect(handler.execute).toHaveBeenCalledWith(
        'b1',
        'test:: modified content',
        expect.any(Object)
      );
    });

    it('passes hook context to handler via extended actions', async () => {
      const contextHook: Hook = {
        id: 'context-hook',
        event: 'execute:before',
        filter: () => true,
        priority: 0,
        handler: () => ({
          context: {
            customData: { value: 'injected by hook', count: 42 },
          },
        }),
      };
      hookRegistry.register(contextHook);

      let receivedActions: ExecutorActions | null = null;
      const handler = createTestHandler(async (id, content, actions) => {
        receivedActions = actions;
      });

      const block = createTestBlock('b1', 'test::');
      const store = createTestStore({ b1: block });
      const actions = createTestActions();

      await executeHandler(handler, 'b1', 'test::', actions, store);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const hookContext = (receivedActions as any)?.hookContext;
      expect(hookContext).toBeDefined();
      expect(hookContext.customData.value).toBe('injected by hook');
      expect(hookContext.customData.count).toBe(42);
    });
  });

  describe('execute:after hooks', () => {
    it('runs execute:after hooks after successful execution', async () => {
      const order: string[] = [];

      const afterHook: Hook = {
        id: 'test-after',
        event: 'execute:after',
        filter: () => true,
        priority: 0,
        handler: () => {
          order.push('after-hook');
          return {};
        },
      };
      hookRegistry.register(afterHook);

      const handler = createTestHandler(async () => {
        order.push('handler');
      });

      const block = createTestBlock('b1', 'test::');
      const store = createTestStore({ b1: block });
      const actions = createTestActions();

      await executeHandler(handler, 'b1', 'test::', actions, store);

      expect(order).toEqual(['handler', 'after-hook']);
    });

    it('runs execute:after hooks even when handler throws', async () => {
      const afterCalled = vi.fn();

      const afterHook: Hook = {
        id: 'test-after',
        event: 'execute:after',
        filter: () => true,
        priority: 0,
        handler: (ctx) => {
          afterCalled(ctx.error);
          return {};
        },
      };
      hookRegistry.register(afterHook);

      const handler = createTestHandler(async () => {
        throw new Error('Handler failed');
      });

      const block = createTestBlock('b1', 'test::');
      const store = createTestStore({ b1: block });
      const actions = createTestActions();

      await expect(
        executeHandler(handler, 'b1', 'test::', actions, store)
      ).rejects.toThrow('Handler failed');

      expect(afterCalled).toHaveBeenCalledWith('Error: Handler failed');
    });

    it('does not run execute:after when execution aborted', async () => {
      const afterCalled = vi.fn();

      hookRegistry.register({
        id: 'abort-hook',
        event: 'execute:before',
        filter: () => true,
        priority: 0,
        handler: () => ({ abort: true, reason: 'test' }),
      });

      hookRegistry.register({
        id: 'after-hook',
        event: 'execute:after',
        filter: () => true,
        priority: 0,
        handler: () => {
          afterCalled();
          return {};
        },
      });

      const handler = createTestHandler();
      const block = createTestBlock('b1', 'test::');
      const store = createTestStore({ b1: block });
      const actions = createTestActions();

      await executeHandler(handler, 'b1', 'test::', actions, store);

      expect(afterCalled).not.toHaveBeenCalled();
    });
  });

  describe('error isolation', () => {
    it('continues execution when execute:before hook throws', async () => {
      mockLogger.error.mockClear();

      hookRegistry.register({
        id: 'throwing-hook',
        event: 'execute:before',
        filter: () => true,
        priority: 0,
        handler: () => {
          throw new Error('Hook exploded');
        },
      });

      const handler = createTestHandler();
      const block = createTestBlock('b1', 'test::');
      const store = createTestStore({ b1: block });
      const actions = createTestActions();

      await executeHandler(handler, 'b1', 'test::', actions, store);

      // Handler should still execute despite hook failure
      expect(handler.execute).toHaveBeenCalled();
      expect(mockLogger.error).toHaveBeenCalled();
    });

    it('does not throw when execute:after hook throws', async () => {
      mockLogger.error.mockClear();

      hookRegistry.register({
        id: 'throwing-after',
        event: 'execute:after',
        filter: () => true,
        priority: 0,
        handler: () => {
          throw new Error('After hook exploded');
        },
      });

      const handler = createTestHandler();
      const block = createTestBlock('b1', 'test::');
      const store = createTestStore({ b1: block });
      const actions = createTestActions();

      // Should not throw
      await expect(
        executeHandler(handler, 'b1', 'test::', actions, store)
      ).resolves.not.toThrow();

      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  describe('full lifecycle', () => {
    it('runs complete before → handler → after flow', async () => {
      const order: string[] = [];

      hookRegistry.register({
        id: 'before',
        event: 'execute:before',
        filter: () => true,
        priority: 0,
        handler: () => {
          order.push('before');
          return { context: { injected: true } };
        },
      });

      hookRegistry.register({
        id: 'after',
        event: 'execute:after',
        filter: () => true,
        priority: 0,
        handler: () => {
          order.push('after');
          return {};
        },
      });

      const handler = createTestHandler(async () => {
        order.push('execute');
      });

      const block = createTestBlock('b1', 'test::');
      const store = createTestStore({ b1: block });
      const actions = createTestActions();

      await executeHandler(handler, 'b1', 'test::', actions, store);

      expect(order).toEqual(['before', 'execute', 'after']);
    });
  });
});

describe('createHookBlockStore', () => {
  it('creates adapter from loose interface', () => {
    const blocks = {
      b1: createTestBlock('b1', 'hello'),
    };

    const store = createHookBlockStore(
      (id: string) => blocks[id],
      blocks,
      ['b1']
    );

    expect(store.getBlock('b1')).toEqual(blocks.b1);
    expect(store.blocks).toEqual(blocks);
    expect(store.rootIds).toEqual(['b1']);
  });
});
