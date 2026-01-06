# Floatty Multi-Client Architecture

> Extracted from architecture session 2026-01-04. Desktop as execution daemon, agents as first-class clients.

## The Insight

The headless migration created `floatty-server` for Y.Doc sync. But any client can create blocks - they just couldn't *execute* them. The spike validated that **the desktop app can be an execution daemon** that watches Y.Doc and auto-executes external blocks.

```
╭─────────────────────────────────────────────────────────────────╮
│  floatty-server: data substrate (Y.Doc sync)                    │
│  floatty-desktop: execution engine + UI                         │
│  other clients: read/write/watch, execution via desktop         │
╰─────────────────────────────────────────────────────────────────╯
```

---

## Current State (Post-Spike)

### What Works Now

```
┌─────────────────────────────────────────────────────────────────┐
│  COWBOY (Claude Code session)                                   │
│                                                                  │
│  POST /api/v1/blocks                                            │
│    { content: "daily::2026-01-04", parentId: null }             │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
                            │
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│  floatty-server (Y.Doc sync)                                    │
│                                                                  │
│  Block added to Y.Doc → broadcasts to connected clients         │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
                            │
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│  DESKTOP APP (watching Y.Doc)                                   │
│                                                                  │
│  Observer sees: change.action === 'add'                         │
│  Content is non-empty + executable pattern                      │
│  → Must be external (local creates use empty content)           │
│  → Auto-execute via existing Tauri path                         │
│  → Output block created → syncs back to Y.Doc                   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
                            │
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│  COWBOY (watching or polling)                                   │
│                                                                  │
│  Sees output block appear                                        │
│  Reads result                                                    │
│  Done.                                                           │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Validated Via Spike

```bash
# Cowboy created a daily:: block via API
curl -s -X POST "http://localhost:8765/api/v1/blocks" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $FLOATTY_API_KEY" \
  -d '{"content": "daily::2026-01-02", "parentId": null}'

# Block appeared in desktop, auto-executed, daily view rendered
```

**The heuristic**: Local creates use empty content. API creates arrive with content populated. Non-empty + executable = external origin = auto-execute.

---

## Auto-Execute Classification

| Block Type | Auto-Execute? | Reason |
|------------|---------------|--------|
| `daily::` | ✓ Yes | Idempotent (same date = same result) |
| `web::` | ✓ Yes | Idempotent |
| `query::` | ✓ Yes | Read-only |
| `sh::` | ✗ No (Enter required) | Side effects |
| `ai::` | ✗ No (Enter required) | Expensive, side effects |
| `dispatch::` | ✗ No (Enter required) | Triggers actions |

Future: Could add explicit markers (`sh::!` = force auto-execute) for advanced use cases.

---

## The Clients

### Desktop App (Primary)

- Full UI with outliner, split panes, keyboard navigation
- Execution engine (all handlers run here)
- Y.Doc sync via HTTP + WebSocket
- Currently the only execution surface

### Kitty/Cowboy (Claude Code Sessions)

Already can:
- `GET /api/v1/blocks` - read the outline
- `POST /api/v1/blocks` - create blocks (triggers auto-execute for idempotent types)
- `PATCH /api/v1/blocks/:id` - update blocks
- `DELETE /api/v1/blocks/:id` - delete blocks
- Connect to WebSocket for real-time sync

Near-term workflow:
```
1. "Look at my outline in floatty, find the block about X"
2. "Create a daily:: block for yesterday"
3. [Auto-executes, output appears]
4. "Read the result and summarize"
```

### CLI (floatctl)

Potential commands:
```bash
floatctl blocks list
floatctl blocks create "daily::2026-01-04" --parent root
floatctl blocks read <block-id>
floatctl blocks watch  # Stream changes
```

Implementation: HTTP client to floatty-server. Execution via auto-execute.

### nvim / VS Code Plugins

- Edit blocks in native editor
- Create executable blocks
- Execution via desktop (requires app running)
- Y.Doc sync for real-time collaboration

### External Agents

Any HTTP client can participate:
- evna MCP server
- GitHub Actions
- Cron jobs
- Webhooks

---

## Inbound Webhooks

External events → floatty blocks:

```
┌─────────────────────────────────────────────────────────────────┐
│  GITHUB                                                          │
│                                                                  │
│  POST /webhooks/github { event: "push", ... }                   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
                            │
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│  floatty-server                                                  │
│                                                                  │
│  Webhook handler creates block:                                  │
│  { content: "notification:: PR #123 merged", ... }              │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
                            │
                            ↓
                  (syncs to all clients)
