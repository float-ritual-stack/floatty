# Floatty Handler Registry Architecture (ARCHIVED — ORIGINAL VISION)

> **ARCHIVED 2026-04-12** — This described the original Rust-side handler trait vision that was
> never implemented. Actual implementation is TypeScript-only.
> **Current source of truth**: [`HANDLER_REGISTRY_IMPLEMENTATION.md`](../architecture/HANDLER_REGISTRY_IMPLEMENTATION.md)
> Kept for historical context only — unsafe to implement against.

> Reducing handler ceremony. Currently TypeScript frontend handlers; coordination protocol enables multi-client execution.

---

## Implementation Status (2026-01-15)

```
╭─────────────────────────────────────────────────────────────────╮
│  DONE                                                            │
├─────────────────────────────────────────────────────────────────┤
│  ✅ TypeScript handler registry (src/lib/handlers/)              │
│  ✅ BlockHandler interface with prefixes + execute               │
│  ✅ Handler registration with HMR guard                          │
│  ✅ Hook integration (execute:before/after)                      │
│  ✅ Handlers: sh, ai, daily, search, pick, send                  │
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│  CURRENT STATE                                                   │
├─────────────────────────────────────────────────────────────────┤
│  Handlers are frontend TypeScript, NOT Rust as originally        │
│  planned. This works for desktop-only execution but requires     │
│  coordination protocol for multi-client scenarios.               │
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│  FUTURE (IF NEEDED)                                              │
├─────────────────────────────────────────────────────────────────┤
│  • Port simple handlers to Rust (floatty-server)                 │
│  • Server-side execution for headless scenarios                  │
│  • Plugin/extension system                                       │
╰─────────────────────────────────────────────────────────────────╯
```

---

## Current Architecture (TypeScript)

### Handler Interface

```typescript
// src/lib/handlers/types.ts

export interface BlockHandler {
  /** Prefixes this handler responds to (e.g., ['sh::', 'term::']) */
  prefixes: string[];

  /** Execute the block, update output via actions */
  execute(
    blockId: string,
    content: string,
    actions: ExecutorActions
  ): Promise<void>;
}

export interface ExecutorActions {
  getBlock?(id: string): Block | undefined;
  updateBlockContent(id: string, content: string): void;
  updateBlockOutput(id: string, output: string, type?: string): void;
  setBlockStatus?(id: string, status: BlockStatus): void;
  createBlockInside(parentId: string): string;
  createBlockAfter(siblingId: string): string;
}
```

### Registered Handlers

| Handler | File | Prefixes | Description |
|---------|------|----------|-------------|
| `shHandler` | `commandDoor.ts` | `sh::`, `term::` | Shell command execution |
| `conversationHandler` | `conversation/` | `ai::`, `chat::` | Multi-turn LLM conversations |
| `dailyHandler` | `daily.ts` | `daily::` | Daily note aggregation |
| `searchHandler` | `search.ts` | `search::` | Full-text search via Tantivy |
| `pickHandler` | `pick.ts` | `$tv(` | Fuzzy picker integration |
| `sendHandler` | `send.ts` | `/send` | Send conversation to LLM |

### File Structure

```
src/lib/handlers/
├── index.ts              # Registration, handlerRegistry export
├── registry.ts           # HandlerRegistry class
├── types.ts              # BlockHandler, ExecutorActions interfaces
├── executor.ts           # executeBlock() dispatch function
├── executor.test.ts      # Executor tests
├── utils.ts              # Shared utilities
│
├── commandDoor.ts        # Factory for simple command handlers (sh::)
├── daily.ts              # daily:: lens handler
├── search.ts             # search:: lens handler
├── pick.ts               # $tv() picker handler
├── send.ts               # /send conversation handler
│
├── conversation/         # Multi-turn conversation support
│   ├── index.ts          # conversationHandler export
│   ├── builder.ts        # buildConversation(), message assembly
│   ├── parser.ts         # Role inference, config parsing
│   └── types.ts          # ConversationMessage, ConversationConfig
│
└── hooks/
    ├── sendContextHook.ts      # Context assembly for /send
    └── sendContextHook.test.ts # 19 tests
```

