# Configuration & Logging

## Data Directory (Build Profile Isolation)

- Debug: `~/.floatty-dev`
- Release: `~/.floatty`
- Override: `FLOATTY_DATA_DIR` env var

Structure: `config.toml`, `ctx_markers.db` (SQLite WAL), `server.pid`, `logs/`, `search_index/`

**Exception**: `shell-hooks.zsh` always at `~/.floatty` (hardcoded in `.zshrc`).

**FLO-317 Rule**: Path functions MUST accept explicit arg OR use `#[cfg(debug_assertions)]` fallback. No hardcoded `.floatty` without gate. Preflight asserts catch violations at startup.

## Config File

`{data_dir}/config.toml`:
```toml
watch_path = "~/.claude/projects"
ollama_endpoint = "http://localhost:11434"
ollama_model = "qwen2.5:7b"
poll_interval_ms = 2000
max_retries = 3
max_age_hours = 72
workspace_name = "default"
server_port = 8765
# Remote authority mode (FLO-762): connect to a remote floatty-server instead
# of spawning a local subprocess. server_port is ignored when set. The local
# [server].api_key must match the remote server's key. Unreachable remote =
# startup error (never a silent local spawn — split-brain guard).
# remote_server_url = "http://float-box:8765"
```

**Title bar**: `floatty (dev) - workspace_name vX.Y.Z (abc1234)`

## Server Ports

- Dev: `33333` (visually distinct for log scanning)
- Release: `8765`
- WebSocket: `ws://127.0.0.1:{port}/ws`
- REST: `http://127.0.0.1:{port}/api/v1/blocks`

## MCP Bridge Ports & Instance Targeting (FLO-826)

Deterministic bands — `FLOATTY_MCP_PORT` env override, else per-profile:

| Instance | Bridge band |
|---|---|
| Release | `9223` (plugin default, unchanged) |
| Dev | `9333` |
| Hermetic test launches | pass `FLOATTY_MCP_PORT=94xx` alongside `FLOATTY_DATA_DIR` |

Floatty pre-selects a free port in the band (the plugin never exposes which
port IT bound) and advertises it in **`{data_dir}/mcp-bridge.json`**:
`{ port, pid, workspaceName, profile, version }`.

**The targeting recipe — never connect to a guessed/default port:**

1. Read `{data_dir}/mcp-bridge.json` for the instance YOU launched.
2. Verify `pid` is alive (`ps -p <pid>`) — no removal hook exists; startup
   overwrite + reader-side PID check is the staleness contract.
3. `driver_session(start, port: <port>)`.
4. Belt-and-braces: assert `get_ctx_config().data_dir` equals the intended
   data dir before ANY interaction (a stray ⌘O once landed in the release
   app, 2026-07-16).

## Logging

Location: `{data_dir}/logs/floatty.YYYY-MM-DD.jsonl` (DOT not DASH in filename)

Frontend → Rust: `logger.ts` intercepts `console.*`, forwards via `invoke('log_js')`. Shows as `"target":"js"` with `js_target` field.

Default level: `info`. Dev scripts set `RUST_LOG=debug`.

`console.debug()` → `tracing::debug!` (filtered at info). Use `console.log()` for always-visible.

### Query Logs

```bash
# Frontend logs
jq 'select(.target == "js")' ~/.floatty-dev/logs/floatty.*.jsonl

# Specific module
jq 'select(.target == "js" and .fields.js_target == "useSyncedYDoc")' ~/.floatty-dev/logs/floatty.*.jsonl

# Slow commands
jq 'select(.fields.duration_ms > 1000)' ~/.floatty-dev/logs/floatty.*.jsonl
```

See `apps/floatty/docs/architecture/LOGGING_STRATEGY.md` for complete guide.

### EnvFilter Target Gotcha (floatty_startup)

`hooks/system.rs` uses `tracing::info!(target: "floatty_startup", ...)` for startup phase timing (`search_init_complete`, `cold_start_rehydration_complete`, `hook_system_init_complete`). `EnvFilter` matches on the **target string**, not the crate path — so `floatty_core=info` does NOT match `target: "floatty_startup"`. Any new target override needs its own filter entry.

