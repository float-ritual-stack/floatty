/**
 * Provider Detection Hook Tests
 *
 * Tests for the execute:before hook that detects AI provider configuration.
 *
 * @see FLO-187 Provider-Aware Dispatch System
 */

import { describe, it, expect } from 'vitest';
import { providerDetectionHook, type ProviderHookContext } from './providerDetectionHook';
import type { HookBlockStore } from '../../hooks/types';
import type { Block } from '../../blockTypes';

// ═══════════════════════════════════════════════════════════════
// TEST HELPERS
// ═══════════════════════════════════════════════════════════════

function createBlock(partial: Partial<Block>): Block {
  return {
    id: partial.id ?? 'test',
    parentId: partial.parentId ?? null,
    childIds: partial.childIds ?? [],
    content: partial.content ?? '',
    type: 'text',
    collapsed: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...partial,
  };
}

function createMockStore(blocks: Record<string, Partial<Block>>, rootIds?: string[]): HookBlockStore {
  const fullBlocks: Record<string, Block> = {};

  for (const [id, partial] of Object.entries(blocks)) {
    fullBlocks[id] = createBlock({ id, ...partial });
  }

  return {
    getBlock: (id: string) => fullBlocks[id],
    blocks: fullBlocks,
    rootIds: rootIds ?? Object.keys(blocks).filter(id => !fullBlocks[id].parentId),
  };
}

// ═══════════════════════════════════════════════════════════════
// FILTER TESTS
// ═══════════════════════════════════════════════════════════════