### Registration

```typescript
// src/lib/handlers/index.ts

import { handlerRegistry } from './registry';
import { hookRegistry } from '../hooks/hookRegistry';

// Guard against duplicate registration (HMR)
if (!handlerRegistry.has('sh-handler')) {
  handlerRegistry.register(shHandler);
  handlerRegistry.register(conversationHandler);
  handlerRegistry.register(dailyHandler);
  handlerRegistry.register(searchHandler);
  handlerRegistry.register(pickHandler);
  handlerRegistry.register(sendHandler);

  hookRegistry.register(sendContextHook);
}

export { handlerRegistry };
```

### Execution Flow

```typescript
// src/lib/handlers/executor.ts

export async function executeBlock(
  block: Block,
  actions: ExecutorActions
): Promise<void> {
  const content = block.content;

  // Run before hooks (context assembly, validation)
  const hookResult = await hookRegistry.run('execute:before', {
    block,
    content,
    event: 'execute:before',
  });

  if (hookResult.abort) {
    console.log('Execution aborted:', hookResult.reason);
    return;
  }

  // Find handler
  const handler = handlerRegistry.getHandler(content);
  if (!handler) {
    console.warn('No handler for:', content.slice(0, 20));
    return;
  }

  // Execute with accumulated context
  await handler.execute(block.id, hookResult.content ?? content, {
    ...actions,
    hookContext: hookResult.context,
  });

  // Run after hooks
  await hookRegistry.run('execute:after', { block, content, event: 'execute:after' });
}
```

---

## Adding a New Handler

To add a `weather::` handler:

**1. Create handler file** (`src/lib/handlers/weather.ts`):

```typescript
import type { BlockHandler, ExecutorActions } from './types';
import { invoke } from '@tauri-apps/api/core';

export const weatherHandler: BlockHandler = {
  prefixes: ['weather::'],

  async execute(
    blockId: string,
    content: string,
    actions: ExecutorActions
  ): Promise<void> {
    const location = content.replace(/^weather::\s*/, '').trim();

    // Show loading state
    actions.setBlockStatus?.(blockId, 'running');

    try {
      // Call backend (or external API)
      const weather = await invoke<string>('fetch_weather', { location });

      // Create output block
      const outputId = actions.createBlockInside(blockId);
      actions.updateBlockContent(outputId, weather);
      actions.setBlockStatus?.(blockId, 'complete');
    } catch (err) {
      actions.updateBlockOutput(blockId, `Error: ${err}`, 'error');
      actions.setBlockStatus?.(blockId, 'error');
    }
  },
};
```

**2. Register in `index.ts`**:

```typescript
import { weatherHandler } from './weather';

// In registration block:
handlerRegistry.register(weatherHandler);
```

**Done.** 2 files (1 new + 1 line in registration).

---

## Handler Patterns

### Pattern 1: Command Door (Simple Text Output)

For handlers that execute a command and return text:

```typescript
import { createCommandDoor } from './commandDoor';

export const echoHandler = createCommandDoor({
  prefixes: ['echo::'],
  backendCommand: 'execute_echo',  // Tauri command
  paramName: 'text',
  outputPrefix: 'output::',
  pendingMessage: 'Processing...',
});
```

### Pattern 2: Lens (Child Output Block)

For handlers that create output as a child block:

```typescript
export const searchHandler: BlockHandler = {
  prefixes: ['search::'],

  async execute(blockId, content, actions) {
    const query = content.replace(/^search::\s*/, '');

    // Find or create output block
    const existingOutput = findOutputChild(blockId, actions);
    const outputId = existingOutput ?? actions.createBlockInside(blockId);

    // Show loading
    actions.updateBlockContent(outputId, 'Searching...');

    // Execute search
    const results = await searchBlocks(query);

    // Update output
    actions.updateBlockContent(outputId, formatResults(results));
    actions.updateBlockOutput(outputId, '', 'search-results');
  },
};
```

