# Handler Registry Implementation Plan

> Consolidate handler registration from 7 files to 1-2 files

## Goal

Add `door::` or any new executable block handler by touching **1-2 files maximum**:
1. Create handler implementation file
2. Register handler in one central location

## Current Pain Points

```typescript
// Frontend: src/lib/executor.ts
const handlers: ExecutableBlockHandler[] = [
  { prefixes: ['sh::', 'term::'], execute: ... },
  { prefixes: ['ai::', 'chat::'], execute: ... },
];
```

```typescript
// Frontend: src/lib/dailyExecutor.ts (separate pattern)
export async function executeDailyBlock(...) { ... }
```

```typescript
// Frontend: src/components/BlockItem.tsx (hardcoded dispatch)
if (isDailyBlock(content)) {
  executeDailyBlock(...);
  return;
}

const handler = findHandler(content);
if (handler) {
  executeBlock(...);
  return;
}
```

```rust
// Backend: src-tauri/src/lib.rs (separate commands)
#[tauri::command]
async fn execute_shell_command(command: String) -> Result<String, String> { ... }

#[tauri::command]
async fn execute_ai_command(prompt: String) -> Result<String, String> { ... }

#[tauri::command]
async fn execute_daily_command(date_arg: String) -> Result<DailyNoteData, String> { ... }
```

**Problem**: Adding `door::` means:
- Frontend: Add to `executor.ts` handlers OR create `doorExecutor.ts`
- Frontend: Add hardcoded check in `BlockItem.tsx`
- Backend: Add `execute_door_command()` Tauri command
- Backend: Wire up in Tauri builder

## Target Architecture

### Single Registration Point (Frontend)

```typescript
// src/lib/handlers/registry.ts

export interface BlockHandler {
  prefixes: string[];
  execute: (blockId: string, content: string, actions: ExecutorActions) => Promise<void>;
}

class HandlerRegistry {
  private handlers: Map<string, BlockHandler> = new Map();

  register(handler: BlockHandler) {
    for (const prefix of handler.prefixes) {
      this.handlers.set(prefix.toLowerCase(), handler);
    }
  }

  findHandler(content: string): BlockHandler | null {
    const trimmed = content.trim().toLowerCase();
    for (const [prefix, handler] of this.handlers.entries()) {
      if (trimmed.startsWith(prefix)) {
        return handler;
      }
    }
    return null;
  }
}

export const registry = new HandlerRegistry();
```

### Unified Handler Files

```typescript
// src/lib/handlers/sh.ts
import { invoke } from '../tauriTypes';
import { parseMarkdownTree } from '../markdownParser';
import type { BlockHandler } from './registry';

export const shHandler: BlockHandler = {
  prefixes: ['sh::', 'term::'],
  
  async execute(blockId, content, actions) {
    const cmd = extractContent(content, this.prefixes);
    const outputId = actions.createBlockInside(blockId);
    actions.updateBlockContent(outputId, 'output::Running...');
    
    try {
      const result = await invoke<string>('execute_shell_command', { command: cmd });
      const parsed = parseMarkdownTree(result);
      
      if (parsed.length === 1 && parsed[0].children.length === 0) {
        actions.updateBlockContent(outputId, `output::${parsed[0].content}`);
      } else {
        actions.deleteBlock?.(outputId);
        insertParsedBlocks(blockId, parsed, actions);
      }
    } catch (err) {
      actions.updateBlockContent(outputId, `error::${err}`);
    }
  }
};
```

```typescript
// src/lib/handlers/daily.ts
import { invoke } from '../tauriTypes';
import type { BlockHandler } from './registry';

export const dailyHandler: BlockHandler = {
  prefixes: ['daily::'],
  
  async execute(blockId, content, actions) {
    const dateArg = extractContent(content, this.prefixes);
    const outputId = actions.createBlockInside(blockId);
    
    actions.updateBlockContent(outputId, 'output::Extracting...');
    // setBlockStatus is part of ExecutorActions
    
    try {
      const data = await invoke('execute_daily_command', { dateArg });
      actions.updateBlockContent(outputId, '');
      actions.setBlockOutput?.(outputId, data, 'daily-view');
    } catch (err) {
      actions.updateBlockContent(outputId, `error::${err}`);
    }
  }
};
```

```typescript
// src/lib/handlers/door.ts - NEW HANDLER EXAMPLE
import { invoke } from '../tauriTypes';
import type { BlockHandler } from './registry';

export const doorHandler: BlockHandler = {
  prefixes: ['door::'],
  
  async execute(blockId, content, actions) {
    const url = extractContent(content, this.prefixes);
    const outputId = actions.createBlockInside(blockId);
    
    actions.updateBlockContent(outputId, 'output::Opening door...');
    
    try {
      const result = await invoke<string>('execute_door_command', { url });
      actions.updateBlockContent(outputId, `output::${result}`);
    } catch (err) {
      actions.updateBlockContent(outputId, `error::${err}`);
    }
  }
};
```

### Central Registration

```typescript
// src/lib/handlers/index.ts
import { registry } from './registry';
import { shHandler } from './sh';
import { aiHandler } from './ai';
import { dailyHandler } from './daily';
import { doorHandler } from './door';  // ← Add this line only

export function registerHandlers() {
  registry.register(shHandler);
  registry.register(aiHandler);
  registry.register(dailyHandler);
  registry.register(doorHandler);  // ← Add this line only
}

export { registry };
```

### Unified Execution in BlockItem

