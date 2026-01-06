# Floatty Handler Registry Architecture

> Extracted from architecture session 2026-01-04. Reducing handler ceremony from 7 files to 2.

## The Problem

Adding a new block type (e.g., `foo::`) currently requires touching **7 files**:

| File | Change Required |
|------|-----------------|
| `floatty-core/src/block.rs` | Add `Foo` variant to BlockType enum |
| `floatty-core/src/block.rs` | Add detection in `parse_block_type()` |
| `src-tauri/src/lib.rs` | Add `execute_foo_command()` Tauri command |
| `src-tauri/src/lib.rs` | Add to `generate_handler![]` macro |
| `src/lib/executor.ts` | Add to `handlers[]` array (text output) |
| OR `src/lib/fooExecutor.ts` | Create new executor file (structured output) |
| `src/components/BlockItem.tsx` | Wire up execution on Enter |

**Goal**: 1-2 files.

---

## Current Architecture

### BlockType Enum (Classification Only)

`floatty-core/src/block.rs` - 16 variants:

```rust
pub enum BlockType {
    Text, Sh, Ai, Ctx, Dispatch, Web, Output, Error,
    Picker, Ran, Daily, H1, H2, H3, Bullet, Todo, Quote,
}
```

Type is **derived from content on every access** via `parse_block_type()`. This is classification for rendering, NOT execution dispatch.

### Frontend Handler Array

`src/lib/executor.ts`:

```typescript
const handlers: ExecutableBlockHandler[] = [
  {
    prefixes: ['sh::', 'term::'],
    execute: (cmd) => invoke<string>('execute_shell_command', { command: cmd }),
    parseOutput: parseMarkdownTree,
    outputType: 'output',
  },
  {
    prefixes: ['ai::', 'chat::'],
    execute: (prompt) => invoke<string>('execute_ai_command', { prompt }),
    parseOutput: parseMarkdownTree,
    outputType: 'ai',
  },
];
```

`daily::` has its own executor because it returns structured data, not text.

### Tauri Commands (Hardcoded)

Each block type = separate Tauri command:
- `execute_shell_command()`
- `execute_ai_command()`
- `execute_daily_command()`

Not pluggable. Adding a new type means adding a new command.

---

## Target Architecture

### Single Dispatch Point

**Frontend**:
```typescript
invoke('execute_block', { blockType: 'sh', content: 'ls -la' })
```

**Rust**:
```rust
#[tauri::command]
async fn execute_block(block_type: &str, content: &str) -> Result<ExecutionResult, String> {
    registry::dispatch(block_type, content).await
}
```

### Handler Trait

```rust
#[async_trait]
pub trait BlockHandler: Send + Sync {
    /// Prefixes this handler responds to (e.g., ["sh::", "term::"])
    fn prefixes(&self) -> &[&str];
    
    /// Execute the block content, return output
    async fn execute(&self, content: &str) -> Result<HandlerOutput, String>;
    
    /// Optional: capabilities required (for future sandboxing)
    fn capabilities(&self) -> Vec<Capability> { vec![] }
}

pub enum HandlerOutput {
    Text(String),
    Structured(serde_json::Value),
}

pub enum Capability {
    Shell,
    Network,
    FileSystem,
    ApiKey(String),
}
```

### Registry

```rust
pub struct HandlerRegistry {
    handlers: HashMap<String, Box<dyn BlockHandler>>,
}

impl HandlerRegistry {
    pub fn register(&mut self, handler: Box<dyn BlockHandler>) {
        for prefix in handler.prefixes() {
            self.handlers.insert(prefix.to_string(), handler.clone());
        }
    }
    
    pub async fn dispatch(&self, block_type: &str, content: &str) 
        -> Result<HandlerOutput, String> 
    {
        let handler = self.handlers.get(block_type)
            .ok_or_else(|| format!("No handler for {}", block_type))?;
        handler.execute(content).await
    }
}
```

### File Structure

