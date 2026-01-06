# Block System Reconnaissance

> Cowboy recon mission - documenting what exists before designing handler registry.

## 1. Block Type System (floatty-core)

### BlockType Enum

`src-tauri/floatty-core/src/block.rs:17-52`

```rust
pub enum BlockType {
    Text,       // Default
    Sh,         // sh::, term::
    Ai,         // ai::, chat::
    Ctx,        // ctx:: or - ctx::YYYY-MM-DD
    Dispatch,   // dispatch::
    Web,        // web::, link::
    Output,     // output::
    Error,      // error::
    Picker,     // picker::
    Ran,        // ran::
    Daily,      // daily::
    H1, H2, H3, // # ## ###
    Bullet,     // -
    Todo,       // - [ ] or - [x]
    Quote,      // >
}
```

16 variants. Type is **derived from content on every access** - NOT stored in the database.

### parse_block_type()

`src-tauri/floatty-core/src/block.rs:102-165`

Simple prefix matching:
```rust
let lower = trimmed.to_lowercase();

if lower.starts_with("sh::") || lower.starts_with("term::") {
    return BlockType::Sh;
}
if lower.starts_with("ai::") || lower.starts_with("chat::") {
    return BlockType::Ai;
}
// ... continues for each type
```

**Key insight**: This is just classification. It doesn't trigger execution, doesn't create output blocks, doesn't know about handlers. It answers "what color should this render?" not "what should happen when you press Enter?"

### Block Struct

```rust
pub struct Block {
    pub id: String,
    pub parent_id: Option<String>,
    pub child_ids: Vec<String>,
    pub content: String,
    pub collapsed: bool,
    pub created_at: i64,
    pub updated_at: i64,
}
```

Standard outliner node. Methods include `block_type()` which calls `parse_block_type(&self.content)`.

---

## 2. Frontend Handler Registry (executor.ts)

`src/lib/executor.ts` - The actual execution dispatch happens here.

### ExecutableBlockHandler Interface

```typescript
export interface ExecutableBlockHandler {
  prefixes: string[];           // e.g., ['sh::', 'term::']
  execute: (content: string) => Promise<string>;
  parseOutput?: (output: string) => ParsedBlock[];
  outputType?: 'output' | 'ai';
  errorType?: 'error';
  pendingMessage?: string;
}
```

### handlers[] Array

```typescript
const handlers: ExecutableBlockHandler[] = [
  {
    prefixes: ['sh::', 'term::'],
    execute: (cmd) => invoke<string>('execute_shell_command', { command: cmd }),
    parseOutput: parseMarkdownTree,
    outputType: 'output',
    pendingMessage: 'Running...',
  },
  {
    prefixes: ['ai::', 'chat::'],
    execute: (prompt) => invoke<string>('execute_ai_command', { prompt }),
    parseOutput: parseMarkdownTree,
    outputType: 'ai',
    pendingMessage: 'Thinking...',
  },
];
```

**Note**: `daily::` is NOT in this array. It has a separate executor (`dailyExecutor.ts`) because it returns structured data, not text output.

### Handler Lookup

```typescript
export function findHandler(content: string): ExecutableBlockHandler | null {
  const trimmed = content.trim().toLowerCase();
  return handlers.find(h =>
    h.prefixes.some(p => trimmed.startsWith(p))
  ) ?? null;
}
```

### executeBlock() Flow

1. Find handler via `findHandler()`
2. Extract content after prefix
3. Resolve `$tv()` variables (spawns picker, waits)
4. Create "ran::" block if TV resolved (shows actual command)
5. Create output placeholder with "Running..."
6. Call `handler.execute()`
7. Parse output if `parseOutput` defined
8. Replace placeholder with result or error

---

## 3. dailyExecutor.ts - The Outlier

`src/lib/dailyExecutor.ts` - Separate because return type differs.

### Why Separate?

- Returns structured `DailyNoteData`, not string
- Uses `setBlockOutput()` and `setBlockStatus()`
- Output renders via custom `<DailyView>` component
- Can't fit the "execute returns string, parseOutput returns blocks" model

### Interface