```

Could also trigger execution:
```
notification:: PR #123 merged
→ Creates ai:: block to summarize changes
→ Desktop auto-executes (or not, based on type)
```

---

## Outbound Webhooks

Block execution → external notifications:

```typescript
// As an after-hook on execution
registerHook({
  id: 'outbound-webhook',
  event: 'execute:after',
  filter: (block) => hasWebhookConfig(block),
  
  handler: async (ctx) => {
    const webhooks = getOutboundWebhooks(ctx.block);
    for (const url of webhooks) {
      await fetch(url, {
        method: 'POST',
        body: JSON.stringify({
          blockId: ctx.block.id,
          type: ctx.block.type,
          result: ctx.result,
        }),
      });
    }
    return {};
  }
});
```

---

## Server-Side Execution (If Needed)

The current architecture (desktop as execution daemon) works when:
- Desktop app is running
- Only one "executor" is needed
- You're on the same machine

For headless execution:

```rust
// floatty-server/src/api.rs

#[derive(Deserialize)]
struct ExecuteRequest {
    block_id: String,
}

async fn execute_block(
    State(state): State<AppState>,
    Json(req): Json<ExecuteRequest>,
) -> Result<Json<ExecuteResponse>> {
    // Get block from Y.Doc
    let block = state.store.get_block(&req.block_id)?;
    
    // Find handler
    let handler = state.registry.get(&block.block_type())?;
    
    // Run hooks
    let ctx = state.hooks.run_before(&block)?;
    
    // Execute
    let result = handler.execute(&block.content, ctx).await?;
    
    // Run after hooks
    state.hooks.run_after(&block, &result)?;
    
    // Create output block
    let output_id = state.store.create_child(&block.id, result)?;
    
    Ok(Json(ExecuteResponse { output_id, result }))
}
```

**When to add this**:
- CI/CD pipelines need to execute blocks
- Scheduled execution (cron)
- Desktop app not always running
- Multiple execution surfaces needed

**The handler trait is portable**: Same code runs in Tauri or Axum.

---

## MCP Integration

floatty could expose MCP tools:

```yaml
tools:
  - floatty_read_block:
      description: Read a block by ID
      params: { block_id: string }
      
  - floatty_create_block:
      description: Create a new block
      params: { content: string, parent_id?: string }
      
  - floatty_execute_block:
      description: Execute a block (requires desktop running)
      params: { block_id: string }
      
  - floatty_find_blocks:
      description: Find blocks by type or content
      params: { type?: string, contains?: string }
      
  - floatty_get_conversation:
      description: Get assembled context for an ai:: block
      params: { block_id: string }
```

Then any MCP client (Claude Desktop, Claude Code) can interact with floatty natively.

---

## API Reference

### Existing Endpoints (floatty-server)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/v1/health` | GET | Health check |
| `/api/v1/state` | GET | Full Y.Doc state (base64) |
| `/api/v1/state-vector` | GET | State vector for reconciliation |
| `/api/v1/update` | POST | Apply Y.Doc update |
| `/api/v1/blocks` | GET | All blocks as JSON |
| `/api/v1/blocks/:id` | GET | Single block |
| `/api/v1/blocks` | POST | Create block |
| `/api/v1/blocks/:id` | PATCH | Update content |
| `/api/v1/blocks/:id` | DELETE | Delete block + subtree |
| `/ws` | WebSocket | Real-time Y.Doc sync |

### Future Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/v1/execute` | POST | Execute a block (server-side) |
| `/api/v1/webhooks/:id` | POST | Inbound webhook handler |
| `/api/v1/hooks` | GET | List registered hooks |

### Authentication

```bash
# API key in header
curl -H "Authorization: Bearer $FLOATTY_API_KEY" ...

# Key location
~/.floatty/config.toml
```

---

## The Incremental Path

```
╭─────────────────────────────────────────────────────────────────╮
│  DONE: Y.Doc sync (floatty-server)                              │
│  DONE: Auto-execute spike for external blocks                   │
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│  NEXT: Handler registry (cleaner internals)                     │
│  NEXT: Context assembly hook (ai:: conversations)               │
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│  WHEN NEEDED:                                                    │
│  - Server-side execution (POST /execute)                        │
│  - MCP tool exposure                                             │
│  - Inbound/outbound webhooks                                    │
│  - floatctl CLI                                                  │
╰─────────────────────────────────────────────────────────────────╯
```

---

## The Principle

> "Build interfaces that travel. Don't build the destination yet."

- Handler trait works in Tauri today, Axum tomorrow
- Hook system runs client-side now, as Tower middleware later
- Request/response shapes cross IPC today, HTTP tomorrow
- The migration is mechanical, not architectural

**Shacks, not cathedrals.** Walls that can move.

---

## References

- Handler Registry: `FLOATTY_HANDLER_REGISTRY.md`
- Hook System: `FLOATTY_HOOK_SYSTEM.md`
- External Execution Spike: `docs/EXTERNAL_BLOCK_EXECUTION.md`
- Headless Architecture: `docs/HEADLESS_ARCHITECTURE.md`
- Session transcript: `/mnt/transcripts/2026-01-04-23-17-20-float-architecture-synthesis-jan2026.txt`
