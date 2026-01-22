/**
 * Tree Traversal Tests
 *
 * Tests for provider detection and inherited context gathering.
 * Config-driven: Tests verify provider name extraction, not type mapping.
 *
 * @see FLO-187 Provider-Aware Dispatch System
 */

import { describe, it, expect } from 'vitest';
import {
  parseProviderConfig,
  traverseUpForProvider,
  findSessionId,
  findModelOverride,
  buildInheritedContext,
  getAncestors,
  type TraversalStore,
} from './treeTraversal';
import type { Block } from './blockTypes';

// ═══════════════════════════════════════════════════════════════
// TEST HELPERS
// ═══════════════════════════════════════════════════════════════

function createMockStore(blocks: Record<string, Partial<Block>>, rootIds: string[] = []): TraversalStore {
  const fullBlocks: Record<string, Block> = {};

  for (const [id, partial] of Object.entries(blocks)) {
    fullBlocks[id] = {
      id,
      parentId: null,
      childIds: [],
      content: '',
      type: 'text',
      collapsed: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...partial,
    };
  }

  return {
    getBlock: (id: string) => fullBlocks[id],
    rootIds: rootIds.length > 0 ? rootIds : Object.keys(blocks).filter(id => !fullBlocks[id].parentId),
  };
}

// ═══════════════════════════════════════════════════════════════
// PROVIDER PARSING (Config-driven)
// ═══════════════════════════════════════════════════════════════

describe('parseProviderConfig', () => {
  it('returns null for non-ai:: content', () => {
    expect(parseProviderConfig('some text', 'block1')).toBeNull();
    expect(parseProviderConfig('kitty:: persona marker', 'block1')).toBeNull();
    expect(parseProviderConfig('claude:: https://claude.ai/chat', 'block1')).toBeNull();
    expect(parseProviderConfig('sh:: ls -la', 'block1')).toBeNull();
  });

  it('parses bare ai:: as default provider (ollama)', () => {
    const result = parseProviderConfig('ai::', 'block1');
    expect(result).toEqual({ name: 'ollama', blockId: 'block1' });
  });

  it('parses ai:: with leading/trailing whitespace', () => {
    const result = parseProviderConfig('  ai::  ', 'block1');
    expect(result).toEqual({ name: 'ollama', blockId: 'block1' });
  });

  it('parses ai::kitty - provider name extracted', () => {
    const result = parseProviderConfig('ai::kitty', 'block1');
    expect(result?.name).toBe('kitty');
    expect(result?.blockId).toBe('block1');
  });

  it('parses ai::kitty with working directory', () => {
    const result = parseProviderConfig('ai::kitty float-hub', 'block1');
    expect(result?.name).toBe('kitty');
    expect(result?.workingDir).toBe('float-hub');
  });

  it('parses ai::ollama - provider name extracted', () => {
    const result = parseProviderConfig('ai::ollama', 'block1');
    expect(result?.name).toBe('ollama');
  });

  it('parses ai::ollama with model', () => {
    const result = parseProviderConfig('ai::ollama qwen2.5:7b', 'block1');
    expect(result?.name).toBe('ollama');
    expect(result?.model).toBe('qwen2.5:7b');
  });

  it('parses ai::gemini - new provider', () => {
    const result = parseProviderConfig('ai::gemini', 'block1');
    expect(result?.name).toBe('gemini');
  });

  it('parses ai::amp - new provider', () => {
    const result = parseProviderConfig('ai::amp', 'block1');
    expect(result?.name).toBe('amp');
  });

  it('parses ai::opencode - new provider', () => {
    const result = parseProviderConfig('ai::opencode', 'block1');
    expect(result?.name).toBe('opencode');
  });

  it('parses ai::cowboy - alternate claude-code persona', () => {
    const result = parseProviderConfig('ai::cowboy', 'block1');
    expect(result?.name).toBe('cowboy');
  });

  it('parses ai::claude - direct Anthropic API', () => {
    const result = parseProviderConfig('ai::claude', 'block1');
    expect(result?.name).toBe('claude');
  });

  it('parses ai::openai - OpenAI API', () => {
    const result = parseProviderConfig('ai::openai gpt-4', 'block1');
    expect(result?.name).toBe('openai');
    expect(result?.model).toBe('gpt-4');
  });

  it('is case-insensitive for provider names', () => {
    const result = parseProviderConfig('AI::Kitty Float-Hub', 'b1');
    expect(result?.name).toBe('kitty'); // Lowercased
    expect(result?.workingDir).toBe('Float-Hub'); // Preserves case in arg
  });
});

