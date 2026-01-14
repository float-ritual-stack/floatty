/**
 * HookRegistry unit tests
 *
 * Tests hook system aligned with FLOATTY_HOOK_SYSTEM.md.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HookRegistry } from './hookRegistry';
import { HookFilters } from './types';
import type { Hook, HookContext } from './types';

// Test helpers
function createTestBlock(overrides: Record<string, unknown> = {}) {
  return {
    id: 'test-block',
    parentId: null,
    childIds: [],
    content: 'test content',
    type: 'text' as const,
    collapsed: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function createTestContext(overrides: Partial<HookContext> = {}): HookContext {
  return {
    block: createTestBlock(),
    content: 'test content',
    event: 'block:create',
    store: {
      getBlock: () => undefined,
      rootIds: [],
      blocks: {},
    },
    ...overrides,
  };
}

function createTestHook(overrides: Partial<Hook> = {}): Hook {
  return {
    id: `hook-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    event: 'block:create',
    filter: () => true,
    priority: 50,
    handler: () => ({}),
    ...overrides,
  };
}

describe('HookRegistry', () => {
  let registry: HookRegistry;

  beforeEach(() => {
    registry = new HookRegistry();
  });

  describe('register', () => {
    it('registers a hook', () => {
      const hook = createTestHook({ id: 'test-hook' });

      registry.register(hook);

      expect(registry.getHookIds()).toContain('test-hook');
    });

    it('throws on duplicate ID', () => {
      const hook = createTestHook({ id: 'duplicate' });

      registry.register(hook);

      expect(() => registry.register(hook)).toThrow('already registered');
    });

    it('registers hook for multiple events', () => {
      const hook = createTestHook({
        id: 'multi-event',
        event: ['block:create', 'block:update'],
      });

      registry.register(hook);

      expect(registry.hasHooks('block:create')).toBe(true);
      expect(registry.hasHooks('block:update')).toBe(true);
    });
  });

  describe('unregister', () => {
    it('removes hook and returns true', () => {
      const hook = createTestHook({ id: 'to-remove' });
      registry.register(hook);

      const result = registry.unregister('to-remove');

      expect(result).toBe(true);
      expect(registry.getHookIds()).not.toContain('to-remove');
    });

    it('returns false for unknown ID', () => {
      const result = registry.unregister('unknown');
      expect(result).toBe(false);
    });

    it('removes from event index', () => {
      const hook = createTestHook({ id: 'indexed', event: 'block:create' });
      registry.register(hook);

      expect(registry.hasHooks('block:create')).toBe(true);

      registry.unregister('indexed');

      expect(registry.hasHooks('block:create')).toBe(false);
    });
  });

  describe('run', () => {
    it('calls matching hooks', async () => {
      const handler = vi.fn().mockReturnValue({});
      registry.register(createTestHook({ handler }));

      await registry.run('block:create', createTestContext());

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('passes context to handler', async () => {
      const handler = vi.fn().mockReturnValue({});
      registry.register(createTestHook({ handler }));

      const ctx = createTestContext({ content: 'specific content' });
      await registry.run('block:create', ctx);

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ content: 'specific content' })
      );
    });

    it('skips hooks for non-matching events', async () => {
      const handler = vi.fn().mockReturnValue({});
      registry.register(createTestHook({ event: 'block:delete', handler }));

      await registry.run('block:create', createTestContext());

      expect(handler).not.toHaveBeenCalled();
    });

    it('skips hooks when filter returns false', async () => {
      const handler = vi.fn().mockReturnValue({});
      registry.register(
        createTestHook({
          filter: () => false,
          handler,
        })
      );

      await registry.run('block:create', createTestContext());

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('priority ordering', () => {
    it('runs hooks in priority order (lower first)', async () => {
      const order: number[] = [];

      registry.register(
        createTestHook({
          id: 'last',
          priority: 100,
          handler: () => {
            order.push(3);
            return {};
          },
        })
      );

      registry.register(
        createTestHook({
          id: 'first',
          priority: -10,
          handler: () => {
            order.push(1);
            return {};
          },
        })
      );

      registry.register(
        createTestHook({
          id: 'middle',
          priority: 50,
          handler: () => {
            order.push(2);
            return {};
          },
        })
      );

      await registry.run('block:create', createTestContext());

      expect(order).toEqual([1, 2, 3]);
    });
  });

  describe('result accumulation', () => {
    it('accumulates context from multiple hooks', async () => {
      registry.register(
        createTestHook({
          id: 'hook1',
          priority: 0,
          handler: () => ({ context: { a: 1 } }),
        })
      );

      registry.register(
        createTestHook({
          id: 'hook2',
          priority: 50,
          handler: () => ({ context: { b: 2 } }),
        })
      );

      const result = await registry.run('block:create', createTestContext());

      expect(result.context).toEqual({ a: 1, b: 2 });
    });

    it('chains content modifications', async () => {
      registry.register(
        createTestHook({
          id: 'hook1',
          priority: 0,
          handler: (ctx) => ({ content: ctx.content + ' modified1' }),
        })
      );

      registry.register(
        createTestHook({
          id: 'hook2',
          priority: 50,
          handler: (ctx) => ({ content: ctx.content + ' modified2' }),
        })
      );

      const result = await registry.run(
        'block:create',
        createTestContext({ content: 'original' })
      );

      expect(result.content).toBe('original modified1 modified2');
    });
  });

  describe('abort handling', () => {
    it('stops execution on abort', async () => {
      const handler2 = vi.fn().mockReturnValue({});

      registry.register(
        createTestHook({
          id: 'aborter',
          priority: 0,
          handler: () => ({ abort: true, reason: 'Blocked' }),
        })
      );

      registry.register(
        createTestHook({
          id: 'never-called',
          priority: 50,
          handler: handler2,
        })
      );

      const result = await registry.run('block:create', createTestContext());

      expect(result.abort).toBe(true);
      expect(result.reason).toBe('Blocked');
      expect(handler2).not.toHaveBeenCalled();
    });

    it('preserves content modifications before abort', async () => {
      registry.register(
        createTestHook({
          id: 'modifier',
          priority: 0,
          handler: (ctx) => ({ content: ctx.content + ' modified' }),
        })
      );

      registry.register(
        createTestHook({
          id: 'aborter',
          priority: 50,
          handler: () => ({ abort: true }),
        })
      );

      const result = await registry.run(
        'block:create',
        createTestContext({ content: 'original' })
      );

      expect(result.abort).toBe(true);
      expect(result.content).toBe('original modified');
    });
  });

  describe('async hooks', () => {
    it('awaits async handlers', async () => {
      let resolved = false;

      registry.register(
        createTestHook({
          handler: async () => {
            await new Promise((r) => setTimeout(r, 10));
            resolved = true;
            return {};
          },
        })
      );

      await registry.run('block:create', createTestContext());

      expect(resolved).toBe(true);
    });
  });

  describe('error isolation', () => {
    it('continues after hook throws', async () => {
      const handler2 = vi.fn().mockReturnValue({});

      registry.register(
        createTestHook({
          id: 'thrower',
          priority: 0,
          handler: () => {
            throw new Error('Hook failed');
          },
        })
      );

      registry.register(
        createTestHook({
          id: 'survivor',
          priority: 50,
          handler: handler2,
        })
      );

      // Should not throw
      await expect(
        registry.run('block:create', createTestContext())
      ).resolves.toBeDefined();

      expect(handler2).toHaveBeenCalled();
    });

    it('logs error when hook throws', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      registry.register(
        createTestHook({
          id: 'thrower',
          handler: () => {
            throw new Error('Test error');
          },
        })
      );

      await registry.run('block:create', createTestContext());

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[HookRegistry]'),
        expect.any(Error)
      );

      consoleSpy.mockRestore();
    });
  });

  describe('runSync', () => {
    it('runs hooks synchronously', () => {
      const handler = vi.fn().mockReturnValue({ context: { sync: true } });
      registry.register(createTestHook({ handler }));

      const result = registry.runSync('block:create', createTestContext());

      expect(handler).toHaveBeenCalled();
      expect(result.context).toEqual({ sync: true });
    });

    it('warns for async hooks in sync context', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      registry.register(
        createTestHook({
          id: 'async-hook',
          handler: async () => ({ context: { ignored: true } }),
        })
      );

      registry.runSync('block:create', createTestContext());

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Async hook')
      );

      consoleSpy.mockRestore();
    });
  });

  describe('hasHooks', () => {
    it('returns true when hooks exist for event', () => {
      registry.register(createTestHook({ event: 'block:update' }));

      expect(registry.hasHooks('block:update')).toBe(true);
      expect(registry.hasHooks('block:delete')).toBe(false);
    });
  });

  describe('getHooksForEvent', () => {
    it('returns hook info for event', () => {
      registry.register(createTestHook({ id: 'h1', event: 'block:create', priority: 10 }));
      registry.register(createTestHook({ id: 'h2', event: 'block:create', priority: 20 }));

      const hooks = registry.getHooksForEvent('block:create');

      expect(hooks).toHaveLength(2);
      expect(hooks[0]).toEqual({ id: 'h1', priority: 10 });
      expect(hooks[1]).toEqual({ id: 'h2', priority: 20 });
    });
  });

  describe('clear', () => {
    it('removes all hooks', () => {
      registry.register(createTestHook({ id: 'h1' }));
      registry.register(createTestHook({ id: 'h2' }));

      expect(registry.getHookIds()).toHaveLength(2);

      registry.clear();

      expect(registry.getHookIds()).toHaveLength(0);
    });
  });

  describe('HookFilters integration', () => {
    it('filters by block type', async () => {
      const handler = vi.fn().mockReturnValue({});

      registry.register(
        createTestHook({
          filter: HookFilters.byType('sh'),
          handler,
        })
      );

      // Should not match text block
      await registry.run(
        'block:create',
        createTestContext({ block: createTestBlock({ type: 'text' }) })
      );
      expect(handler).not.toHaveBeenCalled();

      // Should match sh block
      await registry.run(
        'block:create',
        createTestContext({ block: createTestBlock({ type: 'sh' }) })
      );
      expect(handler).toHaveBeenCalled();
    });

    it('filters by content prefix', async () => {
      const handler = vi.fn().mockReturnValue({});

      registry.register(
        createTestHook({
          filter: HookFilters.byPrefix('ai::'),
          handler,
        })
      );

      // Should not match
      await registry.run(
        'block:create',
        createTestContext({ block: createTestBlock({ content: 'regular text' }) })
      );
      expect(handler).not.toHaveBeenCalled();

      // Should match
      await registry.run(
        'block:create',
        createTestContext({ block: createTestBlock({ content: 'ai:: prompt here' }) })
      );
      expect(handler).toHaveBeenCalled();
    });

    it('filters for wikilinks', async () => {
      const handler = vi.fn().mockReturnValue({});

      registry.register(
        createTestHook({
          filter: HookFilters.hasWikilinks(),
          handler,
        })
      );

      // Should not match
      await registry.run(
        'block:create',
        createTestContext({ block: createTestBlock({ content: 'no links' }) })
      );
      expect(handler).not.toHaveBeenCalled();

      // Should match
      await registry.run(
        'block:create',
        createTestContext({ block: createTestBlock({ content: 'has [[wikilink]]' }) })
      );
      expect(handler).toHaveBeenCalled();
    });
  });
});