```typescript
export interface DailyExecutorActions {
  createBlockInside: (parentId: string) => string;
  updateContent: (id: string, content: string) => void;
  setBlockOutput: (id: string, output: unknown, outputType: string) => void;
  setBlockStatus: (id: string, status: Block['outputStatus']) => void;
  deleteBlock: (id: string) => void;
  getBlock: (id: string) => Block | undefined;
}
```

More capabilities needed than the generic `ExecutorActions`.

---

## 4. Tauri Commands (Execution Backends)

`src-tauri/src/lib.rs`

### execute_shell_command (line 136-188)

```rust
#[tauri::command]
async fn execute_shell_command(command: String) -> Result<String, String> {
    // Spawns user's shell with -l -c
    // Truncates large output
    // Returns stdout or combined stdout+stderr
}
```

### execute_ai_command (line 191-240)

```rust
#[tauri::command]
async fn execute_ai_command(prompt: String) -> Result<String, String> {
    // Ollama API call
    // Returns LLM response text
}
```

### execute_daily_command (daily_view.rs)

```rust
#[tauri::command]
pub async fn execute_daily_command(date_arg: String) -> Result<DailyNoteData, String> {
    // Read daily note file
    // Extract via Ollama structured output
    // Return DailyNoteData (not string!)
}
```

**Key insight**: Each block type = separate Tauri command. Not pluggable. Adding a new type means adding a new command and updating `generate_handler![]`.

---

## 5. Server Architecture (floatty-server)

### Purpose

**Y.Doc sync only**. No execution endpoints. The server doesn't know about sh::/ai::/daily::.

### Stack

- `axum = "0.7"`
- `tower-http = "0.5"` (CORS)
- `yrs = "0.25.0"` (CRDT)

### Routes (`api.rs`)

```
GET  /api/v1/health        - Health check
GET  /api/v1/state         - Full Y.Doc state (base64)
GET  /api/v1/state-vector  - For reconciliation
POST /api/v1/update        - Apply Y.Doc update
GET  /api/v1/blocks        - All blocks as JSON
GET  /api/v1/blocks/:id    - Single block
POST /api/v1/blocks        - Create block
PATCH /api/v1/blocks/:id   - Update content
DELETE /api/v1/blocks/:id  - Delete block + subtree
```

### Auth Middleware Pattern

`main.rs:69-73`
```rust
let auth_state = auth::ApiKeyAuth::new(api_key.clone());

let api_routes = api::create_router(Arc::clone(&store), Arc::clone(&broadcaster))
    .layer(middleware::from_fn_with_state(auth_state.clone(), auth::auth_middleware));
```

Tower middleware for auth. This is the pattern we'd extend for execution middleware.

---

## 6. The Boundaries

```
┌─────────────────────────────────────────────────────────────────────┐
│                         FRONTEND (SolidJS)                          │
│                                                                     │
│  BlockItem.tsx                                                      │
│       ↓ Enter key                                                   │
│  executor.ts::findHandler()  ──────────────────┐                    │
│       ↓ found                                  │ not found          │
│  executor.ts::executeBlock() ←───┐             ↓                    │
│       ↓                          │    dailyExecutor.ts::execute()   │
│  invoke('execute_shell_command') │             ↓                    │
│  invoke('execute_ai_command')    │    invoke('execute_daily_command')│
│                                  │                                  │
└──────────────────────────────────┼──────────────────────────────────┘
                                   │
════════════════════════════════════════════════════════════════════════
                              TAURI COMMANDS
════════════════════════════════════════════════════════════════════════
                                   │
┌──────────────────────────────────┼──────────────────────────────────┐
│                         RUST (Tauri)                                │
│                                  │                                  │
│  lib.rs                          │                                  │
│  execute_shell_command()  ───────┤                                  │
│  execute_ai_command()     ───────┤                                  │
│  execute_daily_command() ────────┘                                  │
│       ↓                                                             │
│  (spawn shell)   (call Ollama)   (read file + Ollama)               │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘

════════════════════════════════════════════════════════════════════════
                              HTTP (Y.Doc sync)
════════════════════════════════════════════════════════════════════════

┌─────────────────────────────────────────────────────────────────────┐
│                         floatty-server                              │
│                                                                     │
│  CORS → Auth → api::create_router()                                 │
│                                                                     │
│  NO EXECUTION ENDPOINTS - Y.Doc sync only                           │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 7. The Gap

### What We Have

| Layer | Extensibility | Add New Type |
|-------|---------------|--------------|
| Frontend `handlers[]` | Array.push | Add object to array |
| Frontend `dailyExecutor` | N/A | Create new file, wire in BlockItem |
| Rust Tauri commands | Hard-coded | New fn + update `generate_handler![]` |
| Server | N/A | Not involved in execution |

### What We Want

"One file to add a handler, minimal ceremony"

### Options

#### A. Frontend-First Registry

Keep execution in Tauri commands, but unify frontend dispatch:

```typescript
// handlers.ts - THE ONE FILE
export const handlers: Handler[] = [
  { prefix: 'sh::', backend: 'shell', output: 'text' },
  { prefix: 'ai::', backend: 'ollama', output: 'text' },
  { prefix: 'daily::', backend: 'daily', output: 'structured' },
  // Add new handler here ↑
];
```

Con: Still need Rust Tauri command for new backends.

#### B. Server-Side Handlers (Tower Pattern)

Move execution to server, use Tower middleware:

```rust
// handlers/sh.rs
pub fn sh_handler() -> impl Handler<...> {
    // ...
}

