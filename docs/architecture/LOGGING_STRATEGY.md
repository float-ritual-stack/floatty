# Floatty Logging Strategy

> Making logs useful for humans AND machines (including LLMs)

## Current State (The Problem)

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