```typescript
// src/components/BlockItem.tsx

import { registry } from '../lib/handlers';

// In handleKeyDown, Enter key:
const handler = registry.findHandler(content);
if (handler) {
  e.preventDefault();
  await handler.execute(props.id, content, {
    createBlockInside: store.createBlockInside,
    createBlockInsideAtTop: store.createBlockInsideAtTop,
    updateBlockContent: store.updateBlockContent,
    deleteBlock: store.deleteBlock,
    setBlockOutput: store.setBlockOutput,
    setBlockStatus: store.setBlockStatus,
    paneId: props.paneId,
  });
  return;
}
```

**No more hardcoded checks** - registry dispatches automatically.

### Backend: Keep Simple Commands

Backend stays simple for now (defer full Rust handler registry until server-side execution):

```rust
// src-tauri/src/lib.rs

#[tauri::command]
async fn execute_door_command(url: String) -> Result<String, String> {
    // Implementation
    Ok(format!("Opened door: {}", url))
}
```

## Migration Path

### Phase 1: Frontend Registry (1-2 days)

1. **Create registry infrastructure**
   - `src/lib/handlers/registry.ts` - Handler trait + registry
   - `src/lib/handlers/index.ts` - Registration entry point

2. **Extract existing handlers**
   - `src/lib/handlers/sh.ts` - Extract from executor.ts
   - `src/lib/handlers/ai.ts` - Extract from executor.ts
   - `src/lib/handlers/daily.ts` - Extract from dailyExecutor.ts

3. **Update BlockItem.tsx**
   - Remove hardcoded `isDailyBlock()` check
   - Remove separate `findHandler()` and `executeDailyBlock()` calls
   - Replace with single `registry.findHandler()` dispatch

4. **Initialize registry**
   - Call `registerHandlers()` in `App.tsx` or workspace context
   - Delete old `executor.ts` and `dailyExecutor.ts` files

### Phase 2: Add door:: Handler (Test Run)

```typescript
// src/lib/handlers/door.ts - NEW FILE
export const doorHandler: BlockHandler = {
  prefixes: ['door::'],
  async execute(blockId, content, actions) {
    // Implementation
  }
};
```

```typescript
// src/lib/handlers/index.ts - ONE LINE ADDED
import { doorHandler } from './door';

export function registerHandlers() {
  // ... existing handlers
  registry.register(doorHandler);  // ← Add this
}
```

```rust
// src-tauri/src/lib.rs - ADD COMMAND
#[tauri::command]
async fn execute_door_command(url: String) -> Result<String, String> {
    Ok(format!("Door opened: {}", url))
}
```

**Files touched**: 2 (new handler file + registration line)

### Phase 3: Validate Reduction

Before:
- ❌ 4+ files: executor.ts, BlockItem.tsx, lib.rs, Tauri builder

After:
- ✅ 2 files: new handler file + registration line
- ✅ Backend command still needed (deferred to server-side execution phase)

## Benefits

1. **Ceremony reduction**: 4-7 files → 2 files
2. **Pattern consistency**: All handlers follow same structure
3. **Easy discovery**: All handlers in `src/lib/handlers/` directory
4. **Type safety**: TypeScript enforces handler interface
5. **Testing**: Mock registry for unit tests
6. **Future-proof**: Portable to server-side execution

## Non-Goals (This Phase)

- ❌ Rust handler registry (deferred - see `FLOATTY_HANDLER_REGISTRY.md`)
- ❌ Auto-execute pattern (keep Enter-to-execute)
- ❌ Capability checking (future security work)
- ❌ Dynamic handler loading (built-in handlers only)

## File Structure (After)

```
src/
├── lib/
│   ├── handlers/
│   │   ├── index.ts          # Registration entry point
│   │   ├── registry.ts       # Handler trait + registry class
│   │   ├── sh.ts             # Shell handler
│   │   ├── ai.ts             # AI handler  
│   │   ├── daily.ts          # Daily note handler
│   │   └── door.ts           # Door handler (NEW)
│   ├── executor.ts           # DELETE (merged into handlers/)
│   └── dailyExecutor.ts      # DELETE (merged into handlers/daily.ts)
└── components/
    └── BlockItem.tsx         # Simplified dispatch

src-tauri/src/
└── lib.rs                    # Tauri commands (unchanged for now)
```

## Open Questions

1. **Auto-execute pattern**: Should some handlers (daily::) auto-execute on content change?
   - **Decision**: Defer to separate FLO ticket (needs local modification tracking)

2. **setBlockOutput/setBlockStatus**: These aren't on all handlers - optional in actions?
   - **Decision**: Add as optional to ExecutorActions interface

3. **TV variables**: Should registry handle `$tv()` resolution?
   - **Decision**: Keep in sh/ai handlers for now (domain-specific)

4. **Structured output**: daily:: uses setBlockOutput, others use text
   - **Decision**: Handler decides output format (flexibility)

## Success Criteria

- [ ] All existing handlers (sh::, ai::, daily::) work identically
- [ ] Adding `door::` handler touches exactly 2 files
- [ ] No functionality regression (tests pass)
- [ ] BlockItem.tsx has single dispatch path
- [ ] Old executor.ts/dailyExecutor.ts files deleted

## Timeline

- **Phase 1 (Frontend Registry)**: 1-2 days
- **Phase 2 (Test with door::)**: 1 hour
- **Phase 3 (Validation)**: 1 hour

**Total**: ~2-3 days of focused work

## Related

- `docs/architecture/FLOATTY_HANDLER_REGISTRY.md` - Full Rust registry (future)
- `docs/BLOCK_TYPE_PATTERNS.md` - Pattern documentation
- `docs/EXTERNAL_BLOCK_EXECUTION.md` - Auto-execute patterns
- `ARCHITECTURE_REVIEW_2026_01_08.md` - Tonight's stress test findings
