# Building Multi-Turn Chat with the Hook System

> A deep-dive tutorial on how Floatty's `/send` command implements multi-turn conversations using the hook architecture, and how to extend it with additional hook-powered features.

**Last Updated**: 2026-01-15

---

## Executive Summary

Floatty's multi-turn chat demonstrates the **hook system working as intended**: clean separation between context assembly (hooks) and execution (handlers). This tutorial walks through the implementation, explains the design decisions, and explores how to enhance chat functionality using additional hooks.

**The Pattern**:
```
Hook assembles context → Handler consumes and executes
```

This separation enables:
- Testable, pure context-building logic
- Reusable hooks across multiple handlers
- Clean abort/validation points
- Extensibility without modifying core handlers

---

## Table of Contents

1. [The /send Command Architecture](#1-the-send-command-architecture)
2. [The Hook System Foundation](#2-the-hook-system-foundation)
3. [How Chat Uses Hooks](#3-how-chat-uses-hooks)
4. [Enhancing Chat with Additional Hooks](#4-enhancing-chat-with-additional-hooks)
5. [Implementation Patterns](#5-implementation-patterns)
6. [Testing Hooks](#6-testing-hooks)

---

## 1. The /send Command Architecture

### Overview

The `/send` command is an explicit trigger for multi-turn LLM conversations. Unlike the `ai::` handler (which autodetects conversation structure), `/send` uses a simple marker-based system:

```markdown
## user
  my name is evan
  I'm working on a project

## assistant
  Hello Evan! What project are you working on?

## user
  a terminal emulator with an outliner

/send
```

### Key Design Decisions

**1. Document-order semantics**: Content is collected by walking the tree top-to-bottom (depth-first). Indentation doesn't affect message boundaries—only the `## user` / `## assistant` markers do.

**2. Zoom scoping**: When zoomed into a subtree, `/send` only sees blocks within that scope. This is the principle: "Zooming into a thing is a way to manage context."

**3. Immediate UX**: The next `## user` block is created and focused BEFORE the LLM responds. Users can start typing their next thought while waiting.

**4. Hook-driven context**: The handler doesn't build context itself—it receives it from `sendContextHook` via `hookContext.messages`.

### Flow Diagram

```
┌──────────────────────────────────────────────────────────────┐
│ User types /send and presses Enter                           │
└──────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────┐
│ Executor builds HookContext:                                  │
│   • block: /send block                                        │
│   • content: "/send"                                          │
│   • store: read-only block access                             │
│   • event: 'execute:before'                                   │
└──────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────┐
│ hookRegistry.run('execute:before', ctx)                       │
│                                                               │
│ sendContextHook runs:                                         │
│   • Scans blocks in document order                            │
│   • Finds ## user / ## assistant markers                      │
│   • Builds messages array                                     │
│   • Returns { context: { messages, blockCount } }             │
└──────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────┐
│ Executor attaches hookResult.context to actions               │
│ (actions as any).hookContext = hookResult.context             │
└──────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────┐
│ sendHandler.execute() runs:                                   │
│   • Reads hookContext.messages                                │
│   • Replaces /send with ## assistant                          │
│   • Creates response placeholder child                        │
│   • Creates next ## user block immediately                    │
│   • Calls execute_ai_conversation                             │
│   • Updates response with LLM output                          │
└──────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────┐
│ hookRegistry.run('execute:after', ctx)                        │
│ (Future: logging, indexing, notifications)                    │
└──────────────────────────────────────────────────────────────┘
```

---

## 2. The Hook System Foundation

### What Are Hooks?

Hooks are lifecycle interceptors that run before, during, or after block operations. They provide extension points without modifying core logic.

### Hook Events

| Event | When It Fires | Use Cases |
|-------|---------------|-----------|
| `block:create` | Block added to Y.Doc | Indexing, auto-execute |
| `block:update` | Content/metadata changed | Re-indexing, validation |
| `block:delete` | Block removed | Cleanup, index removal |
| `execute:before` | Before handler runs | Validation, context injection, abort |
| `execute:after` | After handler completes | Logging, notifications |

### Hook Interface

```typescript
interface Hook {
  id: string;                    // Unique identifier
  event: HookEvent | HookEvent[];// Which event(s) to listen for
  filter: (block: Block) => boolean;  // Should this hook run?
  priority: number;              // Lower = earlier (negative for security)
  handler: (ctx: HookContext) => HookResult | Promise<HookResult>;
}

interface HookContext {
  block: Block;           // The block being operated on
  content: string;        // Current content (may be modified by earlier hooks)
  event: HookEvent;       // Which event type
  store: HookBlockStore;  // Read-only block access
  previousContent?: string;  // For update events
  result?: unknown;       // For execute:after
  error?: string;         // If execution failed
}

interface HookResult {
  content?: string;       // Modified content (for execute:before)
  abort?: boolean;        // Stop execution
  reason?: string;        // Why aborted
  context?: Record<string, unknown>;  // Data for handler
}
```

### Priority Conventions

| Range | Purpose | Examples |
|-------|---------|----------|
| -100 to -1 | Security/validation | Dangerous command blocking |
| 0 to 49 | Context assembly | sendContextHook, wikilink expansion |
| 50 to 99 | Standard processing | Transformations |
| 100+ | Logging/cleanup | Audit trails |

### The Hook Registry

Hooks register with a global singleton:

```typescript
import { hookRegistry } from '../hooks/hookRegistry';

hookRegistry.register({
  id: 'my-hook',
  event: 'execute:before',
  filter: (block) => block.content.includes('/send'),
  priority: 0,
  handler: (ctx) => {
    // Do something
    return { context: { myData: 'value' } };
  }
});
```

---

## 3. How Chat Uses Hooks

### The sendContextHook

Located at `src/lib/handlers/hooks/sendContextHook.ts`, this hook assembles multi-turn conversation context:

```typescript
export const sendContextHook: Hook = {
  id: 'send-context-assembly',
  event: 'execute:before',
  priority: 0,

  filter: (block) => {
    const content = block.content.trim().toLowerCase();
    return content.startsWith('/send') || content.startsWith('::send');
  },

  handler: (ctx: HookContext): HookResult => {
    const { block, store } = ctx;

    // Scope: zoomed subtree or full document
    const startIds = store.zoomedRootId
      ? [store.zoomedRootId]
      : store.rootIds;

    // Get blocks in document order
    const allBlockIds = getBlocksInDocumentOrder(startIds, store.getBlock);
    const sendIndex = allBlockIds.indexOf(block.id);

    if (sendIndex === -1) {
      return { abort: true, reason: 'Block not found in tree' };
    }

    // Scan for markers, build messages
    const messages = [];
    let currentRole = 'user';  // Default
    let currentContent = [];

    for (let i = 0; i < sendIndex; i++) {
      const b = store.getBlock(allBlockIds[i]);
      const text = b?.content.trim();
      if (!text) continue;

      if (isUserMarker(text)) {
        flushContent();
        currentRole = 'user';
      } else if (isAssistantMarker(text)) {
        flushContent();
        currentRole = 'assistant';
      } else {
        currentContent.push(text);
      }
    }
    flushContent();

    // Validation
    if (messages.length === 0) {
      return { abort: true, reason: 'No content to send' };
    }
    if (messages[messages.length - 1].role !== 'user') {
      return { abort: true, reason: 'No user content to send' };
    }

    return {
      context: { messages, blockCount: countLines(messages) }
    };
  }
};
```

### Key Insights

**1. Pure function**: The hook doesn't mutate anything—it reads the tree and returns data. This makes it testable without mocks.

**2. Abort capability**: If there's nothing to send or the last message isn't from the user, the hook aborts execution with a reason.

**3. Context injection**: The `messages` array passes through to the handler via `hookContext`.

### The sendHandler

Located at `src/lib/handlers/send.ts`, this handler consumes the hook's context:

```typescript
export const sendHandler: BlockHandler = {
  prefixes: ['/send', '::send'],

  async execute(
    blockId: string,
    _content: string,
    actions: ExecutorActions
  ): Promise<void> {
    // Get hook context - assembled by sendContextHook
    const hookContext = (actions as unknown as { hookContext?: SendHookContext }).hookContext;

    // Verify hook ran
    if (!hookContext?.messages?.length) {
      actions.updateBlockContent(blockId, 'error:: Context hook not providing messages');
      return;
    }

    const { messages } = hookContext;

    // Replace /send with ## assistant marker
    updateContent(blockId, '## assistant');
    actions.setBlockStatus?.(blockId, 'running');

    // Create response placeholder
    const responseId = actions.createBlockInside(blockId);
    updateContent(responseId, 'Thinking...');

    // Create next user block IMMEDIATELY (UX insight!)
    const nextUserId = actions.createBlockAfter(blockId);
    updateContent(nextUserId, '## user');
    const userInputId = actions.createBlockInside(nextUserId);
    requestAnimationFrame(() => actions.focusBlock!(userInputId));

    // Call LLM
    const response = await invoke('execute_ai_conversation', { messages, system: '...' });

    // Update response
    actions.updateBlockContent(responseId, response.trim());
    actions.setBlockStatus?.(blockId, 'complete');
  }
};
```

### The Handoff Pattern

This is the architecture working correctly:

```
sendContextHook                    sendHandler
      │                                 │
      │ filter → matches /send          │
      │ handler → builds messages       │
      │ returns { context: {...} }      │
      │                                 │
      └──────── hookContext ───────────▶│
                                        │
                                        │ consumes hookContext.messages
                                        │ executes LLM call
                                        │ updates UI
```

**Hook assembles. Handler consumes.** Neither does the other's job.

---

## 4. Enhancing Chat with Additional Hooks

The hook system makes chat enhancement composable. Here are several hooks that can be added without modifying the core `/send` implementation.

### 4.1 Token Estimation Hook

Warn before expensive API calls:

```typescript
// src/lib/handlers/hooks/tokenEstimationHook.ts

export const tokenEstimationHook: Hook = {
  id: 'token-estimation',
  event: 'execute:before',
  priority: 10,  // After context assembly

  filter: (block) => {
    const content = block.content.trim().toLowerCase();
    return content.startsWith('/send') || content.startsWith('ai::');
  },

  handler: (ctx: HookContext): HookResult => {
    const hookContext = ctx as unknown as { messages?: Message[] };
    if (!hookContext.messages) return {};

    const totalChars = hookContext.messages.reduce(
      (sum, m) => sum + m.content.length, 0
    );
    const estimatedTokens = Math.ceil(totalChars / 4);

    if (estimatedTokens > 50000) {
      console.warn(`[token-estimation] Large context: ~${estimatedTokens} tokens`);
      // Could prompt for confirmation here
    }

    return {
      context: {
        estimatedTokens,
        tokenWarning: estimatedTokens > 50000 ? 'Large context' : null
      }
    };
  }
};
```

### 4.2 Dangerous Content Filter

Block potentially harmful prompts:

```typescript
// src/lib/handlers/hooks/contentFilterHook.ts

const BLOCKED_PATTERNS = [
  /ignore previous instructions/i,
  /jailbreak/i,
  /pretend you are/i,
];

export const contentFilterHook: Hook = {
  id: 'content-filter',
  event: 'execute:before',
  priority: -50,  // Security: run early

  filter: (block) => {
    const content = block.content.trim().toLowerCase();
    return content.startsWith('/send') || content.startsWith('ai::');
  },

  handler: (ctx: HookContext): HookResult => {
    const hookContext = ctx as unknown as { messages?: Message[] };
    if (!hookContext.messages) return {};

    for (const msg of hookContext.messages) {
      for (const pattern of BLOCKED_PATTERNS) {
        if (pattern.test(msg.content)) {
          return {
            abort: true,
            reason: `Blocked pattern detected: ${pattern.source}`
          };
        }
      }
    }

    return {};
  }
};
```

### 4.3 Wikilink Expansion Hook

Expand `[[references]]` into actual content:

```typescript
// src/lib/handlers/hooks/wikilinkExpansionHook.ts

export const wikilinkExpansionHook: Hook = {
  id: 'wikilink-expansion',
  event: 'execute:before',
  priority: 5,  // After context assembly, before token estimation

  filter: (block) => {
    return block.content.startsWith('/send') || block.content.startsWith('ai::');
  },

  handler: (ctx: HookContext): HookResult => {
    const hookContext = ctx as unknown as { messages?: Message[] };
    if (!hookContext.messages) return {};

    const expandedMessages = hookContext.messages.map(msg => {
      let content = msg.content;
      const wikilinks = extractWikilinks(content);

      for (const link of wikilinks) {
        const page = findPage(link.target, ctx.store);
        if (page) {
          const expansion = `\n\n[Context from [[${link.target}]]:\n${page.content}\n---\n`;
          content = content.replace(link.raw, link.raw + expansion);
        }
      }

      return { ...msg, content };
    });

    return {
      context: {
        messages: expandedMessages,
        expandedLinks: extractWikilinks(hookContext.messages[0]?.content || '')
      }
    };
  }
};
```

### 4.4 Conversation Logging Hook

Audit trail for all LLM interactions:

```typescript
// src/lib/handlers/hooks/conversationLoggingHook.ts

export const conversationLoggingHook: Hook = {
  id: 'conversation-logger',
  event: ['execute:before', 'execute:after'],
  priority: 100,  // Run last

  filter: (block) => {
    return block.content.startsWith('/send') || block.content.startsWith('ai::');
  },

  handler: async (ctx: HookContext): Promise<HookResult> => {
    const hookContext = ctx as unknown as { messages?: Message[] };

    if (ctx.event === 'execute:before') {
      console.log('[conversation] Starting:', {
        blockId: ctx.block.id,
        messageCount: hookContext.messages?.length || 0,
        firstMessage: hookContext.messages?.[0]?.content.slice(0, 50)
      });
    } else {
      console.log('[conversation] Complete:', {
        blockId: ctx.block.id,
        error: ctx.error || null
      });

      // Could write to audit log, send webhook, etc.
      await invoke('log_conversation', {
        blockId: ctx.block.id,
        messages: hookContext.messages,
        timestamp: Date.now()
      });
    }

    return {};
  }
};
```

### 4.5 Response Caching Hook

Cache LLM responses for identical prompts:

```typescript
// src/lib/handlers/hooks/responseCacheHook.ts

const responseCache = new Map<string, { response: string; timestamp: number }>();
const CACHE_TTL = 1000 * 60 * 60;  // 1 hour

function hashMessages(messages: Message[]): string {
  return btoa(JSON.stringify(messages));
}

export const responseCacheHook: Hook = {
  id: 'response-cache',
  event: 'execute:before',
  priority: 20,

  filter: (block) => block.content.startsWith('/send'),

  handler: (ctx: HookContext): HookResult => {
    const hookContext = ctx as unknown as { messages?: Message[] };
    if (!hookContext.messages) return {};

    const hash = hashMessages(hookContext.messages);
    const cached = responseCache.get(hash);

    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      console.log('[cache] Hit for:', hash.slice(0, 20));
      // Inject cached response - handler can check for this
      return {
        context: {
          cachedResponse: cached.response,
          cacheHit: true
        }
      };
    }

    return {};
  }
};

// Companion hook to store responses
export const responseCacheStoreHook: Hook = {
  id: 'response-cache-store',
  event: 'execute:after',
  priority: 100,

  filter: (block) => block.content.startsWith('## assistant'),

  handler: (ctx: HookContext): HookResult => {
    const hookContext = ctx as unknown as { messages?: Message[] };
    if (!hookContext.messages || ctx.error) return {};

    const hash = hashMessages(hookContext.messages);
    // ctx.result would contain the response
    if (ctx.result) {
      responseCache.set(hash, {
        response: ctx.result as string,
        timestamp: Date.now()
      });
    }

    return {};
  }
};
```

### 4.6 TTL Context Management Hook

Implement time-to-live for referenced content:

```typescript
// src/lib/handlers/hooks/ttlContextHook.ts

interface TTLState {
  references: Map<string, { expiresAtTurn: number }>;
  currentTurn: number;
}

const ttlStates = new Map<string, TTLState>();

export const ttlContextHook: Hook = {
  id: 'ttl-context',
  event: 'execute:before',
  priority: 3,  // Before wikilink expansion

  filter: (block) => block.content.startsWith('/send'),

  handler: (ctx: HookContext): HookResult => {
    const hookContext = ctx as unknown as { messages?: Message[] };
    if (!hookContext.messages) return {};

    // Find conversation root
    const conversationId = findConversationRoot(ctx.block.id, ctx.store);
    if (!conversationId) return {};

    // Get or create TTL state
    let state = ttlStates.get(conversationId);
    if (!state) {
      state = { references: new Map(), currentTurn: 0 };
      ttlStates.set(conversationId, state);
    }

    // Parse context:: directives from messages
    for (const msg of hookContext.messages) {
      const directives = parseContextDirectives(msg.content);
      for (const { target, ttl } of directives) {
        state.references.set(target, {
          expiresAtTurn: ttl === 'never' ? Infinity : state.currentTurn + ttl
        });
      }
    }

    // Advance turn counter
    state.currentTurn++;

    // Filter expired references
    const activeRefs = Array.from(state.references.entries())
      .filter(([_, ref]) => ref.expiresAtTurn >= state.currentTurn)
      .map(([target, _]) => target);

    return {
      context: {
        activeReferences: activeRefs,
        ttlState: state
      }
    };
  }
};
```

### 4.7 Model Router Hook

Route to different models based on conversation characteristics:

```typescript
// src/lib/handlers/hooks/modelRouterHook.ts

export const modelRouterHook: Hook = {
  id: 'model-router',
  event: 'execute:before',
  priority: 15,

  filter: (block) => block.content.startsWith('/send'),

  handler: (ctx: HookContext): HookResult => {
    const hookContext = ctx as unknown as { messages?: Message[], estimatedTokens?: number };
    if (!hookContext.messages) return {};

    let recommendedModel = 'llama3';  // Default

    // Use faster model for simple queries
    if (hookContext.messages.length === 1 &&
        hookContext.messages[0].content.length < 200) {
      recommendedModel = 'llama3:7b';  // Smaller, faster
    }

    // Use larger model for complex conversations
    if (hookContext.messages.length > 5 ||
        (hookContext.estimatedTokens && hookContext.estimatedTokens > 10000)) {
      recommendedModel = 'llama3:70b';  // More capable
    }

    // Check for code-related content
    const hasCode = hookContext.messages.some(m =>
      m.content.includes('```') || m.content.includes('function ')
    );
    if (hasCode) {
      recommendedModel = 'codellama';
    }

    return {
      context: { recommendedModel }
    };
  }
};
```

---

## 5. Implementation Patterns

### Composing Multiple Hooks

Hooks chain naturally. Each hook can read and augment the accumulated context:

```
sendContextHook (priority: 0)
    └─▶ messages: [...]

ttlContextHook (priority: 3)
    └─▶ messages: [...], activeReferences: [...]

wikilinkExpansionHook (priority: 5)
    └─▶ messages: [...expanded...], activeReferences: [...], expandedLinks: [...]

tokenEstimationHook (priority: 10)
    └─▶ messages: [...], estimatedTokens: 2500, ...

modelRouterHook (priority: 15)
    └─▶ messages: [...], recommendedModel: 'codellama', ...

Handler receives full accumulated context
```

### Registration Pattern

Register hooks at app initialization:

```typescript
// src/lib/handlers/index.ts

import { hookRegistry } from '../hooks/hookRegistry';
import { sendContextHook } from './hooks/sendContextHook';
import { tokenEstimationHook } from './hooks/tokenEstimationHook';
import { wikilinkExpansionHook } from './hooks/wikilinkExpansionHook';
import { conversationLoggingHook } from './hooks/conversationLoggingHook';

export function registerHandlers(): void {
  // Core handlers
  handlerRegistry.register(sendHandler);
  handlerRegistry.register(shHandler);
  // ...

  // Core hooks
  hookRegistry.register(sendContextHook);

  // Enhancement hooks (can be feature-flagged)
  hookRegistry.register(tokenEstimationHook);
  hookRegistry.register(wikilinkExpansionHook);
  hookRegistry.register(conversationLoggingHook);

  console.log('[handlers] Registered hooks:', hookRegistry.getHookIds());
}
```

### Conditional Hook Registration

```typescript
// Feature-flagged hooks
if (config.enableTokenWarnings) {
  hookRegistry.register(tokenEstimationHook);
}

if (config.enableAuditLog) {
  hookRegistry.register(conversationLoggingHook);
}

if (config.enableResponseCache) {
  hookRegistry.register(responseCacheHook);
  hookRegistry.register(responseCacheStoreHook);
}
```

---

## 6. Testing Hooks

### Unit Testing Pure Hooks

Hooks are pure functions—test them directly:

```typescript
// src/lib/handlers/hooks/sendContextHook.test.ts

import { describe, it, expect } from 'vitest';
import { sendContextHook } from './sendContextHook';

describe('sendContextHook', () => {
  const createMockStore = (blocks: Record<string, Block>) => ({
    getBlock: (id: string) => blocks[id],
    rootIds: Object.keys(blocks).filter(id => !blocks[id].parentId),
    blocks,
    zoomedRootId: undefined
  });

  it('builds messages from ## user / ## assistant markers', () => {
    const blocks = {
      'user1': { id: 'user1', content: '## user', childIds: [] },
      'msg1': { id: 'msg1', content: 'Hello', childIds: [] },
      'asst1': { id: 'asst1', content: '## assistant', childIds: [] },
      'msg2': { id: 'msg2', content: 'Hi there', childIds: [] },
      'send': { id: 'send', content: '/send', childIds: [] }
    };

    const result = sendContextHook.handler({
      block: blocks['send'],
      content: '/send',
      event: 'execute:before',
      store: createMockStore(blocks)
    });

    expect(result.context?.messages).toEqual([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' }
    ]);
  });

  it('aborts if no user content at end', () => {
    const blocks = {
      'asst1': { id: 'asst1', content: '## assistant', childIds: [] },
      'msg1': { id: 'msg1', content: 'I am ready', childIds: [] },
      'send': { id: 'send', content: '/send', childIds: [] }
    };

    const result = sendContextHook.handler({
      block: blocks['send'],
      content: '/send',
      event: 'execute:before',
      store: createMockStore(blocks)
    });

    expect(result.abort).toBe(true);
    expect(result.reason).toBe('No user content to send');
  });

  it('respects zoom scoping', () => {
    const blocks = {
      'outside': { id: 'outside', content: '## user\nIgnored', childIds: [] },
      'root': { id: 'root', content: 'Zoomed root', childIds: ['inner'] },
      'inner': { id: 'inner', content: '## user\nIncluded', childIds: ['send'] },
      'send': { id: 'send', content: '/send', childIds: [] }
    };

    const store = createMockStore(blocks);
    store.zoomedRootId = 'root';

    const result = sendContextHook.handler({
      block: blocks['send'],
      content: '/send',
      event: 'execute:before',
      store
    });

    expect(result.context?.messages).toEqual([
      { role: 'user', content: 'Included' }
    ]);
  });
});
```

### Testing Hook Chains

```typescript
// src/lib/hooks/hookRegistry.test.ts

describe('HookRegistry chaining', () => {
  it('accumulates context from multiple hooks', async () => {
    const registry = new HookRegistry();

    registry.register({
      id: 'hook-a',
      event: 'execute:before',
      filter: () => true,
      priority: 0,
      handler: () => ({ context: { fromA: 'value-a' } })
    });

    registry.register({
      id: 'hook-b',
      event: 'execute:before',
      filter: () => true,
      priority: 10,
      handler: () => ({ context: { fromB: 'value-b' } })
    });

    const result = await registry.run('execute:before', mockContext);

    expect(result.context).toEqual({
      fromA: 'value-a',
      fromB: 'value-b'
    });
  });

  it('stops on first abort', async () => {
    const registry = new HookRegistry();

    registry.register({
      id: 'aborter',
      event: 'execute:before',
      filter: () => true,
      priority: 0,
      handler: () => ({ abort: true, reason: 'Blocked' })
    });

    registry.register({
      id: 'never-runs',
      event: 'execute:before',
      filter: () => true,
      priority: 10,
      handler: () => {
        throw new Error('Should not reach here');
      }
    });

    const result = await registry.run('execute:before', mockContext);

    expect(result.abort).toBe(true);
    expect(result.reason).toBe('Blocked');
  });
});
```

---

## Summary

### The Hook-Handler Pattern

```
┌─────────────────────────────────────────────────────────────┐
│                     HOOK SYSTEM                              │
│                                                              │
│  Hooks: ASSEMBLE context, VALIDATE inputs, TRANSFORM data   │
│         Pure functions, testable, composable                 │
│         Can abort, modify content, inject context            │
│                                                              │
│  Handlers: CONSUME context, EXECUTE actions, UPDATE UI       │
│            Side-effecting, stateful, focused                 │
│                                                              │
│  Separation enables:                                         │
│  • Testing without mocks                                     │
│  • Feature composition                                       │
│  • Clean extension points                                    │
│  • Single responsibility                                     │
└─────────────────────────────────────────────────────────────┘
```

### What We Built

1. **sendContextHook**: Assembles multi-turn conversation from markers
2. **sendHandler**: Consumes messages, executes LLM call, updates UI

### What We Can Add

| Hook | Purpose | Priority |
|------|---------|----------|
| `tokenEstimationHook` | Warn about large contexts | 10 |
| `contentFilterHook` | Block harmful prompts | -50 |
| `wikilinkExpansionHook` | Expand [[references]] | 5 |
| `conversationLoggingHook` | Audit trail | 100 |
| `responseCacheHook` | Cache identical prompts | 20 |
| `ttlContextHook` | Time-limited references | 3 |
| `modelRouterHook` | Route to optimal model | 15 |

### Files Reference

| File | Purpose |
|------|---------|
| `src/lib/hooks/types.ts` | Hook interface definitions |
| `src/lib/hooks/hookRegistry.ts` | Global hook registry |
| `src/lib/handlers/executor.ts` | Hook lifecycle wrapper |
| `src/lib/handlers/send.ts` | /send handler |
| `src/lib/handlers/hooks/sendContextHook.ts` | Context assembly hook |

---

## Further Reading

- `docs/architecture/FLOATTY_HOOK_SYSTEM.md` - Hook system design document
- `docs/FLO-200-MULTI-TURN-CONVERSATIONS.md` - Full multi-turn spec
- `docs/architecture/FLOATTY_HANDLER_REGISTRY.md` - Handler architecture
- `.claude/rules/ydoc-patterns.md` - Y.Doc integration patterns
