# Floatty Hook System Design

> Extracted from architecture session 2026-01-04. Hooks for block lifecycle events.

## The Core Pattern

Every executable block has the same shape of concerns:

```
╭─────────────────────────────────────────────────────────────────╮
│                                                                  │
│  BLOCK CONTENT                                                   │
│       ↓                                                          │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │  BEFORE HOOKS                                                │ │
│  │  ├─ Validation (can this run?)                              │ │
│  │  ├─ Transformation (change the input)                       │ │
│  │  ├─ Context injection (add info handler doesn't have)       │ │
│  │  └─ Side effects (log, notify, etc.)                        │ │
│  └─────────────────────────────────────────────────────────────┘ │
│       ↓                                                          │
│  HANDLER EXECUTES                                                │
│       ↓                                                          │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │  AFTER HOOKS                                                 │ │
│  │  ├─ Output transformation (parse, format)                   │ │
│  │  ├─ Side effects (index, cache, notify)                     │ │
│  │  └─ Follow-up actions (create additional blocks)            │ │
│  └─────────────────────────────────────────────────────────────┘ │
│       ↓                                                          │
│  OUTPUT BLOCK CREATED                                            │
│                                                                  │
╰─────────────────────────────────────────────────────────────────╯
```

---

## Hook Interface

```typescript
interface Hook {
  id: string;
  event: HookEvent | HookEvent[];
  filter: (block: Block) => boolean;  // Only run for matching blocks
  priority: number;                    // Lower = earlier
  handler: (ctx: HookContext) => HookResult;
}

type HookEvent = 
  | 'block:create'
  | 'block:update' 
  | 'block:delete'
  | 'execute:before'
  | 'execute:after';

interface HookContext {
  block: Block;
  content: string;
  event: HookEvent;
  store: BlockStore;
  // For execute:after
  result?: HandlerOutput;
  error?: string;
}

interface HookResult {
  // Modify the content before execution
  content?: string;
  // Inject context for handler
  context?: ExecutionContext;
  // Abort execution with reason
  abort?: boolean;
  reason?: string;
  // Continue normally
}
```

---

## Concrete Use Cases

### 1. AI Context Assembly (Primary Use Case)

Multi-turn conversation support for `ai::` blocks:

```typescript
registerHook({
  id: 'ai-context-assembly',
  event: 'execute:before',
  filter: (block) => block.type === 'ai',
  priority: 0,
  
  handler: (ctx) => {
    // Walk up tree to find conversation root
    const conversationRoot = findConversationRoot(ctx.block, ctx.store);
    
    // Extract turns from ## N - role: pattern
    const turns = extractTurns(conversationRoot, ctx.store);
    
    // Resolve [[references]] into actual content
    const references = resolveReferences(ctx.content, ctx.store);
    
    // Apply TTL filtering (some refs expire after N turns)
    const filtered = applyTTL(references, turns.length);
    
    return {
      context: {
        messages: buildMessages(turns, filtered),
        systemPrompt: findSystemPrompt(ctx.block, ctx.store),
        turnCount: turns.length,
      }
    };
  }
});
```

**What this enables**: When you type `ai:: explain this further` in a multi-turn conversation, the hook automatically builds the full message array with conversation history.

### 2. Shell Command Validation

Prevent dangerous commands:

```typescript
registerHook({
  id: 'sh-danger-check',
  event: 'execute:before',
  filter: (block) => block.type === 'sh',
  priority: -10,  // Run very early
  
  handler: (ctx) => {
    const dangerous = [
      'rm -rf /',
      'dd if=',
      ':(){ :|:& };:',
      'mkfs.',
    ];
    
    for (const pattern of dangerous) {
      if (ctx.content.includes(pattern)) {
        return { 
          abort: true, 
          reason: `Blocked dangerous pattern: ${pattern}` 
        };
      }
    }
    return {};
  }
});
```

### 3. Wikilink Indexing (On Any Block)

Update backlinks index when blocks are created/deleted:

