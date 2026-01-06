# External Block Execution

> Spike completed 2026-01-04. Desktop app as execution daemon.

## What We Built

Blocks created via API (by kitty, cowboy, or any HTTP client) auto-execute when they appear in the outliner.

```
╭─────────────────────────────────────────────────────────────────╮
│  COWBOY (Claude Code session)                                   │
│                                                                  │
│  POST /api/v1/blocks                                            │
│    { content: "daily::2026-01-04", parentId: null }             │
│                                                                  │
╰───────────────────────────┬─────────────────────────────────────╯
                            ↓
╭─────────────────────────────────────────────────────────────────╮
│  floatty-server (Y.Doc sync)                                    │
│                                                                  │
│  Block added to Y.Doc → broadcasts to connected clients         │
│                                                                  │
╰───────────────────────────┬─────────────────────────────────────╯
                            ↓
╭─────────────────────────────────────────────────────────────────╮
│  DESKTOP APP (watching Y.Doc)                                   │
│                                                                  │
│  Observer sees: change.action === 'add'                         │
│  Content is non-empty + executable pattern                      │
│  → Must be external (local creates use empty content)           │
│  → Auto-execute via existing Tauri path                         │
│  → Output block created → syncs back to Y.Doc                   │
│                                                                  │
╰───────────────────────────┬─────────────────────────────────────╯
                            ↓
╭─────────────────────────────────────────────────────────────────╮
│  COWBOY (watching)                                              │
│                                                                  │
│  Sees output block appear                                        │
│  Reads result                                                    │
│  Done.                                                           │
│                                                                  │
╰─────────────────────────────────────────────────────────────────╯
```

## How It Works (Current Implementation)

### Detection Layer (`useBlockStore.ts`)

Y.Doc observer watches for block additions:

```typescript
if (path.length === 0 && event instanceof Y.YMapEvent) {
  event.changes.keys.forEach((change, key) => {
    if (change.action === 'add') {
      blocksToRefresh.add(key);

      // AUTO-EXECUTE: Block added with executable content = external origin
      // Local creates use empty content, so non-empty + executable = API/sync
      if (_autoExecuteHandler) {
        const blockData = blocksMap.get(key);
        const content = getValue(blockData, 'content') as string;
        if (content && isAutoExecutable(content)) {
          setTimeout(() => _autoExecuteHandler!(key, content), 0);
        }
      }
    }
  });
}
```

**The Heuristic**: Local `createBlockAfter()` creates blocks with empty content. API creates blocks with content already set. Non-empty + executable pattern = external origin.

### Wiring Layer (`WorkspaceContext.tsx`)

Handler registration on mount:

```typescript
onMount(() => {
  setAutoExecuteHandler((blockId: string, content: string) => {
    console.log('[AutoExecute] External block detected:', blockId, content);

    if (isDailyBlock(content)) {
      executeDailyBlock(blockId, content, {
        createBlockInside: store.createBlockInside,
        updateContent: store.updateBlockContent,
        setBlockOutput: store.setBlockOutput,
        setBlockStatus: store.setBlockStatus,
        deleteBlock: store.deleteBlock,
        getBlock: store.getBlock,
      });
    }
    // Future: handle other auto-executable types
  });
});
```

### Auto-Executable Types (`useBlockStore.ts`)

Only idempotent view blocks auto-execute:

```typescript
function isAutoExecutable(content: string): boolean {
  // Only auto-execute idempotent view blocks, not side-effect ones like sh::
  return isDailyBlock(content);
  // Future: add web::, query::, embed::, etc.
}
```

**NOT auto-executable** (require Enter):
- `sh::` - runs shell commands (side effects!)
- `ai::` - expensive API calls
- `dispatch::` - triggers agent actions

---

## The Architecture Direction

### What This Pattern Reveals

The desktop app is an **execution daemon that happens to have a UI**.

```
╭─────────────────────────────────────────────────────────────────╮
│  floatty-server: data substrate (Y.Doc sync)                    │
│  floatty-desktop: execution engine + UI                         │
│  other clients: read/write/watch, execution via desktop         │
╰─────────────────────────────────────────────────────────────────╯
```