```
src-tauri/
├── handlers/
│   ├── mod.rs          # BlockHandler trait + HandlerRegistry
│   ├── sh.rs           # ShHandler (extracted from execute_shell_command)
│   ├── ai.rs           # AiHandler (extracted from execute_ai_command)
│   └── daily.rs        # DailyHandler (extracted from execute_daily_command)
└── lib.rs
    └── execute_block()  # Single Tauri command, dispatches to registry
```

---

## Adding a New Handler (Target State)

To add `weather::`:

**1. Create handler file** (`src-tauri/handlers/weather.rs`):

```rust
pub struct WeatherHandler;

#[async_trait]
impl BlockHandler for WeatherHandler {
    fn prefixes(&self) -> &[&str] {
        &["weather::"]
    }
    
    async fn execute(&self, content: &str) -> Result<HandlerOutput, String> {
        let location = content.trim();
        let weather = fetch_weather(location).await?;
        Ok(HandlerOutput::Text(format!("Weather in {}: {}", location, weather)))
    }
    
    fn capabilities(&self) -> Vec<Capability> {
        vec![Capability::Network]
    }
}
```

**2. Register in `mod.rs`**:

```rust
pub fn register_handlers() -> HandlerRegistry {
    let mut registry = HandlerRegistry::new();
    registry.register(Box::new(sh::ShHandler::new()));
    registry.register(Box::new(ai::AiHandler::new()));
    registry.register(Box::new(daily::DailyHandler::new()));
    registry.register(Box::new(weather::WeatherHandler));  // ← Add this line
    registry
}
```

**Done.** 2 files touched (1 new file + 1 line in registration).

---

## Migration Path

### Phase 1: Extract Handlers

1. Create `src-tauri/handlers/mod.rs` with trait + registry
2. Extract `execute_shell_command` → `handlers/sh.rs`
3. Extract `execute_ai_command` → `handlers/ai.rs`
4. Extract `execute_daily_command` → `handlers/daily.rs`
5. Add single `execute_block` Tauri command

**Existing commands stay** during migration. Both paths work until complete.

### Phase 2: Unify Frontend

1. Update `executor.ts` to call `execute_block` instead of type-specific commands
2. Merge `dailyExecutor.ts` pattern into unified flow
3. Handler output type determines rendering path

### Phase 3: Validate

Add a simple new type (e.g., `echo::`) to verify ceremony reduction.

---

## Interfaces That Travel

These shapes work in Tauri today and server-side later:

```rust
// Request (crosses IPC today, HTTP tomorrow)
struct BlockRequest {
    block_id: String,
    content: String,
    context: Option<ExecutionContext>,
}

// Response (same serialization either way)
struct BlockResponse {
    output: HandlerOutput,
    blocks_to_create: Vec<NewBlock>,
}
```

The trait doesn't know if it's running in Tauri or Axum. That's the point.

---

## Relationship to Server-Side Execution

The handler registry is designed to be **portable**:

- Today: Lives in `src-tauri`, called via Tauri commands
- Tomorrow: Same handlers, called via `POST /execute` in floatty-server
- The migration is mechanical, not architectural

See: `FLOATTY_MULTI_CLIENT_ARCHITECTURE.md` for the server execution path.

---

## Open Questions

1. **Where does registry live?**
   - Recommendation: `src-tauri` (handlers need Tauri context for shell, config, etc.)
   - Trait definition could go in `floatty-core` for type sharing

2. **BlockType enum stays?**
   - Yes. It's for classification/rendering, separate from execution dispatch
   - The registry doesn't replace the enum, it complements it

3. **Capability checking when?**
   - Future work. For now, all built-in handlers are trusted
   - Becomes important if user-defined handlers are added

---

## References

- Cowboy Recon: `docs/RECON_BLOCK_SYSTEM.md`
- External Execution: `docs/EXTERNAL_BLOCK_EXECUTION.md`
- Session transcript: `/mnt/transcripts/2026-01-04-23-17-20-float-architecture-synthesis-jan2026.txt`
