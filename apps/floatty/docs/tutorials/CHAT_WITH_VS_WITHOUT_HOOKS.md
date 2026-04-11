# Chat Implementation: With Hooks vs. Without

> An honest comparison of implementing multi-turn chat with and without the hook system, examining the real trade-offs.

**Last Updated**: 2026-01-15

---

## The Question

Floatty's `/send` command uses a hook (`sendContextHook`) to assemble conversation context before the handler executes. But was this necessary? What would the alternative look like, and when does the hook abstraction actually pay off?

This article implements the same feature both ways and provides an honest analysis.

---

## Implementation A: Without Hooks (Direct)

### The Handler Does Everything

```typescript
// src/lib/handlers/send.ts (no hooks)

export const sendHandler: BlockHandler = {
  prefixes: ['/send', '::send'],

  async execute(
    blockId: string,
    content: string,
    actions: ExecutorActions
  ): Promise<void> {
    // ═══════════════════════════════════════════════════════════
    // CONTEXT ASSEMBLY (would be in hook)
    // ═══════════════════════════════════════════════════════════

    const store = actions.getStore();

    // Determine scope
    const startIds = store.zoomedRootId
      ? [store.zoomedRootId]
      : store.rootIds;

    // Get blocks in document order
    const allBlockIds = getBlocksInDocumentOrder(startIds, store.getBlock);
    const sendIndex = allBlockIds.indexOf(blockId);

    if (sendIndex === -1) {
      actions.updateBlockContent(blockId, 'error:: Block not found');
      return;
    }

    // Build messages from markers
    const messages: Message[] = [];
    let currentRole: 'user' | 'assistant' = 'user';
    let currentContent: string[] = [];

    const flushContent = () => {
      if (currentContent.length > 0) {
        messages.push({
          role: currentRole,
          content: currentContent.join('\n')
        });
        currentContent = [];
      }
    };

    for (let i = 0; i < sendIndex; i++) {
      const block = store.getBlock(allBlockIds[i]);
      const text = block?.content.trim();
      if (!text) continue;

      if (text.toLowerCase() === '## user') {
        flushContent();
        currentRole = 'user';
      } else if (text.toLowerCase() === '## assistant') {
        flushContent();
        currentRole = 'assistant';
      } else {
        currentContent.push(text);
      }
    }
    flushContent();

    // Validation
    if (messages.length === 0) {
      actions.updateBlockContent(blockId, 'error:: No content to send');
      return;
    }

    if (messages[messages.length - 1].role !== 'user') {
      actions.updateBlockContent(blockId, 'error:: Last message must be from user');
      return;
    }

    // ═══════════════════════════════════════════════════════════
    // EXECUTION (the actual handler work)
    // ═══════════════════════════════════════════════════════════

    // Replace /send with ## assistant
    actions.updateBlockContent(blockId, '## assistant');
    actions.setBlockStatus?.(blockId, 'running');

    // Create response placeholder
    const responseId = actions.createBlockInside(blockId);
    actions.updateBlockContent(responseId, 'Thinking...');

    // Create next user block immediately
    const nextUserId = actions.createBlockAfter(blockId);
    actions.updateBlockContent(nextUserId, '## user');
    const userInputId = actions.createBlockInside(nextUserId);
    requestAnimationFrame(() => actions.focusBlock?.(userInputId));

    try {
      const response = await invoke<string>('execute_ai_conversation', {
        messages,
        system: 'You are a helpful assistant.'
      });

      actions.updateBlockContent(responseId, response.trim());
      actions.setBlockStatus?.(blockId, 'complete');
    } catch (err) {
      actions.updateBlockContent(responseId, `error:: ${err}`);
      actions.setBlockStatus?.(blockId, 'error');
    }
  }
};
```

### Lines of Code

- **Handler**: ~95 lines
- **Tests**: Would need to mock `actions.getStore()`, `invoke`, etc.
- **Total**: ~95 lines in one file

### Characteristics

| Aspect | Assessment |
|--------|------------|
| **Locality** | Everything in one place |
| **Debugging** | Step through linearly |
| **Testing** | Requires integration tests with mocked Tauri |
| **Reusability** | Context logic locked inside handler |
| **Extension** | Modify handler directly |

---

## Implementation B: With Hooks (Current)

### The Hook Assembles Context