// ═══════════════════════════════════════════════════════════════
// PROVIDER DETECTION (TREE TRAVERSAL)
// ═══════════════════════════════════════════════════════════════

describe('traverseUpForProvider', () => {
  it('finds ai::kitty provider from ancestor', () => {
    const store = createMockStore({
      root: { id: 'root', content: 'ai::kitty float-hub', childIds: ['user1'] },
      user1: { id: 'user1', content: '## user', parentId: 'root', childIds: ['msg'] },
      msg: { id: 'msg', content: 'hello', parentId: 'user1', childIds: ['send'] },
      send: { id: 'send', content: '/send', parentId: 'msg' },
    });

    const result = traverseUpForProvider('send', store);

    expect(result.name).toBe('kitty');
    expect(result.workingDir).toBe('float-hub');
  });

  it('finds ai::ollama with model', () => {
    const store = createMockStore({
      root: { id: 'root', content: 'ai::ollama qwen2.5:7b', childIds: ['send'] },
      send: { id: 'send', content: '/send', parentId: 'root' },
    });

    const result = traverseUpForProvider('send', store);

    expect(result.name).toBe('ollama');
    expect(result.model).toBe('qwen2.5:7b');
  });

  it('defaults to ollama when no provider found', () => {
    const store = createMockStore({
      send: { id: 'send', content: '/send' },
    }, ['send']);

    const result = traverseUpForProvider('send', store);

    expect(result.name).toBe('ollama');
    expect(result.blockId).toBe('');
  });

  it('ignores non-ai:: prefixes (collision avoidance)', () => {
    const store = createMockStore({
      kitty: { id: 'kitty', content: 'kitty::persona marker', childIds: ['send'] },
      send: { id: 'send', content: '/send', parentId: 'kitty' },
    });

    // kitty:: without ai:: prefix is NOT a provider
    const result = traverseUpForProvider('send', store);
    expect(result.name).toBe('ollama'); // Falls back to default
    expect(result.blockId).toBe('');
  });

  it('finds nearest provider when multiple exist', () => {
    // Nested providers - should use the nearest one
    const store = createMockStore({
      outer: { id: 'outer', content: 'ai::claude', childIds: ['inner'] },
      inner: { id: 'inner', content: 'ai::kitty', parentId: 'outer', childIds: ['send'] },
      send: { id: 'send', content: '/send', parentId: 'inner' },
    });

    const result = traverseUpForProvider('send', store);

    // Should find inner (ai::kitty) first
    expect(result.name).toBe('kitty');
  });
});

// ═══════════════════════════════════════════════════════════════
// SESSION ID DETECTION
// ═══════════════════════════════════════════════════════════════

