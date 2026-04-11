# Adding Block Handlers

> Step-by-step guide for adding new executable block types to floatty.

---

## Quick Start

To add a new handler (e.g., `weather::`):

**1. Create handler file:**

```typescript
// src/lib/handlers/weather.ts
import type { BlockHandler, ExecutorActions } from './types';
import { invoke } from '@tauri-apps/api/core';

export const weatherHandler: BlockHandler = {
  prefixes: ['weather::'],

  async execute(blockId: string, content: string, actions: ExecutorActions) {
    const location = content.replace(/^weather::\s*/, '').trim();

    actions.setBlockStatus?.(blockId, 'running');

    try {
      const result = await invoke<string>('fetch_weather', { location });
      const outputId = actions.createBlockInside(blockId);
      actions.updateBlockContent(outputId, result);
      actions.setBlockStatus?.(blockId, 'complete');
    } catch (err) {
      actions.setBlockStatus?.(blockId, 'error');
      // Optionally create error output block
    }
  },
};
```

**2. Register in `index.ts`:**

```typescript
// src/lib/handlers/index.ts
import { weatherHandler } from './weather';

// In registerHandlers():
registry.register(weatherHandler);
```

**Done.** The handler will respond to `weather:: London` blocks.

---

## Handler Interface

```typescript
export interface BlockHandler {
  /** Prefixes that trigger this handler (e.g., ['sh::', 'term::']) */
  prefixes: string[];

  /** Execute the block content and handle output */
  execute: (
    blockId: string,
    content: string,
    actions: ExecutorActions
  ) => Promise<void>;
}
```

### ExecutorActions

These actions are passed to your handler for block manipulation:

| Action | Description |
|--------|-------------|
| `createBlockInside(parentId)` | Create child block, returns new ID |
| `createBlockInsideAtTop(parentId)` | Create child at top |
| `createBlockAfter(afterId)` | Create sibling block |
| `updateBlockContent(id, content)` | Update block text |
| `setBlockOutput(id, data, type)` | Set structured output (for lenses) |
| `setBlockStatus(id, status)` | Set loading state: `'idle'`, `'running'`, `'complete'`, `'error'` |
| `getBlock(id)` | Read block data |
| `getParentId(id)` | Get parent block ID |
| `getChildren(id)` | Get child block IDs |
| `focusBlock(id)` | Move cursor to block |
| `paneId` | Current pane ID (for split layouts) |

---

## Handler Patterns

### Pattern 1: Command Door (Simple Output)

For handlers that run a command and show text output:

```typescript
import { createCommandDoor } from './commandDoor';

export const echoHandler = createCommandDoor({
  prefixes: ['echo::'],
  backendCommand: 'execute_echo',  // Tauri command name
  paramName: 'text',               // Parameter name for invoke()
  outputPrefix: 'output::',        // Prefix for output block
  pendingMessage: 'Processing...', // Loading message
  logPrefix: 'echo',               // For console logs
});
```

The `createCommandDoor` factory handles:
- Stripping prefix from content
- Showing loading state
- Creating output block as child
- Error handling

**Use when**: Simple command → text output pattern (like `sh::`)

### Pattern 2: Lens (Structured Output)

For handlers that populate structured data views:

```typescript
export const dailyHandler: BlockHandler = {
  prefixes: ['daily::'],

  async execute(blockId, content, actions) {
    const dateStr = content.replace(/^daily::\s*/, '').trim();

    actions.setBlockStatus?.(blockId, 'running');

    try {
      // Fetch structured data
      const data = await invoke<DailyNoteData>('execute_daily_query', {
        dateQuery: dateStr,
      });

      // Set as structured output (rendered by DailyView component)
      actions.setBlockOutput?.(blockId, data, 'daily');
      actions.setBlockStatus?.(blockId, 'complete');
    } catch (err) {
      actions.setBlockStatus?.(blockId, 'error');
    }
  },
};
```

**Use when**: Output needs custom rendering (charts, tables, etc.)

### Pattern 3: Child Output Block

For handlers that create a separate output block:

```typescript
export const searchHandler: BlockHandler = {
  prefixes: ['search::'],

  async execute(blockId, content, actions) {
    const query = content.replace(/^search::\s*/, '').trim();

    // Find existing output child or create new one
    const children = actions.getChildren?.(blockId) ?? [];
    let outputId = children.find(id => {
      const block = actions.getBlock?.(id);
      return block?.outputType === 'search-results';
    });

    if (!outputId) {
      outputId = actions.createBlockInside(blockId);
    }

    // Show loading in output block
    actions.updateBlockContent(outputId, 'Searching...');

    try {
      const results = await searchBlocks(query);
      actions.updateBlockContent(outputId, formatResults(results));
      actions.setBlockOutput?.(outputId, results, 'search-results');
    } catch (err) {
      actions.updateBlockContent(outputId, `Error: ${err}`);
    }
  },
};
```

