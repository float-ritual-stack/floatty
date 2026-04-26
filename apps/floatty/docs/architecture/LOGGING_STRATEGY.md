# Floatty Logging Strategy

> Making logs useful for humans AND machines (including LLMs)

## Status Note (2026-04-11)

This document was written when Rust-side logging was unstructured `log::`/`println!` and before OTLP export existed. Major items from the "Target Architecture" section are now shipped:

- **Structured JSON logging via `tracing`**: both the Tauri process and the `floatty-server` subprocess write to the same daily-rotating `{data_dir}/logs/floatty.YYYY-MM-DD.jsonl` files (via `tracing-appender`). See `setup_logging()` in `src-tauri/src/lib.rs` and `src-tauri/floatty-server/src/main.rs`.
- **OTLP log export (floatty-server only, logs-only)**: shipped via `opentelemetry-appender-tracing` → `opentelemetry-otlp` (HTTP+protobuf via `reqwest-blocking-client`). Endpoint is config-driven via `[server].otlp_endpoint` in `config.toml` (any OTLP HTTP collector — Loki's native receiver at `/otlp/v1/logs`, Alloy, OTel Collector), with env var overrides (`OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`, `OTEL_EXPORTER_OTLP_ENDPOINT`). Resource attributes surfaced as Loki labels: `service.name=floatty-server`, `service.version`, `deployment.environment=dev|release`.
- **Startup phase timing**: `hooks/system.rs` and `store.rs` emit `target: "floatty_startup"` events for `db_open`, `ydoc_replay`, `search_init_complete`, `cold_start_rehydration_complete`, `hook_system_init_complete`, `phase=server_ready`. Note that `target:` overrides bypass crate-path filtering in `EnvFilter` — the default filter must include `floatty_startup=info` explicitly.

**Not yet implemented** (still aspirational in the sections below):
- Span-based request tracing (`#[tracing::instrument]` + `tracing-opentelemetry` → OTLP traces → Tempo). Logs-only for now.
- MCP log-query tool.
- Request ID correlation IDs on block operations.

**Gotchas to read before touching the OTLP code**: @.claude/rules/do-not.md "Tracing / OTLP" section documents the landmines (cfg-gate collision, tokio-thread panic, env-var override precedence, cardinality risk).

**See also**: @.claude/rules/config-and-logging.md for the short form and query examples.

---

## Current State (The Problem)

> Historical context — much of this has been addressed. Kept for rationale.

**Audit Results**:
- 88 `log::` statements scattered across codebase
- Mix of `println!` in server.rs (13 instances) - should be proper logging
- Inconsistent formatting: some use `ai::`, some use `[panel]`, some just plain text
- No structured data - makes LLM parsing hard
- No correlation IDs - can't trace a request through the system
- Ad-hoc levels - info/warn/error applied inconsistently

**Example of current mess**:
```rust
// lib.rs
log::info!("ai:: executing prompt on {}:{} model={}", host, port, model);
log::info!("ai:: sending request to Ollama...");
log::info!("ai:: got response ({} chars)", len);

// ctx_parser.rs  
log::info!("Starting ctx:: parser worker");
log::info!("Processing {} pending markers", markers.len());

// panel.rs
log::info!("[panel] Intercepted close for {}, hiding instead", label);

// server.rs
println!("floatty-server subprocess launched (pid: {})", child.id());  // ❌ Should be log::info!
```

**Problems**:
1. Inconsistent prefixes (`ai::`, `ctx::`, `[panel]`)
2. No structured fields - hard to query
3. `println!` mixed with `log::` - inconsistent capture
4. No request IDs - can't correlate logs
5. No duration tracking - performance blind spots

---

## Target Architecture: The Float Log Stream

### Philosophy

> **Logs are data structures, not strings.**

All logs should be:
1. **Structured** - JSON fields, not string interpolation
2. **Contextual** - Include request/block/session IDs
3. **Traceable** - Follow execution through the system
4. **Queryable** - LLMs should be able to parse them
5. **Observable** - Capture metrics (duration, size, errors)

### Log Format

**Standard structure**:
```json
{
  "timestamp": "2026-01-08T07:45:12.123Z",
  "level": "INFO",
  "target": "float_pty::commands::executors",
  "message": "Shell command executed",
  "fields": {
    "request_id": "req_abc123",
    "block_id": "blk_xyz789",
    "command": "ls -la",
    "duration_ms": 42,
    "output_bytes": 1024,
    "exit_code": 0
  }
}
```

**Why this works**:
- LLMs can parse JSON easily
- Tools like `jq`, `grep`, etc. can query it
- Request IDs enable tracing
- Duration/size metrics for performance analysis
- Consistent structure across all modules

---

## Implementation: Structured Logging with `tracing`

### Step 1: Add `tracing` to Cargo.toml

```toml
[dependencies]
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["json", "env-filter"] }
tracing-appender = "0.2"

# For OpenTelemetry integration (future)
# tracing-opentelemetry = "0.26"
```

### Step 2: Initialize Logging in lib.rs

```rust
// lib.rs - replace current tauri-plugin-log setup

use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};
use tracing_appender::rolling::{RollingFileAppender, Rotation};

fn setup_logging() {
    let log_dir = dirs::home_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join(".floatty")
        .join("logs");
    
    std::fs::create_dir_all(&log_dir).ok();
    
    // File appender: ~/.floatty/logs/floatty-{date}.jsonl
    let file_appender = RollingFileAppender::builder()
        .rotation(Rotation::DAILY)
        .filename_prefix("floatty")
        .filename_suffix("jsonl")
        .build(log_dir)
        .expect("Failed to create log appender");
    
    // Structured JSON logs to file
    let file_layer = fmt::layer()
        .json()
        .with_writer(file_appender)
        .with_target(true)
        .with_thread_ids(true)
        .with_thread_names(true);
    
    // Human-readable logs to stdout (dev only)
    let stdout_layer = if cfg!(debug_assertions) {
        Some(fmt::layer()
            .with_writer(std::io::stdout)
            .with_target(true)
            .with_level(true)
            .with_ansi(true)
            .pretty())
    } else {
        None
    };
    
    // ENV filter: RUST_LOG=debug or default to info
    let filter = EnvFilter::try_from_default_env()
        .or_else(|_| EnvFilter::try_new("info"))
        .unwrap();
    
    tracing_subscriber::registry()
        .with(filter)
        .with(file_layer)
        .with(stdout_layer)
        .init();
}

pub fn run() {
    setup_logging();
    tracing::info!("Floatty starting");
    // ... rest of setup
}
```

### Step 3: Logging Patterns by Module

#### Commands (Thin Layer)

```rust
// commands/executors.rs

use tracing::{info, error, instrument};

#[tauri::command]
#[instrument(skip(command), fields(command_hash = %hash_command(&command)))]
pub async fn execute_shell_command(command: String) -> Result<String, String> {
    info!("Shell command requested");
    
    match services::shell_executor::execute(command).await {
        Ok(result) => {
            info!(
                output_bytes = result.len(),
                "Shell command completed"
            );
            Ok(result)
        }
        Err(e) => {
            error!(error = %e, "Shell command failed");
            Err(e)
        }
    }
}

fn hash_command(cmd: &str) -> String {
    use sha2::{Sha256, Digest};
    let hash = Sha256::digest(cmd.as_bytes());
    format!("{:x}", hash)[..8].to_string()
}
```

**Output**:
```json
{
  "timestamp": "2026-01-08T07:45:12.123Z",
  "level": "INFO",
  "target": "commands::executors",
  "message": "Shell command requested",
  "span": {
    "name": "execute_shell_command",
    "command_hash": "abc12345"
  }
}
{
  "timestamp": "2026-01-08T07:45:12.165Z",
  "level": "INFO",
  "message": "Shell command completed",
  "fields": {
    "output_bytes": 1024
  }
}
```

#### Services (Business Logic)

```rust
// services/shell_executor.rs

use tracing::{info, warn, debug, Span};
use std::time::Instant;

pub async fn execute(command: String) -> Result<String, String> {
    let start = Instant::now();
    let span = Span::current();
    
    info!(command_len = command.len(), "Executing shell command");
    
    tokio::task::spawn_blocking(move || {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
        
        debug!(shell = %shell, "Using shell");
        
        let output = std::process::Command::new(&shell)
            .arg("-l")
            .arg("-c")
            .arg(&command)
            .output()
            .map_err(|e| {
                error!(error = %e, "Failed to spawn shell");
                format!("Failed to execute: {}", e)
            })?;
        
        let duration = start.elapsed();
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        
        if output.status.success() {
            info!(
                exit_code = 0,
                duration_ms = duration.as_millis() as u64,
                stdout_bytes = stdout.len(),
                "Shell command succeeded"
            );
            Ok(stdout.to_string())
        } else {
            warn!(
                exit_code = output.status.code(),
                duration_ms = duration.as_millis() as u64,
                stderr_bytes = stderr.len(),
                "Shell command failed"
            );
            Err(format!("{}\nError: {}", stdout, stderr))
        }
    })
    .await
    .map_err(|e| e.to_string())?
}
```

#### Background Workers (ctx_parser, ctx_watcher)

```rust
// ctx_parser.rs

use tracing::{info, warn, error, info_span};

pub fn start(&self) {
    let _span = info_span!("ctx_parser_worker").entered();
    
    info!("Starting ctx parser worker");
    
    let handle = thread::spawn(move || {
        let rt = tokio::runtime::Runtime::new().expect("Failed to create runtime");
        
        loop {
            if !*running.lock().unwrap() { break; }
            
            match db.get_pending(10) {
                Ok(markers) if !markers.is_empty() => {
                    info!(
                        marker_count = markers.len(),
                        "Processing pending markers"
                    );
                    
                    for marker in markers {
                        let marker_span = info_span!("parse_marker", marker_id = %marker.id);
                        let _guard = marker_span.enter();
                        
                        match rt.block_on(parse_marker(&client, &config, &marker.raw_line)) {
                            Ok(parsed) => {
                                info!(
                                    timestamp = ?parsed.timestamp,
                                    project = ?parsed.project,
                                    "Marker parsed successfully"
                                );
                                // ... save to DB
                            }
                            Err(e) => {
                                warn!(error = %e, "Failed to parse marker");
                                db.mark_error(&marker.id)?;
                            }
                        }
                    }
                }
                Err(e) => {
                    error!(error = %e, "Failed to get pending markers");
                }
                _ => {
                    // No pending markers
                    debug!("No pending markers, sleeping");
                }
            }
            
            thread::sleep(Duration::from_millis(config.poll_interval_ms));
        }
        
        info!("ctx parser worker stopped");
    });
    
    // Store handle
}
```

#### Server (Replace println!)

```rust
// server.rs

use tracing::{info, warn, error};

pub fn spawn_server(port: u16) -> Option<ServerState> {
    // ❌ BEFORE: println!("Starting floatty-server on port {}", port);
    // ✅ AFTER:
    info!(port = port, "Starting floatty-server");
    
    let child = Command::new(&binary_path)
        .arg("--port")
        .arg(port.to_string())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            error!(
                error = %e,
                binary = %binary_path.display(),
                "Failed to spawn floatty-server"
            );
            e
        })
        .ok()?;
    
    let pid = child.id();
    info!(pid = pid, "floatty-server subprocess launched");
    
    // Wait for health check
    match wait_for_server_health(&format!("http://127.0.0.1:{}/health", port), 30) {
        Ok(_) => {
            info!(port = port, pid = pid, "floatty-server health check passed");
        }
        Err(e) => {
            warn!(error = %e, "Server health check failed, continuing anyway");
        }
    }
    
    Some(ServerState { /* ... */ })
}
```

---

## Contextual Logging: Request Tracing

### Add Request IDs to Block Operations

```rust
// In BlockStore or wherever blocks are executed

use uuid::Uuid;
use tracing::Span;

pub async fn execute_block(&self, block_id: &str, content: &str) {
    let request_id = Uuid::new_v4().to_string();
    let span = info_span!(
        "execute_block",
        request_id = %request_id,
        block_id = %block_id,
        block_type = %detect_block_type(content)
    );
    let _guard = span.enter();
    
    info!("Block execution started");
    
    // Delegate to handler...
    match handler.execute(content).await {
        Ok(result) => {
            info!(
                output_bytes = result.len(),
                "Block execution completed"
            );
        }
        Err(e) => {
            error!(
                error = %e,
                "Block execution failed"
            );
        }
    }
}
```

**Result**: Every log in the execution has `request_id`, `block_id`, and `block_type` automatically attached.

---

## Migration Path

### Phase 1: Infrastructure (1-2 hours)

1. Add `tracing` dependencies to Cargo.toml
2. Replace `tauri-plugin-log` setup with `tracing-subscriber` in `lib.rs`
3. Test that logs appear in `~/.floatty/logs/floatty-{date}.jsonl`

### Phase 2: High-Value Modules (2-3 hours)

Replace logging in priority order:
1. **commands/** - Entry points for all operations
2. **services/** - Core business logic
3. **server.rs** - Replace all `println!` with `tracing`
4. **ctx_parser.rs** - Background worker critical path

### Phase 3: Background Workers (1-2 hours)

5. **ctx_watcher.rs** - File system monitoring
6. **daily_view.rs** - Daily note extraction

### Phase 4: Validation (1 hour)

- Run app, execute various operations
- Check `~/.floatty/logs/floatty-{date}.jsonl`
- Parse with `jq` to verify structure
- Test LLM can parse and understand logs

---

## LLM Integration: Making Logs Observable

### Log Query Examples

```bash
# Get all shell commands executed today
jq 'select(.target | contains("shell_executor")) | {time: .timestamp, command_hash: .span.command_hash, duration: .fields.duration_ms}' floatty-2026-01-08.jsonl

# Find slow operations (>1s)
jq 'select(.fields.duration_ms > 1000) | {target, message, duration: .fields.duration_ms}' floatty-*.jsonl

# Trace a specific request
jq 'select(.span.request_id == "req_abc123")' floatty-*.jsonl

# Error rate by module
jq -s 'group_by(.target) | map({target: .[0].target, errors: [.[] | select(.level == "ERROR")] | length})' floatty-*.jsonl
```

### MCP Server Integration

When you add the Tauri MCP server, it can:
1. Stream logs in real-time: `GET /logs/stream`
2. Query logs by filter: `GET /logs?level=ERROR&target=commands`
3. Get request traces: `GET /logs/trace/:request_id`

### Structured Prompt for LLMs

```markdown
You have access to structured logs from floatty. Each log entry is JSON with:
- timestamp: ISO 8601
- level: DEBUG/INFO/WARN/ERROR
- target: Rust module path
- message: Human-readable description
- span: Context (request_id, block_id, etc.)
- fields: Structured data (duration_ms, bytes, exit_code, etc.)

When analyzing issues:
1. Look for ERROR level logs first
2. Use request_id to trace execution flow
3. Check duration_ms for performance bottlenecks
4. Correlate timestamps to find patterns
```

---

## Benefits

### For Developers
- **Grep-able** - `grep "ERROR"` still works
- **Query-able** - `jq` for structured queries
- **Traceable** - Request IDs through the system
- **Metrics** - Duration/size automatically captured

### For LLMs
- **Parsable** - JSON is LLM-native format
- **Contextual** - Span data provides execution context
- **Queryable** - Can ask "show me all errors in execute_shell_command"
- **Observable** - Performance metrics visible

### For Operations
- **Retention** - Daily rotation prevents disk bloat
- **Searchable** - Standard JSON tools work
- **Alerting** - Can pipe to monitoring systems
- **Debugging** - Request traces show full execution path

---

## Quick Reference

### Log Levels
- **ERROR**: Something failed, user action needed
- **WARN**: Something unexpected, but recovered
- **INFO**: Normal operations, high-level flow
- **DEBUG**: Detailed execution, not shown in prod
- **TRACE**: Very verbose, only for deep debugging

### When to Log

✅ **DO log**:
- Entry/exit of Tauri commands
- External calls (HTTP, DB, filesystem)
- Errors and warnings
- Performance metrics (duration, size)
- State transitions

❌ **DON'T log**:
- Inside tight loops
- Sensitive data (passwords, tokens)
- Every variable assignment
- Redundant info (already in parent span)

### Span vs Event

```rust
// Span: Duration of operation
let span = info_span!("operation_name", field = "value");
let _guard = span.enter();
// ... do work ...
// span ends when _guard drops

// Event: Point-in-time occurrence
info!(field = "value", "Something happened");
```

---

## Next Steps

1. **Phase 1**: Add tracing infrastructure (this week)
2. **Phase 2**: Migrate high-value modules (next sprint)
3. **Phase 3**: Add request tracing to block execution
4. **Phase 4**: Integrate with Tauri MCP server for LLM observability

**Related**:
- `RUST_MODULARIZATION_GUIDE.md` - Service layer is perfect for structured logging
- `HANDLER_REGISTRY_IMPLEMENTATION.md` - Handlers should log request_id
- `ARCHITECTURE_REVIEW_2026_01_08.md` - Observability for scaling

---

## Tier-of-INFO Audit — 2026-04-24 ([[FLO-675]])

Loki query of release floatty-server for 2026-04-24 returned only 9 events (all `floatty_server::backup` hourly ticks) despite the server running all day. Audit reviewed every `tracing::info!` call site in `floatty-server/src` and `floatty-core/src` against the Tier-of-INFO definition below to confirm the surface is correct and identify silent code paths.

### Tier-of-INFO Definition

A `tracing::info!` event must satisfy ALL of:

1. **Lifecycle, not hot-path.** Fires < 10× per minute under normal release usage. Per-block, per-keystroke, per-broadcast events stay at DEBUG.
2. **Diagnostic value.** Pairs with an outcome (success/failure, count, duration_ms) — not a placeholder ping. "Backup completed" with no fields is fine for an hourly daemon; "tick" with no fields is not.
3. **Sibling-agent useful.** Answers "what is release doing?" or "did X complete?" when read out of context.
4. **Bounded cardinality on Loki labels.** Structured fields that get mapped to Loki labels (per the OTLP→Loki default) must not include high-cardinality values like `block_id`, `request_id`, or per-update `tx_id`. See `.claude/rules/do-not.md` "Tracing / OTLP" — promote those to span attributes or Loki-side allowlist rather than into the event.

### Existing INFO Surface (Audit Confirmed Correct)

| Source | Event | Frequency |
|---|---|---|
| `floatty-server/main.rs` | `phase=ydoc_store_ready` / `hook_system_ready` / `server_ready` (target=`floatty_startup`) | startup only |
| `floatty-server/main.rs` | API auth state, server startup, backup daemon enabled/disabled | startup only |
| `floatty-server/ws.rs:298` | `WebSocket client connected (outline: ...)` | per client connect |
| `floatty-server/ws.rs:355` | `WebSocket client disconnected (outline: ...)` | per client disconnect |
| `floatty-server/ws.rs:237` | `Heartbeat task started (interval: 30s)` | startup only |
| `floatty-server/api/sync.rs:235` | `Rehydrated N blocks after restore` | per restore (rare, destructive) |
| `floatty-server/api/sync.rs:246` | `Y.Doc restored from binary backup` (block_count, root_count) | per restore |
| `floatty-server/api/backup.rs` | `Rehydrated N blocks after backup restore` | per backup-restore |
| `floatty-server/api/search.rs:196` | `Reindex triggered: N blocks rehydrated` | manual reindex |
| `floatty-server/backup.rs` | `Backup completed`, `Retention pruned old backups`, `Last backup is stale, running immediate` | hourly |
| `floatty-server/block_service.rs:980` | `Importing block with preserved identity` (target=`floatty_server::import`, block_id, identity_source) | per binary-import block |
| `floatty-server/outline_manager.rs` | `Created outline '...'`, `Deleted outline '...'`, `Backup daemon started for outline '...'`, `Wired callbacks for outline '...'`, `Initializing hook system for outline '...'` | per outline lifecycle |
| `floatty-core/hooks/system.rs` | `search_init_complete`, `cold_start_rehydration_complete`, `hook_system_init_complete` (target=`floatty_startup`) | startup only |
| `floatty-core/search/index_manager.rs:144` | `Creating new search index at ...` | startup or rebuild |
| `floatty-core/search/writer.rs` | `Writer actor stopped`, `All documents cleared from index`, `Writer actor shutting down` | shutdown / reset |

**The surface is mostly right.** Today's release stream looks empty because the canonical operational state for an always-on release floatty hits NONE of these conditions: no restart (no startup events), no client reconnects (no WS connect/disconnect events), no restore, no outline lifecycle. Just the hourly backup daemon.

### Known Gaps (Silent at INFO, Need Future Instrumentation)

These are NOT promotion candidates — they're code paths that currently emit nothing at any tracing level, or only fire on warn/error. Filed for future work:

| Path | Gap | Volume Risk | Notes |
|---|---|---|---|
| `floatty-server/api/sync.rs::apply_update` | Every Y.Doc update from clients goes through here silently. `#[tracing::instrument]` creates a span but no event log line. | High — could be 100s/min during active editing. Don't log per-call; design an aggregated periodic summary event. | The single biggest reason release looks empty during steady-state usage. |
| `floatty-server/ws.rs` sync gap detection | When a client reconnects with stale `seq`, server detects gap and sends backfill via `GET /api/v1/updates?after=N`. No INFO log marks the gap event. | Low — happens on reconnect after disconnect/sleep. | Pair with gap-fill outcome (filled N updates) for a complete diagnostic. |
| Periodic activity summary | No INFO event reports steady-state throughput. Sibling agents querying "is the server doing anything?" get false-empty between hourly backups. | Cap to 1/min. Aggregate counters: blocks_created, blocks_updated, ws_broadcasts, apply_updates. | Cardinality-safe: counts only, no ids. |

### Promotion Candidates Considered, Rejected

| Source | Current | Why NOT promote |
|---|---|---|
| `floatty_core::hooks::metadata_extraction` per-block events | DEBUG | Hot-path flood (2262 events per dev cold-start). Aggregate at INFO instead, per "Periodic activity summary" gap above. |
| `hyper_util::client::legacy::pool` keepalives | DEBUG | Filtered at source via `hyper=warn`. Promotion would defeat the silencer that prevents OTLP telemetry-induced-telemetry loops. |
| `floatty_server::ws` per-broadcast events (lines 133, 140, 148) | DEBUG | Per-update frequency. Aggregate, don't promote. |
| `floatty_server::ws` heartbeat tick (line 165) | DEBUG | 2880 events/day at one-per-30s. Tick liveness is implicit in any other event firing. |
| `floatty_core::search::writer` per-write events | DEBUG | Per-block write frequency. Already INFO at lifecycle (start, stop, clear). |

### Verification Query

```bash
# LOKI_URL points at the team's Loki query frontend.
# Set via env var; the actual address lives in the internal infra runbook,
# not this repo. Do NOT hardcode the ngrok / production URL here.
LOKI_URL="${LOKI_URL:?set LOKI_URL to the team's Loki endpoint (see internal runbook)}"
START=$(date -d '24 hours ago' +%s)000000000
END=$(date +%s)000000000
curl -sG "$LOKI_URL/loki/api/v1/query_range" \
  --data-urlencode 'query={service_name="floatty-server", deployment_environment="release"}' \
  --data-urlencode "start=$START" --data-urlencode "end=$END" \
  --data-urlencode 'limit=5000' \
  | jq -r '.data.result[].values[] | .[1] | .[0:80]' | sort | uniq -c | sort -rn
```

Healthy release stream over 24h should show: backup × ~24, retention × ~24, plus any restart-driven phase events (if reboots happened) and any restore/outline-create events (if those operations occurred).