```typescript
// src/lib/handlers/hooks/sendContextHook.ts

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

    const startIds = store.zoomedRootId
      ? [store.zoomedRootId]
      : store.rootIds;

    const allBlockIds = getBlocksInDocumentOrder(startIds, store.getBlock);
    const sendIndex = allBlockIds.indexOf(block.id);

    if (sendIndex === -1) {
      return { abort: true, reason: 'Block not found in tree' };
    }

    const messages: Message[] = [];
    let currentRole: 'user' | 'assistant' = 'user';
    let currentContent: string[] = [];

    const flushContent = () => {
      if (currentContent.length > 0) {
        messages.push({ role: currentRole, content: currentContent.join('\n') });
        currentContent = [];
      }
    };

    for (let i = 0; i < sendIndex; i++) {
      const b = store.getBlock(allBlockIds[i]);
      const text = b?.content.trim();
      if (!text) continue;

      if (text.toLowerCase() === '## user') {
        flushContent();
        currentRole = 'user';
      } else if (text.toLowerCase() === '## assistant') {
        flushContent();
        currentRole = 'assistant';
      } else {
        currentContent.push(text);
      }
    }
    flushContent();

    if (messages.length === 0) {
      return { abort: true, reason: 'No content to send' };
    }

    if (messages[messages.length - 1].role !== 'user') {
      return { abort: true, reason: 'No user content to send' };
    }

    return {
      context: { messages, blockCount: messages.length }
    };
  }
};
```

### The Handler Consumes Context

```typescript
// src/lib/handlers/send.ts

// Type-safe access to hook-injected context
// In production, extend ExecutorActions directly rather than using this pattern
interface ExecutorActionsWithHookContext extends ExecutorActions {
  hookContext?: SendHookContext;
}

interface SendHookContext {
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  blockCount?: number;
}

export const sendHandler: BlockHandler = {
  prefixes: ['/send', '::send'],

  async execute(
    blockId: string,
    _content: string,
    actions: ExecutorActions
  ): Promise<void> {
    // hookContext is dynamically attached by the executor after running hooks.
    // Cast to extended interface for type-safe access.
    const { hookContext } = actions as ExecutorActionsWithHookContext;

    if (!hookContext?.messages?.length) {
      actions.updateBlockContent(blockId, 'error:: No messages from context hook');
      return;
    }

    const { messages } = hookContext;

    // Replace /send with ## assistant
    actions.updateBlockContent(blockId, '## assistant');
    actions.setBlockStatus?.(blockId, 'running');

    // Create response placeholder
    const responseId = actions.createBlockInside(blockId);
    actions.updateBlockContent(responseId, 'Thinking...');

    // Create next user block immediately
    const nextUserId = actions.createBlockAfter(blockId);
    actions.updateBlockContent(nextUserId, '## user');
    const userInputId = actions.createBlockInside(nextUserId);
    requestAnimationFrame(() => actions.focusBlock?.(userInputId));

    try {
      const response = await invoke<string>('execute_ai_conversation', {
        messages,
        system: 'You are a helpful assistant.'
      });

      actions.updateBlockContent(responseId, response.trim());
      actions.setBlockStatus?.(blockId, 'complete');
    } catch (err) {
      actions.updateBlockContent(responseId, `error:: ${err}`);
      actions.setBlockStatus?.(blockId, 'error');
    }
  }
};
```

### Lines of Code

- **Hook**: ~65 lines
- **Handler**: ~45 lines
- **Hook Registry**: ~100 lines (shared infrastructure)
- **Executor wrapper**: ~50 lines (shared infrastructure)
- **Total**: ~110 lines for feature + ~150 lines infrastructure

### Characteristics

| Aspect | Assessment |
|--------|------------|
| **Locality** | Split across files |
| **Debugging** | Must trace through registry |
| **Testing** | Hook is pure, handler simpler |
| **Reusability** | Context logic available to other hooks |
| **Extension** | Add hooks without touching handler |

---

## Honest Comparison

### When Hooks DON'T Pay Off

**1. Single-use logic**

If context assembly is only ever used by `/send`, the hook abstraction adds indirection without benefit. The direct version is easier to understand.

**2. Simple features**

For a feature that "just works" and won't need extension, hooks add cognitive overhead. You're paying for flexibility you won't use.

**3. Small teams / single developer**

The "modify handler directly" approach is fine when you're the only one touching the code. Hooks shine in multi-developer scenarios where you want isolation.

**4. Debugging priority**

The direct approach has a linear call stack. Hook-based debugging requires understanding the registry, priority ordering, and context accumulation.

### When Hooks DO Pay Off

**1. Multiple extension points**

Once you want to add token estimation, content filtering, logging, caching, etc., hooks become valuable. Each concern is isolated:

