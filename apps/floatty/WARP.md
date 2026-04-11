# Floatty Project Rules for AI Agents

## Rust Backend Modularization

**STATUS**: ✅ Completed in PR #76 (lib.rs: 778 → 370 lines, 52% reduction)

**TARGET**: `src-tauri/src/lib.rs` should stay ~370 lines (core infrastructure only)

### When adding Tauri commands:

1. **Business logic** → `src-tauri/src/services/feature_name.rs`
   - Pure Rust, no Tauri dependencies
   - Testable without Tauri runtime
   
2. **Tauri wrapper** → `src-tauri/src/commands/feature_name.rs`
   - Thin adapter (3-10 lines)
   - Extract state, delegate to services
   - `#[tauri::command]` annotation
   
3. **Registration** → `src-tauri/src/commands/mod.rs`
   - Add one line to `generate_handler![]` array

**Example**:
```rust
// services/weather.rs
pub async fn fetch(location: String) -> Result<String, String> {
    // Business logic here
}

// commands/weather.rs
#[tauri::command]
pub async fn get_weather(location: String) -> Result<String, String> {
    crate::services::weather::fetch(location).await
}

// commands/mod.rs
generate_handler![
    // ... existing ...
    weather::get_weather,
]
```

**❌ NEVER add business logic directly to `lib.rs`**

See `docs/architecture/RUST_MODULARIZATION_GUIDE.md` for full details.

---

## Frontend Handler Pattern

**STATUS**: ✅ Completed in PR #77 (executor.ts + dailyExecutor.ts → handlers/ directory)
**BENEFIT**: Reduced ceremony from 4-7 files → 2 files for new handlers (71% reduction)

**When adding block handlers** (sh::, ai::, door::, etc.):

1. **Handler implementation** → `src/lib/handlers/handler_name.ts`
   ```typescript
   export const handlerName: BlockHandler = {
     prefixes: ['prefix::'],
     async execute(blockId, content, actions) { ... }
   };
   ```

2. **Registration** → `src/lib/handlers/index.ts`
   ```typescript
   import { handlerName } from './handler_name';
   registry.register(handlerName);
   ```

**Result**: 2 files touched instead of 4-7.

**Frontend Logging**: Handlers use structured console.log for observability:
```typescript
console.log('[sh] Executing:', { commandLen, hasTvResolution });
const startTime = performance.now();
// ... execute ...
const duration = performance.now() - startTime;
console.log('[sh] Complete:', { duration: `${duration.toFixed(1)}ms`, outputBytes });
```

See `docs/architecture/HANDLER_REGISTRY_IMPLEMENTATION.md` for details.

---

## Structured Logging

**Use `tracing` for all logging** - not `log::` or `println!`

```rust
// ❌ DON'T
log::info!("Executing command: {}", cmd);
println!("Server started on port {}", port);

// ✅ DO
use tracing::{info, warn, error, instrument};

info!(command_len = cmd.len(), "Executing shell command");
info!(port = port, pid = pid, "Server started");

// ✅ For functions, use #[instrument]
#[instrument(skip(command), fields(command_hash = %hash_command(&command)))]
pub async fn execute_shell_command(command: String) -> Result<String, String> {
    info!("Shell command requested");
    // ...
}
```

**Why**:
- Structured JSON logs in `~/.floatty/logs/floatty-{date}.jsonl`
- LLMs can parse and query logs
- Request tracing with correlation IDs
- Performance metrics (duration, bytes) automatically captured

**Key patterns**:
- Use structured fields: `info!(bytes = n, duration_ms = ms, "Message")`
- Add request_id spans for tracing: `info_span!("operation", request_id = %id)`
- Log entry/exit of commands, external calls, errors
- Don't log sensitive data or inside tight loops

See `docs/architecture/LOGGING_STRATEGY.md` for complete guide.

---

## Architecture References

- `docs/ARCHITECTURE_REVIEW_2026_01_08.md` - Scaling priorities after stress test
- `docs/architecture/RUST_MODULARIZATION_GUIDE.md` - Backend module structure
- `docs/architecture/HANDLER_REGISTRY_IMPLEMENTATION.md` - Frontend handler consolidation
- `docs/architecture/LOGGING_STRATEGY.md` - Structured logging for LLM observability
- `docs/BLOCK_TYPE_PATTERNS.md` - Block execution patterns