**Use when**: Output should be editable/deletable separately from input

### Pattern 4: Conversation (Tree Context)

For handlers that need context from parent blocks:

```typescript
export const conversationHandler: BlockHandler = {
  prefixes: ['ai::', 'chat::'],

  async execute(blockId, content, actions) {
    // Build conversation by walking up the tree
    const messages = buildConversation(blockId, actions);

    // Create response block as child
    const responseId = actions.createBlockInside(blockId);
    actions.updateBlockContent(responseId, 'assistant:: Thinking...');
    actions.setBlockStatus?.(responseId, 'running');

    try {
      const response = await invoke<string>('execute_ai_conversation', {
        messages,
      });

      actions.updateBlockContent(responseId, `assistant:: ${response}`);
      actions.setBlockStatus?.(responseId, 'complete');

      // Create empty block for next user input
      const nextId = actions.createBlockInside(responseId);
      actions.focusBlock?.(nextId);
    } catch (err) {
      actions.updateBlockContent(responseId, `error:: ${err}`);
      actions.setBlockStatus?.(responseId, 'error');
    }
  },
};
```

**Use when**: Handler needs to read parent/sibling blocks for context

---

## Adding Backend Commands

If your handler needs a new Tauri command:

**1. Add Rust command:**

```rust
// src-tauri/src/commands/weather.rs
#[tauri::command]
pub async fn fetch_weather(location: String) -> Result<String, String> {
    // Implementation...
    Ok(format!("Weather in {}: Sunny, 22°C", location))
}
```

**2. Register in lib.rs:**

```rust
// src-tauri/src/lib.rs
mod commands;

// In run() function:
.invoke_handler(tauri::generate_handler![
    // ... existing commands
    commands::weather::fetch_weather,
])
```

**3. Call from handler:**

```typescript
const result = await invoke<string>('fetch_weather', { location });
```

---

## Hook Integration

Handlers can use hook-assembled context via `actions.hookContext`:

```typescript
async execute(blockId, content, actions) {
  // Context assembled by hooks (e.g., sendContextHook)
  const messages = (actions as any).hookContext?.messages;

  if (messages) {
    // Use pre-assembled conversation context
  }
}
```

To add a hook that runs before your handler, see [HOOK_PATTERNS.md](./HOOK_PATTERNS.md).

---

## Testing Handlers

```typescript
// src/lib/handlers/weather.test.ts
import { describe, it, expect, vi } from 'vitest';
import { weatherHandler } from './weather';

describe('weatherHandler', () => {
  it('creates output block with weather data', async () => {
    const actions = {
      createBlockInside: vi.fn().mockReturnValue('output-1'),
      updateBlockContent: vi.fn(),
      setBlockStatus: vi.fn(),
    };

    // Mock Tauri invoke
    vi.mock('@tauri-apps/api/core', () => ({
      invoke: vi.fn().mockResolvedValue('Sunny, 22°C'),
    }));

    await weatherHandler.execute('block-1', 'weather:: London', actions);

    expect(actions.setBlockStatus).toHaveBeenCalledWith('block-1', 'running');
    expect(actions.createBlockInside).toHaveBeenCalledWith('block-1');
    expect(actions.updateBlockContent).toHaveBeenCalledWith('output-1', 'Sunny, 22°C');
    expect(actions.setBlockStatus).toHaveBeenCalledWith('block-1', 'complete');
  });
});
```

---

## Checklist

- [ ] Create handler file in `src/lib/handlers/`
- [ ] Implement `BlockHandler` interface with `prefixes` and `execute`
- [ ] Register in `src/lib/handlers/index.ts`
- [ ] Add Tauri command if needed (Rust side)
- [ ] Handle loading states (`setBlockStatus`)
- [ ] Handle errors gracefully
- [ ] Add tests
- [ ] Update `CLAUDE.md` if handler is significant

---

## References

- Handler types: `src/lib/handlers/types.ts`
- Registry: `src/lib/handlers/registry.ts`
- Executor: `src/lib/handlers/executor.ts`
- Existing handlers: `src/lib/handlers/*.ts`
- Architecture: `docs/architecture/FLOATTY_HANDLER_REGISTRY.md`