### What Stays Client-Side (Probably Forever)

- Terminal emulator (float-pty) - local UI
- File picker dialogs - native OS integration
- Keyboard shortcuts - client concern
- Window management - client concern
- The UI rendering itself

### What Could Move to Server (When Needed)

- Block execution (for headless operation)
- Hook system (for server-side middleware)
- Webhook endpoints (for external integrations)

### The Incremental Path

```
╭─────────────────────────────────────────────────────────────────╮
│  DONE: Auto-execute via Y.Doc observer                          │
│        - External blocks trigger execution                       │
│        - Kitty/cowboy unblocked for daily:: blocks              │
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│  NEXT: Handler registry (Tauri)                                  │
│        - Reduce 7-file ceremony to 1-2 files                    │
│        - Extract sh/ai/daily into handler trait                 │
│        - Cleaner internals, same behavior                       │
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│  THEN: Context assembly hook                                     │
│        - ai:: blocks get conversation context                   │
│        - Turn extraction, reference resolution                  │
│        - Works regardless of trigger source                     │
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│  IF NEEDED: Server-side execution                               │
│        - POST /execute endpoint                                  │
│        - For headless operation                                  │
│        - For when desktop isn't running                         │
│        - Handlers already portable (trait-based)                │
│                                                                  │
╰─────────────────────────────────────────────────────────────────╯
```

---

## Using This From Agents

### Create and Auto-Execute

```bash
# Cowboy creates a daily:: block
curl -s -X POST "http://localhost:8765/api/v1/blocks" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $FLOATTY_API_KEY" \
  -d '{"content": "daily::2026-01-04", "parentId": null}'

# Desktop auto-executes, output block appears
# Poll or WebSocket to see result
```

### Read the Output

```bash
# Get the parent block to find output child
curl -s "http://localhost:8765/api/v1/blocks/$BLOCK_ID" \
  -H "Authorization: Bearer $FLOATTY_API_KEY" | jq '.childIds[0]'

# Read the output block
curl -s "http://localhost:8765/api/v1/blocks/$OUTPUT_ID" \
  -H "Authorization: Bearer $FLOATTY_API_KEY"
```

### API Key Location

```bash
# API key is in ~/.floatty/config.toml
grep api_key ~/.floatty/config.toml
```

---

## The Principle

> Build interfaces that travel. Don't build the destination yet.

The handler trait we design now should work in Tauri today and Axum tomorrow. The hook system should run client-side now and as Tower middleware later. The shapes cross IPC today and HTTP tomorrow.

**Shacks, not cathedrals.** Walls that can move.

---

## Files Changed (This Spike)

| File | Change |
|------|--------|
| `src/hooks/useBlockStore.ts` | Added `setAutoExecuteHandler`, detection in observer |
| `src/context/WorkspaceContext.tsx` | Wired handler on mount, added `setBlockOutput`/`setBlockStatus` to interface |
| `src/hooks/useBlockOperations.ts` | Added `isEditableBlock`, navigation skips output blocks |

## Backlog Ideas

### Metadata Caching for Idempotent Blocks (FLO-115)

Store execution results in block metadata with timestamp for cache invalidation:

```typescript
block.metadata = {
  lastExecuted: "2026-01-04T18:15:00Z",
  cachedOutput: { ... },  // The daily note data, etc.
  ttl: 3600,              // Seconds until stale
}
```

**Benefits:**
- Skip re-execution if cache fresh
- Instant render on app load
- Reduce Ollama/API calls for daily::, weather::, etc.

**When to invalidate:**
- TTL expired
- User explicitly re-executes (Enter)
- Source file changed (for daily::, the markdown file)

---

## Related

- `docs/BLOCK_TYPE_PATTERNS.md` - Child-output pattern documentation
- `docs/RECON_BLOCK_SYSTEM.md` - Full block system architecture recon
- `docs/architecture/` - Handler registry, hook system, multi-client roadmap
- FLO-113 - Wikilinks (just shipped)
- FLO-115 - Metadata caching (backlog)
- PR #60 - daily:: focus loss fix