describe('findSessionId', () => {
  it('finds session ID from provider children', () => {
    const store = createMockStore({
      provider: { id: 'provider', content: 'ai::kitty', childIds: ['session', 'user'] },
      session: { id: 'session', content: 'session: abc123-uuid', parentId: 'provider' },
      user: { id: 'user', content: '## user', parentId: 'provider' },
    });

    const sessionId = findSessionId('provider', store);
    expect(sessionId).toBe('abc123-uuid');
  });

  it('returns undefined when no session found', () => {
    const store = createMockStore({
      provider: { id: 'provider', content: 'ai::kitty', childIds: ['user'] },
      user: { id: 'user', content: '## user', parentId: 'provider' },
    });

    const sessionId = findSessionId('provider', store);
    expect(sessionId).toBeUndefined();
  });

  it('handles empty session value', () => {
    const store = createMockStore({
      provider: { id: 'provider', content: 'ai::kitty', childIds: ['session'] },
      session: { id: 'session', content: 'session:', parentId: 'provider' },
    });

    const sessionId = findSessionId('provider', store);
    expect(sessionId).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════
// MODEL OVERRIDE DETECTION
// ═══════════════════════════════════════════════════════════════

describe('findModelOverride', () => {
  it('finds model override from provider children', () => {
    const store = createMockStore({
      provider: { id: 'provider', content: 'ai::ollama', childIds: ['model', 'user'] },
      model: { id: 'model', content: 'model:: qwen2.5:14b', parentId: 'provider' },
      user: { id: 'user', content: '## user', parentId: 'provider' },
    });

    const model = findModelOverride('provider', store);
    expect(model).toBe('qwen2.5:14b');
  });

  it('returns undefined when no model override found', () => {
    const store = createMockStore({
      provider: { id: 'provider', content: 'ai::ollama qwen2.5:7b', childIds: ['user'] },
      user: { id: 'user', content: '## user', parentId: 'provider' },
    });

    const model = findModelOverride('provider', store);
    expect(model).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════
// ANCESTORS
// ═══════════════════════════════════════════════════════════════

describe('getAncestors', () => {
  it('returns path from block to root', () => {
    const store = createMockStore({
      root: { id: 'root', content: 'ai::kitty', childIds: ['middle'] },
      middle: { id: 'middle', content: '## user', parentId: 'root', childIds: ['leaf'] },
      leaf: { id: 'leaf', content: 'hello', parentId: 'middle' },
    });

    const ancestors = getAncestors('leaf', store);

    expect(ancestors.map(a => a.id)).toEqual(['leaf', 'middle', 'root']);
    expect(ancestors[0].content).toBe('hello');
    expect(ancestors[2].content).toBe('ai::kitty');
  });
});

// ═══════════════════════════════════════════════════════════════
// INHERITED CONTEXT
// ═══════════════════════════════════════════════════════════════

describe('buildInheritedContext', () => {
  it('builds full context from nested blocks', () => {
    const store = createMockStore({
      provider: { id: 'provider', content: 'ai::kitty float-hub', childIds: ['session', 'user'] },
      session: { id: 'session', content: 'session: sess-123', parentId: 'provider' },
      user: { id: 'user', content: '## user', parentId: 'provider', childIds: ['msg'] },
      msg: { id: 'msg', content: 'test question', parentId: 'user', childIds: ['send'] },
      send: { id: 'send', content: '/send', parentId: 'msg' },
    });

    const ctx = buildInheritedContext('send', store, 'provider');

    expect(ctx.provider?.name).toBe('kitty');
    expect(ctx.provider?.workingDir).toBe('float-hub');
    expect(ctx.sessionId).toBe('sess-123');
    expect(ctx.zoomedRootId).toBe('provider');
    // Ancestors: send -> msg -> user -> provider (session is sibling, not ancestor)
    expect(ctx.ancestors.length).toBe(4);
    expect(ctx.ancestors[0].id).toBe('send');
  });

  it('uses model from provider config when no override', () => {
    const store = createMockStore({
      provider: { id: 'provider', content: 'ai::ollama qwen2.5:7b', childIds: ['send'] },
      send: { id: 'send', content: '/send', parentId: 'provider' },
    });

    const ctx = buildInheritedContext('send', store);

    expect(ctx.model).toBe('qwen2.5:7b');
  });

  it('prefers model override from child block', () => {
    const store = createMockStore({
      provider: { id: 'provider', content: 'ai::ollama qwen2.5:7b', childIds: ['model', 'send'] },
      model: { id: 'model', content: 'model:: llama3:70b', parentId: 'provider' },
      send: { id: 'send', content: '/send', parentId: 'provider' },
    });

    const ctx = buildInheritedContext('send', store);

    expect(ctx.model).toBe('llama3:70b');
  });
});