// main.rs
let app = Router::new()
    .route("/execute/sh", post(sh_handler()))
    .route("/execute/ai", post(ai_handler()))
    // ...
```

Pro: Tower patterns, real middleware
Con: Server now needs shell access, Ollama access, etc.

#### C. Hybrid - Registry + Convention

```
src-tauri/
├── handlers/
│   ├── mod.rs          # Registry trait
│   ├── sh.rs           # ShHandler
│   ├── ai.rs           # AiHandler
│   └── daily.rs        # DailyHandler
```

Frontend:
```typescript
invoke('execute_block', { blockType: 'sh', content: '...' })
```

Rust:
```rust
#[tauri::command]
async fn execute_block(block_type: &str, content: &str) -> Result<ExecutionResult, String> {
    registry::dispatch(block_type, content).await
}
```

**One command, dispatches to handler by type.**

---

## 8. Recommendation

**Option C** seems right:

1. **Frontend**: Knows prefixes, creates output blocks, but delegates execution
2. **Tauri**: Single `execute_block` command, dispatches to registered handlers
3. **Handlers**: One file per handler, implement trait

### Minimal Handler Trait

```rust
#[async_trait]
pub trait BlockHandler: Send + Sync {
    fn prefixes(&self) -> &[&str];
    async fn execute(&self, content: &str) -> Result<HandlerOutput, String>;
}

pub enum HandlerOutput {
    Text(String),
    Structured(serde_json::Value),
}
```

### Registration

```rust
pub fn register_handlers() -> HashMap<&'static str, Box<dyn BlockHandler>> {
    let mut map = HashMap::new();
    map.insert("sh", Box::new(ShHandler));
    map.insert("ai", Box::new(AiHandler));
    map.insert("daily", Box::new(DailyHandler));
    map
}
```

### Open Questions

1. **Where does the handler registry live?**
   - floatty-core (no Tauri deps, can't spawn shell)
   - src-tauri (has Tauri context, can spawn)
   - New crate floatty-handlers?

2. **Do handlers need Tauri context?**
   - ShHandler needs shell
   - AiHandler needs config
   - DailyHandler needs file access + Ollama

3. **Tower middleware: what would we actually middleware?**
   - Logging? Already have log::info.
   - Rate limiting? Overkill for local.
   - Timeout? Maybe useful for runaway commands.

---

## 9. Files Touched for New Handler Today

Currently, to add `foo::`:

1. `floatty-core/src/block.rs` - Add `Foo` variant to BlockType enum
2. `floatty-core/src/block.rs` - Add detection in `parse_block_type()`
3. `src-tauri/src/lib.rs` - Add `execute_foo_command()` Tauri command
4. `src-tauri/src/lib.rs` - Add to `generate_handler![]`
5. `src/lib/executor.ts` - Add to `handlers[]` array (if text output)
6. OR `src/lib/fooExecutor.ts` - Create new executor (if structured output)
7. `src/components/BlockItem.tsx` - Wire up execution on Enter

**7 files minimum.** Goal: 1-2 files.

---

*Recon complete. Ready to discuss which path fits.*