### Pattern 3: Conversation (Multi-Turn)

For handlers that need context from the block tree:

```typescript
export const conversationHandler: BlockHandler = {
  prefixes: ['ai::', 'chat::'],

  async execute(blockId, content, actions) {
    // Build conversation from tree
    const messages = buildConversation(blockId, actions);

    // Create response block
    const responseId = actions.createBlockInside(blockId);
    actions.updateBlockContent(responseId, 'assistant:: Thinking...');

    // Call LLM
    const response = await invoke('execute_ai_conversation', { messages });

    // Update response
    actions.updateBlockContent(responseId, `assistant:: ${response}`);
  },
};
```

---

## Hook Integration

Handlers can access hook-assembled context:

```typescript
// In sendHandler
async execute(blockId, content, actions) {
  // Context assembled by sendContextHook
  const messages = actions.hookContext?.messages;

  if (!messages || messages.length === 0) {
    actions.updateBlockOutput(blockId, 'No conversation context found', 'error');
    return;
  }

  // Use assembled messages...
}
```

Hooks run in priority order before execution:

| Hook | Priority | Purpose |
|------|----------|---------|
| `sendContextHook` | 10 | Assembles `## user`/`## assistant` messages |
| *(future)* validation | -10 | Block dangerous commands |
| *(future)* logging | 100 | Log execution attempts |

---

## Relationship to Multi-Client Architecture

**Current limitation**: Handlers are frontend-only. External clients (CLI, agents) can create blocks but can't execute without desktop.

**Solution**: Coordination protocol (see `FLOATTY_MULTI_CLIENT.md`):

1. External client calls `POST /api/v1/execute`
2. Server broadcasts `ExecuteAvailable` to connected clients
3. Desktop (with TypeScript handlers) claims and executes
4. Result returns via WebSocket → HTTP response

**No handler changes needed** - existing TypeScript handlers work via coordination.

**Future option**: Port high-value handlers to Rust in floatty-server for headless execution.

---

## Backend Commands (Rust)

Handlers call Tauri commands for actual execution:

| Command | File | Purpose |
|---------|------|---------|
| `execute_shell_command` | `lib.rs` | Run shell command via PTY |
| `execute_ai_command` | `commands/ai.rs` | Single-turn Ollama call |
| `execute_ai_conversation` | `commands/ai.rs` | Multi-turn Ollama conversation |
| `execute_daily_query` | `commands/daily.rs` | Query daily notes |

These are thin adapters. Business logic stays in handlers.

---

## Original Vision vs Reality

The original architecture doc proposed Rust handlers with a `BlockHandler` trait:

```rust
// Original proposal (NOT implemented)
#[async_trait]
pub trait BlockHandler: Send + Sync {
    fn prefixes(&self) -> &[&str];
    async fn execute(&self, content: &str) -> Result<HandlerOutput, String>;
}
```

**What actually happened**: TypeScript handlers in the frontend, calling Tauri commands for backend operations. This was pragmatic:

- Faster iteration (no Rust compile cycles)
- Easier hook integration (same runtime)
- Works well with SolidJS reactivity

**Trade-off**: Can't execute without a frontend client running.

**Path forward**: Coordination protocol enables multi-client execution while keeping TypeScript handlers. Rust handlers can be added incrementally for headless scenarios.

---

## References

- Handler code: `src/lib/handlers/`
- Hook system: `src/lib/hooks/hookRegistry.ts`
- Multi-client architecture: `FLOATTY_MULTI_CLIENT.md`
- Event system: `src/lib/events/` (EventBus, ProjectionScheduler)
