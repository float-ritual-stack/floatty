# Hook Patterns Guide

> Execution hooks for context assembly, validation, and handler coordination.

---

## Overview

Hooks run before/after handler execution to:

- **Assemble context** - Gather data from block tree (conversations, config)
- **Validate** - Block dangerous operations
- **Transform** - Modify content before execution
- **Log/audit** - Track execution attempts

```
User triggers execution
         │
         ▼
┌─────────────────────────┐
│   execute:before hooks  │  ← Context assembly, validation
│   (priority order)      │
└─────────────────────────┘
         │
    abort? ──yes──► Stop
         │
         no
         │
         ▼
┌─────────────────────────┐
│   Handler.execute()     │  ← Uses hookContext
└─────────────────────────┘
         │
         ▼
┌─────────────────────────┐
│   execute:after hooks   │  ← Logging, cleanup
│   (priority order)      │
└─────────────────────────┘
```

---

## Hook Interface

```typescript
interface Hook {
  /** Unique identifier */
  id: string;

  /** When to run: 'execute:before' or 'execute:after' */
  event: HookEvent | HookEvent[];

  /** Priority - lower runs first (default: 50) */
  priority: number;

  /** Filter - return true if hook should run for this block */
  filter: (block: Block) => boolean;

  /** Handler - do the work, return results */
  handler: (ctx: HookContext) => HookResult | Promise<HookResult>;
}

interface HookContext {
  block: Block;           // The block being executed
  content: string;        // Current content (may be modified by earlier hooks)
  event: HookEvent;       // 'execute:before' or 'execute:after'
  store: BlockStoreView;  // Read-only block store access
}

interface HookResult {
  /** Stop execution with reason */
  abort?: boolean;
  reason?: string;

  /** Modified content (passed to next hook/handler) */
  content?: string;

  /** Data to pass to handler via hookContext */
  context?: Record<string, unknown>;
}
```

---

## Priority Conventions

| Range | Use | Examples |
|-------|-----|----------|
| -100 to -1 | Security, validation | Block dangerous commands |
| 0 to 49 | Context assembly | Gather conversation history |
| 50 to 99 | Standard processing | Default handlers |
| 100+ | Logging, cleanup | Audit logs, metrics |

---

## Registering Hooks

```typescript
// src/lib/handlers/index.ts
import { hookRegistry } from '../hooks';
import { myHook } from './hooks/myHook';

export function registerHandlers(): void {
  // ... register handlers

  // Register hooks
  hookRegistry.register(myHook);
}
```

---

## Example: Context Assembly Hook

The `sendContextHook` assembles conversation messages for the `/send` handler:

```typescript
// src/lib/handlers/hooks/sendContextHook.ts

export const sendContextHook: Hook = {
  id: 'send-context-assembly',
  event: 'execute:before',
  priority: 0,  // Run early to assemble context

  filter: (block) => {
    const content = block.content.trim().toLowerCase();
    return content.startsWith('/send');
  },

  handler: (ctx: HookContext): HookResult => {
    const { block, store } = ctx;

    // Scan document for ## user / ## assistant markers
    const messages = assembleConversation(block, store);

    if (messages.length === 0) {
      return { abort: true, reason: 'No conversation context found' };
    }

    // Validate: last message must be from user
    const lastMessage = messages[messages.length - 1];
    if (lastMessage.role !== 'user') {
      return { abort: true, reason: 'Last message must be from user' };
    }

    // Pass messages to handler via context
    return {
      context: { messages },
    };
  },
};
```

**Handler consumes the context:**

```typescript
// In sendHandler
async execute(blockId, content, actions) {
  // Context assembled by sendContextHook
  const messages = (actions as any).hookContext?.messages;

  if (!messages) {
    // Hook didn't run or failed
    return;
  }

  // Use assembled messages
  await invoke('execute_ai_conversation', { messages });
}
```

---

## Example: Validation Hook

Block dangerous shell commands:

```typescript
export const shellValidationHook: Hook = {
  id: 'shell-validation',
  event: 'execute:before',
  priority: -50,  // Run early (high priority)

  filter: (block) => {
    const content = block.content.toLowerCase();
    return content.startsWith('sh::') || content.startsWith('term::');
  },

  handler: (ctx: HookContext): HookResult => {
    const content = ctx.content;

    // Check for dangerous patterns
    const dangerous = [
      'rm -rf /',
      'rm -rf ~',
      'mkfs.',
      'dd if=',
      ':(){ :|:& };:',  // Fork bomb
    ];

    for (const pattern of dangerous) {
      if (content.includes(pattern)) {
        return {
          abort: true,
          reason: `Blocked dangerous command: ${pattern}`,
        };
      }
    }

    return {};
  },
};
```

---

## Example: Content Transformation Hook

Expand variables before execution:

```typescript
export const variableExpansionHook: Hook = {
  id: 'variable-expansion',
  event: 'execute:before',
  priority: 10,  // After validation, before context assembly

  filter: (block) => block.content.includes('${{'),

  handler: (ctx: HookContext): HookResult => {
    let content = ctx.content;

    // Expand ${{date}} to current date
    content = content.replace(
      /\$\{\{date\}\}/g,
      new Date().toISOString().split('T')[0]
    );

    // Expand ${{time}} to current time
    content = content.replace(
      /\$\{\{time\}\}/g,
      new Date().toLocaleTimeString()
    );

    return { content };
  },
};
```

