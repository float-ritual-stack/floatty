/**
 * sendContextHook unit tests
 *
 * Tests multi-turn conversation context assembly.
 * The hook walks ## user / ## assistant markers and builds messages array.
 */
import { describe, it, expect } from 'vitest';
import { sendContextHook } from './sendContextHook';
import type { Block } from '../../blockTypes';
import type { HookContext } from '../../hooks/types';

// ═══════════════════════════════════════════════════════════════
// TEST HELPERS
// ═══════════════════════════════════════════════════════════════

function createBlock(id: string, content: string, childIds: string[] = []): Block {
  return {
    id,
    parentId: null,
    childIds,
    content,
    type: 'text',
    collapsed: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

interface MockStore {
  blocks: Record<string, Block>;
  rootIds: string[];
  getBlock: (id: string) => Block | undefined;
}

function createMockStore(blocks: Block[], rootIds: string[]): MockStore {
  const blockMap: Record<string, Block> = {};
  for (const b of blocks) {
    blockMap[b.id] = b;
  }
  return {
    blocks: blockMap,
    rootIds,
    getBlock: (id: string) => blockMap[id],
  };
}

function createHookContext(
  block: Block,
  store: MockStore
): HookContext {
  return {
    block,
    content: block.content,
    event: 'execute:before',
    store,
  };
}

// ═══════════════════════════════════════════════════════════════
// FILTER TESTS
// ═══════════════════════════════════════════════════════════════

describe('sendContextHook filter', () => {
  it('matches /send', () => {
    const block = createBlock('send', '/send');
    expect(sendContextHook.filter!(block, {} as HookContext)).toBe(true);
  });

  it('matches ::send', () => {
    const block = createBlock('send', '::send');
    expect(sendContextHook.filter!(block, {} as HookContext)).toBe(true);
  });

  it('matches case-insensitive', () => {
    const block = createBlock('send', '/SEND');
    expect(sendContextHook.filter!(block, {} as HookContext)).toBe(true);
  });

  it('ignores other content', () => {
    const block = createBlock('other', 'hello world');
    expect(sendContextHook.filter!(block, {} as HookContext)).toBe(false);
  });

  it('ignores sh:: blocks', () => {
    const block = createBlock('sh', 'sh:: ls -la');
    expect(sendContextHook.filter!(block, {} as HookContext)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// SINGLE TURN TESTS
// ═══════════════════════════════════════════════════════════════

describe('sendContextHook single turn', () => {
  it('collects content from ## user to /send', () => {
    const blocks = [
      createBlock('user', '## user'),
      createBlock('thought', 'my thought'),
      createBlock('send', '/send'),
    ];
    const store = createMockStore(blocks, ['user', 'thought', 'send']);
    const ctx = createHookContext(blocks[2], store);

    const result = sendContextHook.handler(ctx);

    expect(result.abort).toBeUndefined();
    expect(result.context?.messages).toHaveLength(1);
    expect(result.context?.messages[0]).toEqual({
      role: 'user',
      content: 'my thought',
    });
  });

  it('accumulates multiple blocks under ## user', () => {
    const blocks = [
      createBlock('user', '## user'),
      createBlock('t1', 'first thought'),
      createBlock('t2', 'second thought'),
      createBlock('t3', 'third thought'),
      createBlock('send', '/send'),
    ];
    const store = createMockStore(blocks, ['user', 't1', 't2', 't3', 'send']);
    const ctx = createHookContext(blocks[4], store);

    const result = sendContextHook.handler(ctx);

    expect(result.context?.messages).toHaveLength(1);
    expect(result.context?.messages[0].content).toBe(
      'first thought\nsecond thought\nthird thought'
    );
  });

  it('excludes ## user marker from content', () => {
    const blocks = [
      createBlock('user', '## user'),
      createBlock('thought', 'my thought'),
      createBlock('send', '/send'),
    ];
    const store = createMockStore(blocks, ['user', 'thought', 'send']);
    const ctx = createHookContext(blocks[2], store);

    const result = sendContextHook.handler(ctx);

    expect(result.context?.messages[0].content).not.toContain('## user');
  });
});

// ═══════════════════════════════════════════════════════════════
// MULTI-TURN TESTS
// ═══════════════════════════════════════════════════════════════

describe('sendContextHook multi-turn', () => {
  it('builds 2-turn conversation (user → assistant → user)', () => {
    const blocks = [
      createBlock('u1', '## user'),
      createBlock('t1', 'my name is evan'),
      createBlock('a1', '## assistant'),
      createBlock('r1', 'Hello Evan!'),
      createBlock('u2', '## user'),
      createBlock('t2', 'what is my name'),
      createBlock('send', '/send'),
    ];
    const store = createMockStore(
      blocks,
      ['u1', 't1', 'a1', 'r1', 'u2', 't2', 'send']
    );
    const ctx = createHookContext(blocks[6], store);

    const result = sendContextHook.handler(ctx);

    expect(result.context?.messages).toHaveLength(3);
    expect(result.context?.messages[0]).toEqual({
      role: 'user',
      content: 'my name is evan',
    });
    expect(result.context?.messages[1]).toEqual({
      role: 'assistant',
      content: 'Hello Evan!',
    });
    expect(result.context?.messages[2]).toEqual({
      role: 'user',
      content: 'what is my name',
    });
  });

  it('builds 3-turn conversation', () => {
    const blocks = [
      createBlock('u1', '## user'),
      createBlock('t1', 'first question'),
      createBlock('a1', '## assistant'),
      createBlock('r1', 'first answer'),
      createBlock('u2', '## user'),
      createBlock('t2', 'second question'),
      createBlock('a2', '## assistant'),
      createBlock('r2', 'second answer'),
      createBlock('u3', '## user'),
      createBlock('t3', 'third question'),
      createBlock('send', '/send'),
    ];
    const store = createMockStore(
      blocks,
      ['u1', 't1', 'a1', 'r1', 'u2', 't2', 'a2', 'r2', 'u3', 't3', 'send']
    );
    const ctx = createHookContext(blocks[10], store);

    const result = sendContextHook.handler(ctx);

    expect(result.context?.messages).toHaveLength(5);
    expect(result.context?.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
    ]);
  });

  it('excludes ## assistant marker from content', () => {
    const blocks = [
      createBlock('u1', '## user'),
      createBlock('t1', 'question'),
      createBlock('a1', '## assistant'),
      createBlock('r1', 'answer'),
      createBlock('u2', '## user'),
      createBlock('t2', 'follow up'),
      createBlock('send', '/send'),
    ];
    const store = createMockStore(
      blocks,
      ['u1', 't1', 'a1', 'r1', 'u2', 't2', 'send']
    );
    const ctx = createHookContext(blocks[6], store);

    const result = sendContextHook.handler(ctx);

    for (const msg of result.context?.messages ?? []) {
      expect(msg.content).not.toContain('## assistant');
      expect(msg.content).not.toContain('## user');
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// IMPLICIT FIRST TURN TESTS
// ═══════════════════════════════════════════════════════════════

describe('sendContextHook implicit first turn', () => {
  it('treats content before any marker as user turn', () => {
    const blocks = [
      createBlock('thought', 'some thought without marker'),
      createBlock('send', '/send'),
    ];
    const store = createMockStore(blocks, ['thought', 'send']);
    const ctx = createHookContext(blocks[1], store);

    const result = sendContextHook.handler(ctx);

    expect(result.context?.messages).toHaveLength(1);
    expect(result.context?.messages[0]).toEqual({
      role: 'user',
      content: 'some thought without marker',
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// ABORT TESTS
// ═══════════════════════════════════════════════════════════════

describe('sendContextHook abort conditions', () => {
  it('aborts when no content to send', () => {
    const blocks = [
      createBlock('user', '## user'),
      createBlock('send', '/send'),
    ];
    const store = createMockStore(blocks, ['user', 'send']);
    const ctx = createHookContext(blocks[1], store);

    const result = sendContextHook.handler(ctx);

    expect(result.abort).toBe(true);
    expect(result.reason).toBe('No content to send');
  });

  it('aborts when block not found in tree', () => {
    const blocks = [
      createBlock('user', '## user'),
      createBlock('thought', 'content'),
    ];
    const store = createMockStore(blocks, ['user', 'thought']);
    // Create context with a block not in rootIds
    const orphan = createBlock('orphan', '/send');
    const ctx = createHookContext(orphan, store);

    const result = sendContextHook.handler(ctx);

    expect(result.abort).toBe(true);
    expect(result.reason).toBe('Block not found in tree');
  });

  it('aborts when last message is not user', () => {
    // Edge case: ## assistant without following ## user
    const blocks = [
      createBlock('u1', '## user'),
      createBlock('t1', 'question'),
      createBlock('a1', '## assistant'),
      createBlock('r1', 'answer'),
      createBlock('send', '/send'),
    ];
    const store = createMockStore(blocks, ['u1', 't1', 'a1', 'r1', 'send']);
    const ctx = createHookContext(blocks[4], store);

    const result = sendContextHook.handler(ctx);

    expect(result.abort).toBe(true);
    expect(result.reason).toBe('No user content to send');
  });
});

// ═══════════════════════════════════════════════════════════════
// NESTED STRUCTURE TESTS
// ═══════════════════════════════════════════════════════════════

describe('sendContextHook with nested blocks', () => {
  it('walks children in document order', () => {
    // Tree structure:
    // - user
    //   - thought1
    //   - thought2
    // - send
    const thought1 = createBlock('t1', 'thought 1');
    const thought2 = createBlock('t2', 'thought 2');
    const user = createBlock('user', '## user', ['t1', 't2']);
    const send = createBlock('send', '/send');

    const blocks = [user, thought1, thought2, send];
    const store = createMockStore(blocks, ['user', 'send']);
    const ctx = createHookContext(send, store);

    const result = sendContextHook.handler(ctx);

    expect(result.context?.messages).toHaveLength(1);
    expect(result.context?.messages[0].content).toBe('thought 1\nthought 2');
  });
});

// ═══════════════════════════════════════════════════════════════
// ZOOM SCOPING TESTS
// ═══════════════════════════════════════════════════════════════

describe('sendContextHook zoom scoping', () => {
  it('scopes to zoomed subtree when zoomedRootId is set', () => {
    // Document structure:
    // - old-convo (outside zoom scope)
    //   - ## user
    //   - old question
    //   - ## assistant
    //   - old answer
    // - new-convo (zoomed root - has ## user so it starts fresh)
    //   - new question
    //   - /send
    const oldUser = createBlock('old-user', '## user');
    const oldQ = createBlock('old-q', 'old question');
    const oldAsst = createBlock('old-asst', '## assistant');
    const oldA = createBlock('old-a', 'old answer');
    const oldConvo = createBlock('old-convo', 'old conversation', ['old-user', 'old-q', 'old-asst', 'old-a']);

    // New convo starts with ## user marker so previous context is cleared
    const newQ = createBlock('new-q', 'new question');
    const send = createBlock('send', '/send');
    const newConvo = createBlock('new-convo', '## user', ['new-q', 'send']);  // Marker at root

    const blocks = [oldConvo, oldUser, oldQ, oldAsst, oldA, newConvo, newQ, send];
    const store = {
      ...createMockStore(blocks, ['old-convo', 'new-convo']),
      zoomedRootId: 'new-convo',  // Zoomed into new conversation
    };
    const ctx = createHookContext(send, store);

    const result = sendContextHook.handler(ctx);

    // Should only see the new conversation, not old
    expect(result.context?.messages).toHaveLength(1);
    expect(result.context?.messages[0]).toEqual({
      role: 'user',
      content: 'new question',
    });
  });

  it('sees full document when not zoomed', () => {
    // Same structure, but no zoom
    const user1 = createBlock('u1', '## user');
    const q1 = createBlock('q1', 'first question');
    const user2 = createBlock('u2', '## user');
    const q2 = createBlock('q2', 'second question');
    const send = createBlock('send', '/send');

    const blocks = [user1, q1, user2, q2, send];
    const store = createMockStore(blocks, ['u1', 'q1', 'u2', 'q2', 'send']);
    // No zoomedRootId - full document
    const ctx = createHookContext(send, store);

    const result = sendContextHook.handler(ctx);

    // Should see both turns (latest user turn is q2)
    expect(result.context?.messages).toHaveLength(2);
    expect(result.context?.messages[0].content).toBe('first question');
    expect(result.context?.messages[1].content).toBe('second question');
  });

  it('aborts when /send is outside zoomed subtree', () => {
    // /send is in different subtree than zoom
    const zoomed = createBlock('zoomed', 'zoomed content');
    const send = createBlock('send', '/send');

    const blocks = [zoomed, send];
    const store = {
      ...createMockStore(blocks, ['zoomed', 'send']),
      zoomedRootId: 'zoomed',  // Zoomed to different subtree
    };
    const ctx = createHookContext(send, store);

    const result = sendContextHook.handler(ctx);

    expect(result.abort).toBe(true);
    expect(result.reason).toBe('Block not found in tree');
  });
});
