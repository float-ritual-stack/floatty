# Floatty Multi-Client Architecture

> Desktop as execution daemon, agents as first-class clients.

---

## Implementation Status (2026-01-15)

```
╭─────────────────────────────────────────────────────────────────╮
│  DONE                                                            │
├─────────────────────────────────────────────────────────────────┤
│  ✅ Y.Doc sync (floatty-server)                                  │
│  ✅ REST API for block CRUD                                      │
│  ✅ WebSocket real-time sync                                     │
│  ✅ Auto-execute for idempotent blocks (daily::, search::)       │
│  ✅ Handler registry (TypeScript, frontend)                      │
│  ✅ Hook system (execute:before/after)                           │
│  ✅ Context assembly hook (sendContextHook)                      │
│  ✅ Server-side hooks (Rust: MetadataHook, TantivyIndexHook)     │
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│  CURRENT GAP                                                     │
├─────────────────────────────────────────────────────────────────┤
│  ⏳ Execution routing - handlers are frontend-only               │
│     CLI/agents can create blocks but can't execute without       │
│     desktop running                                              │
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│  NEXT: Coordination Protocol                                     │
├─────────────────────────────────────────────────────────────────┤
│  • POST /api/v1/execute endpoint                                 │
│  • WebSocket claim/result messages                               │
│  • First-claim-wins execution routing                            │
│  • Desktop claims and executes (no handler changes needed)       │
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│  FUTURE                                                          │
├─────────────────────────────────────────────────────────────────┤
│  • Server-side handlers for simple cases (sh::, ai::)            │
│  • MCP tool exposure                                             │
│  • Inbound/outbound webhooks                                     │
│  • floatctl CLI                                                  │
╰─────────────────────────────────────────────────────────────────╯
```

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                     CLIENT HOOK SYSTEM                           │
│                    (TypeScript, per-client)                      │
│                                                                  │
│  Desktop: hookRegistry.ts, handlers/*.ts                         │
│  Concerns: UI, optimistic updates, execute:before/after          │
└─────────────────────────────────────────────────────────────────┘
                              │
                    ┌─────────┴─────────┐
                    │   Coordination    │
                    │   Protocol        │
                    │  (WebSocket/HTTP) │
                    └─────────┬─────────┘
                              │
┌─────────────────────────────────────────────────────────────────┐
│                     SERVER (floatty-server)                      │
│                                                                  │
│  • Y.Doc sync (authoritative state)                              │
│  • REST API (blocks CRUD)                                        │
│  • Server hooks (Rust: indexing, metadata extraction)            │
│  • Execution routing (routes to capable client)                  │
└─────────────────────────────────────────────────────────────────┘
```

**Key insight from LSP**: Don't embed server logic in client. Define protocols. Client and server hooks don't share code - they share message formats.

---

## Current Flow: External Block Creation

```
┌─────────────────────────────────────────────────────────────────┐
│  AGENT / CLI / MCP                                               │
│                                                                  │
│  POST /api/v1/blocks                                            │
│    { content: "daily::2026-01-15", parentId: null }             │
└─────────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│  floatty-server                                                  │
│                                                                  │
│  Block added to Y.Doc → broadcasts to connected clients         │
└─────────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│  DESKTOP APP (watching Y.Doc)                                   │
│                                                                  │
│  Observer sees: origin === 'remote' + executable pattern        │
│  → Auto-execute via TypeScript handler                          │
│  → Output block created → syncs back to Y.Doc                   │
└─────────────────────────────────────────────────────────────────┘
```

**Limitation**: Desktop must be running. Non-idempotent blocks (sh::, ai::) require Enter key.

---

## Next: Coordination Protocol

Enable any client to request execution, routed to a capable executor.

### Message Types

```rust
/// Messages FROM clients TO server
enum ClientMessage {
    /// "I want this block executed" (from CLI, agent, API)
    ExecuteRequest {
        block_id: String,
        request_id: String,
    },

    /// "I'll handle this execution" (from desktop, capable client)
    ExecuteClaim {
        block_id: String,
        request_id: String,
        client_id: String,
    },

    /// "Here's the result"
    ExecuteResult {
        block_id: String,
        request_id: String,
        result: ExecuteOutput,
    },
}

/// Messages FROM server TO clients
enum ServerMessage {
    /// "Someone wants this executed, who can handle it?"
    ExecuteAvailable {
        block_id: String,
        request_id: String,
        block_type: String,
        timeout_ms: u64,
    },

    /// "This execution was claimed"
    ExecuteClaimed {
        block_id: String,
        request_id: String,
        client_id: String,
    },

    /// "Execution complete"
    ExecuteComplete {
        block_id: String,
        request_id: String,
        result: ExecuteOutput,
    },
}

struct ExecuteOutput {
    content: String,
    output_type: Option<String>,  // "success", "error"
    metadata: Option<Value>,
}
```

### Flow: CLI Requests Execution

```
┌─────────────────────────────────────────────────────────────────┐
│  CLI / Agent                                                     │
│                                                                  │
│  POST /api/v1/execute { block_id: "abc123" }                    │
└─────────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│  floatty-server (ExecutionCoordinator)                          │
│                                                                  │
│  1. Store pending request                                        │
│  2. Broadcast ExecuteAvailable to all clients                   │
│  3. Wait for claim + result (or timeout)                        │
└─────────────────────────────────────────────────────────────────┘
                            │
              ┌─────────────┴─────────────┐
              ▼                           ▼
┌──────────────────────┐     ┌──────────────────────┐
│  Desktop (capable)   │     │  Other Client        │
│                      │     │  (no sh:: handler)   │
│  Sees ExecuteAvailable│    │                      │
│  Has handler for sh:: │    │  Ignores             │
│  Sends ExecuteClaim   │    │                      │
└──────────────────────┘     └──────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Desktop executes using existing TypeScript handler              │
│                                                                  │
│  const result = await executeBlock(block);                      │
│  ws.send({ type: 'ExecuteResult', ... });                       │
└─────────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│  floatty-server                                                  │
│                                                                  │
│  1. Receives ExecuteResult                                       │
│  2. Creates output block in Y.Doc                               │
│  3. Returns result to original HTTP request                     │
└─────────────────────────────────────────────────────────────────┘
```

### API Endpoint

```rust
/// POST /api/v1/execute
///
/// Request block execution. Routes to a capable client.
/// Returns when execution completes or times out.

#[derive(Deserialize)]
struct ExecuteRequest {
    block_id: String,
    #[serde(default = "default_timeout")]
    timeout_ms: u64,  // Default: 30000
}

#[derive(Serialize)]
struct ExecuteResponse {
    output: String,
    output_type: Option<String>,
    output_block_id: Option<String>,
}
```

### Usage Examples

**CLI:**
```bash
# Create block
BLOCK_ID=$(curl -X POST http://localhost:8765/api/v1/blocks \
  -H "Authorization: Bearer $KEY" \
  -d '{"content": "sh:: ls -la"}' | jq -r '.id')

# Request execution (routes to desktop)
curl -X POST http://localhost:8765/api/v1/execute \
  -H "Authorization: Bearer $KEY" \
  -d "{\"block_id\": \"$BLOCK_ID\"}"
# Returns: {"output": "total 42\n...", "output_type": "success"}
```

**Agent SDK:**
```typescript
const block = await floatty.createBlock({
  content: 'ai:: Summarize the last 3 daily notes',
});

// Routes through server → desktop → result
const result = await floatty.execute(block.id, { timeout: 60000 });
```

**MCP Tool:**
```typescript
server.tool('floatty_execute', async ({ block_id }) => {
  const result = await fetch(`${FLOATTY_URL}/api/v1/execute`, {
    method: 'POST',
    body: JSON.stringify({ block_id }),
  }).then(r => r.json());

  return result.output;
});
```

---

## Auto-Execute Classification

| Block Type | Auto-Execute? | Via Coordination? | Reason |
|------------|---------------|-------------------|--------|
| `daily::` | ✓ Yes | ✓ Yes | Idempotent |
| `search::` | ✓ Yes | ✓ Yes | Read-only |
| `sh::` | ✗ No (Enter) | ✓ Yes | Side effects, needs explicit request |
| `ai::` | ✗ No (Enter) | ✓ Yes | Expensive, needs explicit request |
| `/send` | ✗ No (Enter) | ✓ Yes | Context-dependent |

Auto-execute triggers on Y.Doc observer for idempotent blocks.
Coordination protocol enables explicit execution requests for all block types.

---

## The Clients

### Desktop App (Primary Executor)

- Full UI with outliner, split panes, keyboard navigation
- **Execution engine**: All TypeScript handlers run here
- Y.Doc sync via HTTP + WebSocket
- Claims execution requests via coordination protocol

### Claude Code Sessions (Agents)

Already can:
- `GET /api/v1/blocks` - read the outline
- `POST /api/v1/blocks` - create blocks
- `PATCH /api/v1/blocks/:id` - update blocks
- `DELETE /api/v1/blocks/:id` - delete blocks
- WebSocket for real-time sync

With coordination protocol:
- `POST /api/v1/execute` - request execution, get result

### CLI (floatctl)

```bash
floatctl blocks list
floatctl blocks create "sh:: echo hello" --parent root
floatctl execute <block-id>  # Routes to desktop
floatctl blocks watch        # Stream changes
```

### nvim / VS Code Plugins

- Edit blocks in native editor
- Create executable blocks
- Request execution via coordination protocol
- Real-time sync via WebSocket

### External Integrations

- MCP servers (Claude Desktop, Claude Code)
- GitHub Actions (create blocks, request execution)
- Cron jobs (scheduled block creation)
- Webhooks (external events → blocks)

---

## API Reference

### Existing Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/v1/health` | GET | Health check |
| `/api/v1/blocks` | GET | All blocks as JSON |
| `/api/v1/blocks/:id` | GET | Single block |
| `/api/v1/blocks` | POST | Create block |
| `/api/v1/blocks/:id` | PATCH | Update content |
| `/api/v1/blocks/:id` | DELETE | Delete block + subtree |
| `/api/v1/search` | GET | Full-text search |
| `/ws` | WebSocket | Real-time Y.Doc sync |

### Coordination Protocol Endpoints (Next)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/v1/execute` | POST | Request block execution |

### WebSocket Messages (Next)

| Message | Direction | Purpose |
|---------|-----------|---------|
| `ExecuteAvailable` | Server → Client | Broadcast execution request |
| `ExecuteClaim` | Client → Server | Claim execution |
| `ExecuteResult` | Client → Server | Submit result |
| `ExecuteComplete` | Server → Client | Broadcast completion |

### Authentication

```bash
curl -H "Authorization: Bearer $FLOATTY_API_KEY" ...

# Key location: ~/.floatty/config.toml
```

---

## Hook System Architecture

**Client hooks** (TypeScript) and **server hooks** (Rust) are separate systems with different concerns:

```
┌─────────────────────────────────────────────────────────────────┐
│                     CLIENT HOOKS (TypeScript)                    │
├─────────────────────────────────────────────────────────────────┤
│  hookRegistry.ts                                                 │
│  • execute:before - context assembly, validation                 │
│  • execute:after - cleanup, notifications                        │
│  Runs in: Desktop, potentially other TS clients                  │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                     SERVER HOOKS (Rust)                          │
├─────────────────────────────────────────────────────────────────┤
│  floatty-core/src/hooks/                                         │
│  • MetadataExtractionHook - parse markers, wikilinks             │
│  • TantivyIndexHook - update search index                        │
│  • PageNameIndexHook - autocomplete index                        │
│  Runs in: floatty-server only                                    │
└─────────────────────────────────────────────────────────────────┘
```

**They communicate through Y.Doc**, not shared code. When a client creates a block:
1. Y.Doc syncs to server
2. Server hooks run (indexing, metadata)
3. Metadata updates sync back to clients

---

## Prior Art

| System | Client Plugins | Server Logic | Communication |
|--------|---------------|--------------|---------------|
| **Figma** | Browser JS | Backend services | postMessage + API |
| **Obsidian** | Electron (client-only) | External tools | File sync |
| **VS Code** | Extension Host | Language Servers | LSP (JSON-RPC) |
| **Neovim** | Lua (client-only) | External processes | stdin/stdout |

**Key insight**: None of these try to run the same code in both places. They define protocols.

---

## The Principle

> "Don't embed, define protocols."

- Client handlers stay TypeScript
- Server hooks stay Rust
- Coordination happens via WebSocket messages
- The protocol is the interface, not shared code

**Shacks, not cathedrals.** Walls that can move.

---

## References

- Handler Registry: `FLOATTY_HANDLER_REGISTRY.md`
- Hook System: `FLOATTY_HOOK_SYSTEM.md`
- Event System: `src/lib/events/` (EventBus, ProjectionScheduler)
- Client Hooks: `src/lib/hooks/hookRegistry.ts`
- Server Hooks: `src-tauri/floatty-core/src/hooks/`