The canonical filter default lives in `logging-discipline.md` §6 (single
source — this file used to duplicate the literal string and the two copies
were a drift risk on every filter change). The `hyper=warn,reqwest=warn,opentelemetry=off`
entries prevent telemetry-induced-telemetry loops — see that file.

## OTLP Log Export (Loki Direct)

In addition to the local JSONL file, `floatty-server` exports logs via OTLP HTTP to a configurable endpoint. The file remains the source of truth — OTLP is fire-and-forget shipping that fails silently when the collector is unreachable (offline laptop, tailscale down, etc.).

### Configuration

`[server].otlp_endpoint` in `{data_dir}/config.toml`:

```toml
[server]
api_key = "floatty-xxxx"
# Point at any OTLP HTTP collector. Loki's native OTLP receiver exposes
# /otlp/v1/logs on its main port (3100 by default); Alloy / OTel Collector
# accept OTLP on 4318 (HTTP) or 4317 (gRPC). Leave unset to disable.
otlp_endpoint = "http://127.0.0.1:3100/otlp/v1/logs"
```

**Endpoint resolution order** (first match wins):
1. `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` env var (signal-specific, full URL)
2. `OTEL_EXPORTER_OTLP_ENDPOINT` env var (general, base URL; crate appends `/v1/logs`)
3. `config.otlp_endpoint` from config.toml (treated as general)

When unset, OTLP export is disabled and floatty works normally (file-only logging).

### Two paths to Loki

- **Direct to Loki** (`<loki-host>:3100/otlp/v1/logs`): logs only, no collector hop, simpler. Appropriate when you're not also exporting traces/metrics.
- **Via a collector** (Alloy, OTel Collector, etc. on `:4318/v1/logs`): needed when you also want traces → Tempo or metrics pipelines. The collector fans out logs→Loki, traces→Tempo, metrics→wherever.

### Resource attributes (become Loki labels)

| Attribute | Value | Source |
|---|---|---|
| `service.name` | `floatty-server` | hardcoded |
| `service.version` | `CARGO_PKG_VERSION` | compile-time |
| `deployment.environment` | `dev` \| `release` | `#[cfg(debug_assertions)]` |

Query in Grafana:
```logql
{service_name="floatty-server"}
{service_name="floatty-server", deployment_environment="release"}
{service_name="floatty-server", scope_name="floatty_startup"}
```

### Cardinality warning

Loki's default OTLP mapping promotes **every** tracing structured field to a Loki label. That means `tracing::info!(elapsed_ms = 46, ...)` produces a new label value per elapsed_ms observation. For startup events (few per restart) this is fine. For any hot-path instrumentation (per-request timing, per-block events), this will explode label cardinality and Loki will complain.

Mitigation is on the Loki side, not in floatty: configure `limits_config.otlp_config.log_attributes` on your Loki instance with an allowlist for which OTel attributes should become labels. Revisit when adding `#[tracing::instrument]` to hot paths.

## Sync Health

`useSyncHealth.ts`: Polls server every 120s comparing block counts. Two consecutive mismatches → full resync.

`validateSyncedState()` (FLO-247): Warns on zero blocks with backup, orphaned blocks, etc.

CRDT merge is idempotent: `applyUpdate()` on already-known state is a no-op. Not a bug.

## Keyboard & Selection

### Selection Modes

| Mode | Behavior |
|------|----------|
| `'set'` | Clear selection, set anchor only (plain click) |
| `'anchor'` | Select block AND set anchor (first Shift+Arrow, Cmd+A) |
| `'toggle'` | Toggle block in/out (Cmd+Click) |
| `'range'` | Select from anchor to target (subsequent Shift+Arrow) |

**Bug**: Using `'set'` when you mean `'anchor'` — 'set' clears without adding.

### Focus Transitions

Exit contentEditable for block ops: `blur()` then `containerRef?.focus()` (keeps tinykeys alive). Outliner container has `tabIndex={-1}`.

### Intentional Safeguard

Deleting blocks with children requires explicit selection (Cmd+A → Backspace). Backspace at start of parent does nothing. Intentional, not a bug.
