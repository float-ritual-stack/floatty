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
```

**Title bar**: `floatty (dev) - workspace_name v0.4.2 (abc1234)`

## Server Ports

- Dev: `33333` (visually distinct for log scanning)
- Release: `8765`
- WebSocket: `ws://127.0.0.1:{port}/ws`
- REST: `http://127.0.0.1:{port}/api/v1/blocks`

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

See `docs/architecture/LOGGING_STRATEGY.md` for complete guide.

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