---

## Example: Logging Hook

Audit all executions:

```typescript
export const executionAuditHook: Hook = {
  id: 'execution-audit',
  event: ['execute:before', 'execute:after'],
  priority: 100,  // Run last

  filter: () => true,  // All blocks

  handler: (ctx: HookContext): HookResult => {
    const { block, event } = ctx;

    console.log(`[audit] ${event}`, {
      blockId: block.id,
      type: block.type,
      content: block.content.slice(0, 50),
      timestamp: new Date().toISOString(),
    });

    return {};
  },
};
```

---

## Hook Execution Flow

```typescript
// In executor.ts

export async function executeBlock(block, actions) {
  // 1. Run before hooks
  const hookResult = await hookRegistry.run('execute:before', {
    block,
    content: block.content,
    event: 'execute:before',
    store: createHookBlockStore(actions),
  });

  // 2. Check for abort
  if (hookResult.abort) {
    console.log('Execution aborted:', hookResult.reason);
    return;
  }

  // 3. Find handler
  const handler = registry.getHandler(hookResult.content ?? block.content);
  if (!handler) return;

  // 4. Execute with hook context
  await handler.execute(block.id, hookResult.content ?? block.content, {
    ...actions,
    hookContext: hookResult.context,
  });

  // 5. Run after hooks
  await hookRegistry.run('execute:after', {
    block,
    content: block.content,
    event: 'execute:after',
    store: createHookBlockStore(actions),
  });
}
```

---

## Sync vs Async Execution

Hooks can be sync or async:

```typescript
// Async hook (default via run())
handler: async (ctx): Promise<HookResult> => {
  const data = await fetchSomething();
  return { context: { data } };
}

// Sync hook (use runSync() for performance-critical paths)
handler: (ctx): HookResult => {
  // No await - must be synchronous
  return { context: { immediate: true } };
}
```

**Warning**: If you use `hookRegistry.runSync()`, async hooks will be skipped with a warning.

---

## BlockStoreView

Hooks receive a read-only view of the block store:

```typescript
interface BlockStoreView {
  getBlock(id: string): Block | undefined;
  getParentId(id: string): string | undefined;
  getChildren(id: string): string[];
  rootIds: string[];
  zoomedRootId?: string;  // If zoomed into a subtree
}
```

**Zoom scoping**: When `zoomedRootId` is set, hooks should scope their context gathering to that subtree. This allows conversations to be isolated within larger documents.

---

## Testing Hooks

```typescript
import { describe, it, expect, vi } from 'vitest';
import { HookRegistry } from '../../hooks/hookRegistry';
import { myHook } from './myHook';

describe('myHook', () => {
  it('assembles context correctly', async () => {
    const registry = new HookRegistry();
    registry.register(myHook);

    const mockStore = {
      getBlock: vi.fn().mockReturnValue({ id: '1', content: '## user\nHello' }),
      rootIds: ['1'],
    };

    const result = await registry.run('execute:before', {
      block: { id: 'send-1', content: '/send' },
      content: '/send',
      event: 'execute:before',
      store: mockStore,
    });

    expect(result.abort).toBeFalsy();
    expect(result.context?.messages).toBeDefined();
  });

  it('aborts on validation failure', async () => {
    const registry = new HookRegistry();
    registry.register(validationHook);

    const result = await registry.run('execute:before', {
      block: { id: '1', content: 'sh:: rm -rf /' },
      content: 'sh:: rm -rf /',
      event: 'execute:before',
      store: {},
    });

    expect(result.abort).toBe(true);
    expect(result.reason).toContain('dangerous');
  });
});
```

---

## Common Patterns

### Pattern 1: Conditional Context

```typescript
handler: (ctx) => {
  // Only add context if block has certain characteristics
  if (ctx.block.metadata?.needsContext) {
    const context = gatherContext(ctx.store);
    return { context: { additionalContext: context } };
  }
  return {};
}
```

### Pattern 2: Content Rewriting

```typescript
handler: (ctx) => {
  // Expand shorthand syntax
  let content = ctx.content;
  content = content.replace('@today', new Date().toISOString().split('T')[0]);
  content = content.replace('@me', 'evan');
  return { content };
}
```

### Pattern 3: Cascading Abort

```typescript
// Validation hook
handler: (ctx) => {
  if (isDangerous(ctx.content)) {
    return { abort: true, reason: 'Dangerous command blocked' };
  }
  return {};
}

// Later hook won't run if earlier hook aborted
```

### Pattern 4: Multi-Event Hook

```typescript
export const lifecycleHook: Hook = {
  id: 'lifecycle-tracker',
  event: ['execute:before', 'execute:after'],  // Both events
  priority: 100,

  filter: () => true,

  handler: (ctx) => {
    if (ctx.event === 'execute:before') {
      console.log('Starting execution:', ctx.block.id);
    } else {
      console.log('Finished execution:', ctx.block.id);
    }
    return {};
  },
};
```

---

## References

- Hook registry: `src/lib/hooks/hookRegistry.ts`
- Hook types: `src/lib/hooks/types.ts`
- sendContextHook: `src/lib/handlers/hooks/sendContextHook.ts`
- Executor: `src/lib/handlers/executor.ts`
- Architecture: `docs/architecture/FLOATTY_HOOK_SYSTEM.md`