describe('providerDetectionHook filter', () => {
  it('matches /send command', () => {
    const block = createBlock({ content: '/send' });
    expect(providerDetectionHook.filter(block)).toBe(true);
  });

  it('matches ::send command', () => {
    const block = createBlock({ content: '::send' });
    expect(providerDetectionHook.filter(block)).toBe(true);
  });

  it('matches /send with whitespace', () => {
    const block = createBlock({ content: '  /send  ' });
    expect(providerDetectionHook.filter(block)).toBe(true);
  });

  it('does not match other commands', () => {
    const block = createBlock({ content: '/help' });
    expect(providerDetectionHook.filter(block)).toBe(false);
  });

  it('does not match ai:: blocks', () => {
    const block = createBlock({ content: 'ai::kitty' });
    expect(providerDetectionHook.filter(block)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// HANDLER TESTS
// ═══════════════════════════════════════════════════════════════

describe('providerDetectionHook handler', () => {
  it('detects ai::kitty provider from ancestor', () => {
    const store = createMockStore({
      root: { content: 'ai::kitty float-hub', childIds: ['user1'] },
      user1: { content: '## user', parentId: 'root', childIds: ['msg'] },
      msg: { content: 'hello', parentId: 'user1', childIds: ['send'] },
      send: { content: '/send', parentId: 'msg' },
    });

    const result = providerDetectionHook.handler({
      block: store.getBlock('send')!,
      content: '/send',
      event: 'execute:before',
      store,
    });

    expect(result.context).toBeDefined();
    const ctx = result.context as ProviderHookContext;
    expect(ctx.provider.name).toBe('kitty');
    expect(ctx.provider).toHaveProperty('workingDir', 'float-hub');
  });

  it('detects ai::ollama with model override', () => {
    const store = createMockStore({
      root: { content: 'ai::ollama qwen2.5:7b', childIds: ['send'] },
      send: { content: '/send', parentId: 'root' },
    });

    const result = providerDetectionHook.handler({
      block: store.getBlock('send')!,
      content: '/send',
      event: 'execute:before',
      store,
    });

    const ctx = result.context as ProviderHookContext;
    expect(ctx.provider.name).toBe('ollama');
    expect(ctx.provider).toHaveProperty('model', 'qwen2.5:7b');
    expect(ctx.modelOverride).toBe('qwen2.5:7b');
  });

  it('defaults to Ollama when no provider found', () => {
    const store = createMockStore({
      send: { content: '/send' },
    });

    const result = providerDetectionHook.handler({
      block: store.getBlock('send')!,
      content: '/send',
      event: 'execute:before',
      store,
    });

    const ctx = result.context as ProviderHookContext;
    expect(ctx.provider.name).toBe('ollama');
    expect(ctx.provider.blockId).toBe(''); // No provider block
  });

  it('ignores non-ai:: prefixes (collision avoidance)', () => {
    const store = createMockStore({
      kitty: { content: 'kitty::persona marker', childIds: ['send'] },
      send: { content: '/send', parentId: 'kitty' },
    });

    const result = providerDetectionHook.handler({
      block: store.getBlock('send')!,
      content: '/send',
      event: 'execute:before',
      store,
    });

    // kitty:: without ai:: prefix is NOT a provider
    const ctx = result.context as ProviderHookContext;
    expect(ctx.provider.name).toBe('ollama'); // Falls back to default
  });

  it('finds session ID from provider children', () => {
    const store = createMockStore({
      provider: { content: 'ai::kitty', childIds: ['session', 'user'] },
      session: { content: 'session: abc123-uuid', parentId: 'provider' },
      user: { content: '## user', parentId: 'provider', childIds: ['send'] },
      send: { content: '/send', parentId: 'user' },
    });

    const result = providerDetectionHook.handler({
      block: store.getBlock('send')!,
      content: '/send',
      event: 'execute:before',
      store,
    });

    const ctx = result.context as ProviderHookContext;
    expect(ctx.provider.name).toBe('kitty');
    expect(ctx.sessionId).toBe('abc123-uuid');
    // Session should also be injected into provider for CLI providers
    expect(ctx.provider).toHaveProperty('sessionId', 'abc123-uuid');
  });

  it('prefers model override from child block', () => {
    const store = createMockStore({
      provider: { content: 'ai::ollama qwen2.5:7b', childIds: ['model', 'send'] },
      model: { content: 'model:: llama3:70b', parentId: 'provider' },
      send: { content: '/send', parentId: 'provider' },
    });

    const result = providerDetectionHook.handler({
      block: store.getBlock('send')!,
      content: '/send',
      event: 'execute:before',
      store,
    });

    const ctx = result.context as ProviderHookContext;
    // Should prefer model:: override over provider config
    expect(ctx.modelOverride).toBe('llama3:70b');
  });

  it('uses provider model when no override', () => {
    const store = createMockStore({
      provider: { content: 'ai::ollama qwen2.5:7b', childIds: ['send'] },
      send: { content: '/send', parentId: 'provider' },
    });

    const result = providerDetectionHook.handler({
      block: store.getBlock('send')!,
      content: '/send',
      event: 'execute:before',
      store,
    });

    const ctx = result.context as ProviderHookContext;
    expect(ctx.modelOverride).toBe('qwen2.5:7b');
  });

  it('detects ai::anthropic provider', () => {
    const store = createMockStore({
      provider: { content: 'ai::anthropic claude-3-opus', childIds: ['send'] },
      send: { content: '/send', parentId: 'provider' },
    });

    const result = providerDetectionHook.handler({
      block: store.getBlock('send')!,
      content: '/send',
      event: 'execute:before',
      store,
    });

    const ctx = result.context as ProviderHookContext;
    expect(ctx.provider.name).toBe('anthropic');
    expect(ctx.provider).toHaveProperty('model', 'claude-3-opus');
  });
});

// ═══════════════════════════════════════════════════════════════
// PRIORITY TESTS
// ═══════════════════════════════════════════════════════════════

describe('providerDetectionHook priority', () => {
  it('has priority -1 to run before sendContextHook (priority 0)', () => {
    expect(providerDetectionHook.priority).toBe(-1);
    // sendContextHook has priority 0, so providerDetectionHook runs first
    // This ensures provider info is available when sendContextHook runs
  });
});