```typescript
registerHook({
  id: 'wikilink-index-create',
  event: 'block:create',
  filter: (block) => block.content.includes('[['),
  
  handler: (ctx) => {
    const links = extractWikilinks(ctx.block.content);
    for (const link of links) {
      wikilinkIndex.register(link.target, ctx.block.id);
    }
    return {};
  }
});

registerHook({
  id: 'wikilink-index-delete',
  event: 'block:delete',
  filter: (block) => block.content.includes('[['),
  
  handler: (ctx) => {
    wikilinkIndex.removeBlockReferences(ctx.block.id);
    return {};
  }
});
```

**What this enables**: FLO-113's LinkedReferences could be powered by hooks instead of special-cased rendering logic.

### 4. ctx:: Timeline Indexing

Make temporal markers queryable:

```typescript
registerHook({
  id: 'ctx-timeline',
  event: 'block:create',
  filter: (block) => block.type === 'ctx',
  
  handler: (ctx) => {
    const timestamp = parseCtxTimestamp(ctx.block.content);
    const markers = extractMarkers(ctx.block.content);
    
    timelineIndex.add({
      blockId: ctx.block.id,
      timestamp,
      project: markers.project,
      mode: markers.mode,
    });
    return {};
  }
});
```

### 5. Execution Logging

Audit trail for all executable blocks:

```typescript
registerHook({
  id: 'execution-logger',
  event: ['execute:before', 'execute:after'],
  filter: (block) => ['sh', 'ai', 'daily'].includes(block.type),
  priority: 100,  // Run late
  
  handler: (ctx) => {
    if (ctx.event === 'execute:before') {
      console.log(`[${ctx.block.type}] Starting: ${ctx.content.slice(0, 50)}...`);
    } else {
      console.log(`[${ctx.block.type}] Complete: ${ctx.result?.length || 0} chars`);
    }
    return {};
  }
});
```

### 6. Outbound Webhooks

Notify external systems after execution:

```typescript
registerHook({
  id: 'webhook-dispatch',
  event: 'execute:after',
  filter: (block) => block.type === 'dispatch',
  priority: 50,
  
  handler: async (ctx) => {
    const webhooks = getWebhooksFor(ctx.block);
    for (const webhook of webhooks) {
      await fetch(webhook.url, {
        method: 'POST',
        body: JSON.stringify({
          blockId: ctx.block.id,
          result: ctx.result,
        }),
      });
    }
    return {};
  }
});
```

### 7. Token Estimation (AI Cost Awareness)

Warn before expensive API calls:

```typescript
registerHook({
  id: 'ai-token-estimate',
  event: 'execute:before',
  filter: (block) => block.type === 'ai',
  priority: 10,  // After context assembly
  
  handler: (ctx) => {
    if (!ctx.context?.messages) return {};
    
    const tokens = estimateTokens(ctx.context.messages);
    if (tokens > 50000) {
      console.warn(`Large context: ~${tokens} tokens`);
      // Could prompt for confirmation here
    }
    return {};
  }
});
```

---

## Block Lifecycle Events

Beyond execution, blocks have lifecycle hooks:

### Block Created

```typescript
event: 'block:create'
// Triggers:
// - Wikilink detection and indexing
// - Parent context inheritance
// - Webhook notifications
// - Auto-execute for external blocks (the spike we built)
```

### Block Content Changed

```typescript
event: 'block:update'
// Triggers:
// - Re-parse type (already happens)
// - Re-index wikilinks
// - Validate content
// - Auto-format
```

### Block Deleted

```typescript
event: 'block:delete'
// Triggers:
// - Clean up backlinks index
// - Archive instead of delete (soft delete)
// - Cascade notifications
```

---

## The Auto-Execute Hook (Already Implemented)

The spike from this session IS a hook:

```typescript
// Currently in useBlockStore.ts, but logically:
registerHook({
  id: 'auto-execute-external',
  event: 'block:create',
  filter: (block) => isExecutable(block.content) && isExternal(block),
  
  handler: (ctx) => {
    // Trigger execution for externally-created executable blocks
    executeBlock(ctx.block.id, ctx.content);
    return {};
  }
});
```

**The heuristic**: Local creates use empty content (you type into blank block). API creates arrive with content populated. Non-empty + executable = external origin = auto-execute.

---

## Implementation Considerations

### Where Hooks Run