```
Without hooks:
  sendHandler.execute() {
    // 20 lines: context assembly
    // 10 lines: token estimation
    // 15 lines: content filtering
    // 10 lines: wikilink expansion
    // 5 lines: logging start
    // ... actual execution ...
    // 5 lines: logging end
    // 10 lines: caching
  }
  // 200+ lines, all interleaved

With hooks:
  sendContextHook       // 65 lines, isolated
  tokenEstimationHook   // 25 lines, isolated
  contentFilterHook     // 30 lines, isolated
  wikilinkExpansionHook // 40 lines, isolated
  loggingHook           // 20 lines, isolated
  sendHandler           // 45 lines, just execution
  // Same total, but each piece testable/replaceable
```

**2. Feature flags**

Hooks can be conditionally registered:

```typescript
if (config.enableTokenWarnings) {
  hookRegistry.register(tokenEstimationHook);
}
```

The direct approach requires `if` statements scattered through the handler.

**3. Testing pure logic**

The hook is a pure function: given this store state, return these messages. No mocks needed:

```typescript
it('builds messages from markers', () => {
  const result = sendContextHook.handler({
    block: { id: 'send', content: '/send' },
    store: { getBlock, rootIds: ['a', 'b', 'c'] }
  });

  expect(result.context.messages).toEqual([...]);
});
```

The direct approach requires mocking `invoke()`, `actions`, and testing through side effects.

**4. Abort semantics**

Hooks provide clean abort with reasons:

```typescript
return { abort: true, reason: 'Token limit exceeded' };
```

The direct approach either throws (ugly) or returns early with side effects (confusing).

**5. Multiple handlers sharing context**

If `ai::`, `/send`, and `chat::` all need conversation context, the hook runs once and all handlers benefit. The direct approach duplicates the logic.

---

## The Real Trade-off

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│   Simplicity ◄─────────────────────────────► Extensibility  │
│                                                             │
│   Direct Implementation         Hook-Based Implementation   │
│   • Easier to understand        • Easier to extend          │
│   • Linear debugging            • Isolated concerns         │
│   • Less infrastructure         • Pure/testable logic       │
│   • Good for stable features    • Good for evolving features│
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Decision Framework

| Question | If Yes → | If No → |
|----------|----------|---------|
| Will multiple features share this logic? | Hooks | Direct |
| Do you need feature flags? | Hooks | Direct |
| Is this a stable, "done" feature? | Direct | Hooks |
| Do you need abort semantics? | Hooks | Direct |
| Is testability critical? | Hooks | Direct |
| Is this a prototype/experiment? | Direct | - |
| Will multiple developers touch this? | Hooks | Direct |

---

## Floatty's Choice: Why Hooks Made Sense

For `/send` specifically, hooks were justified because:

1. **Planned extensions**: Token estimation, wikilink expansion, TTL context, model routing were all on the roadmap. Hooks let us add these without touching the handler.

2. **Shared context logic**: The `ai::` handler and potential `chat::` handler would reuse the same context assembly.

3. **Abort semantics**: "No user content to send" is a validation concern that shouldn't live in the execution handler.

4. **Testing**: The context assembly logic has edge cases (zoom scoping, marker detection, empty content). Testing it as a pure function is cleaner.

### What We'd Do Differently

If `/send` were the only LLM feature and we had no extension plans, the direct implementation would have been better. The hook system is infrastructure debt that only pays off when used.

**The honest truth**: We built hooks anticipating growth. If that growth doesn't materialize, we over-engineered. The bet was that chat would become a core feature with many extension points—which it has.

---

## Conclusion

Hooks are not universally better. They're a trade-off:

| You Get | You Pay |
|---------|---------|
| Isolated concerns | Split code |
| Pure/testable logic | Indirection |
| Extension points | Infrastructure |
| Feature flags | Debugging complexity |
| Abort semantics | Learning curve |

**Use hooks when**:
- Multiple concerns need the same data
- Features will evolve and extend
- Testing purity matters
- You need clean abort/validation

**Use direct implementation when**:
- The feature is simple and stable
- You're prototyping
- Debugging simplicity matters more than extensibility
- You're the only developer

The goal isn't "always use hooks" or "never use hooks"—it's choosing the right abstraction level for your actual needs.

---

## Appendix: Refactoring Path

If you start direct and later need hooks, the refactor is mechanical:

1. Extract context logic into a function
2. Wrap function in hook interface
3. Register hook
4. Remove logic from handler
5. Read from `hookContext`

Going the other direction (hooks → direct) is also straightforward:

1. Inline hook logic into handler
2. Remove hook registration
3. Delete hook file

Neither direction is a rewrite. The architectural decision is reversible.