**Today (Tauri/Frontend)**:
- Hooks run in the SolidJS frontend
- Execution hooks wrap Tauri command calls
- Lifecycle hooks are Y.Doc observers

**Tomorrow (Server-side)**:
- Hooks become Tower middleware/layers
- Same hook logic, different runtime
- Consistent behavior across all clients

### Hook Registry

```typescript
class HookRegistry {
  private hooks: Map<HookEvent, Hook[]> = new Map();
  
  register(hook: Hook) {
    const events = Array.isArray(hook.event) ? hook.event : [hook.event];
    for (const event of events) {
      const hooks = this.hooks.get(event) || [];
      hooks.push(hook);
      hooks.sort((a, b) => a.priority - b.priority);
      this.hooks.set(event, hooks);
    }
  }
  
  async run(event: HookEvent, ctx: HookContext): Promise<HookResult> {
    const hooks = this.hooks.get(event) || [];
    let accumulated: HookResult = {};
    
    for (const hook of hooks) {
      if (!hook.filter(ctx.block)) continue;
      
      const result = await hook.handler({ ...ctx, ...accumulated });
      
      if (result.abort) {
        return result;  // Early exit
      }
      
      accumulated = { ...accumulated, ...result };
    }
    
    return accumulated;
  }
}
```

### Priority Conventions

| Range | Use |
|-------|-----|
| -100 to -1 | Security/validation (run first) |
| 0 to 49 | Context assembly, transformation |
| 50 to 99 | Standard processing |
| 100+ | Logging, cleanup (run last) |

---

## The AI Context Assembly Hook (Detail)

This is the most complex hook. Full implementation:

### Turn Extraction

Parses `## N - role:` headings to build conversation history:

```typescript
function extractTurns(root: Block, store: BlockStore): Turn[] {
  const turns: Turn[] = [];
  
  for (const childId of root.childIds) {
    const child = store.getBlock(childId);
    if (!child) continue;
    
    // Match ## 1 - evan: or ## 2 - assistant:
    const match = child.content.match(/^##\s*(\d+)\s*-\s*(\w+):/);
    if (match) {
      turns.push({
        number: parseInt(match[1]),
        role: match[2],
        content: extractTurnContent(child, store),
      });
    }
  }
  
  return turns.sort((a, b) => a.number - b.number);
}
```

### Reference Resolution

Resolves `[[wikilinks]]` into actual content:

```typescript
function resolveReferences(content: string, store: BlockStore): Reference[] {
  const refs: Reference[] = [];
  const pattern = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
  
  let match;
  while ((match = pattern.exec(content)) !== null) {
    const target = match[1];
    const options = parseOptions(match[2]);  // e.g., ttl:3, depth:2
    
    const page = findPage(target, store);
    if (page) {
      refs.push({
        target,
        content: extractContent(page, options.depth || 1),
        ttl: options.ttl,
      });
    }
  }
  
  return refs;
}
```

### TTL System

Temporal context windowing - references expire after N turns:

```typescript
function applyTTL(refs: Reference[], currentTurn: number): Reference[] {
  return refs.filter(ref => {
    if (!ref.ttl) return true;  // No TTL = always include
    return ref.turnAdded + ref.ttl >= currentTurn;
  });
}
```

### Message Building

Assembles the final API request:

```typescript
function buildMessages(turns: Turn[], refs: Reference[]): Message[] {
  const messages: Message[] = [];
  
  // System context from resolved references
  if (refs.length > 0) {
    messages.push({
      role: 'system',
      content: refs.map(r => `## ${r.target}\n${r.content}`).join('\n\n'),
    });
  }
  
  // Conversation history
  for (const turn of turns) {
    messages.push({
      role: turn.role === 'assistant' ? 'assistant' : 'user',
      content: turn.content,
    });
  }
  
  return messages;
}
```

---

## References

- Handler Registry: `FLOATTY_HANDLER_REGISTRY.md`
- Multi-Client Architecture: `FLOATTY_MULTI_CLIENT_ARCHITECTURE.md`
- FLOAT Block V2.3 (Drafts): Production implementation of TTL, turn extraction
- Session transcript: `/mnt/transcripts/2026-01-04-23-17-20-float-architecture-synthesis-jan2026.txt`
