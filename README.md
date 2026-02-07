# floatty

A high-performance terminal emulator built with Tauri v2 + xterm.js, featuring a "consciousness siphon" that captures structured context markers in real-time.

## What It Does

- **Multi-tab terminals** with full PTY support per tab
- **GPU-accelerated rendering** via WebGL addon
- **ctx:: Siphon** - Parses terminal output for `ctx::` markers and displays them in a sidebar ToC
- **Platform-aware keybinds** - Cmd on macOS, Ctrl on Windows/Linux
- **High-throughput optimized** - Handles Claude Code's 4000+ redraws/sec without stuttering

## Architecture Highlights

### The "Greedy Slurp" Pattern
```
PTY Output → Reader Thread → mpsc channel → Batcher Thread → base64 → IPC Channel → xterm
```

- **Reader Thread**: Blocks on PTY read, pushes to channel
- **Batcher Thread**: Blocks on first byte (0 CPU idle), then "slurps" all queued data (up to 64KB)
- **Result**: 4000 IPC calls/sec → 60-144Hz steady updates

### Performance Optimizations

| Optimization | Problem | Solution | Impact |
|--------------|---------|----------|--------|
| Greedy Slurp | 4000+ events/sec kills UI | Batch in Rust before IPC | 60Hz smooth |
| Base64 | Vec<u8> → slow JSON array | Base64 string | 60% faster |
| Tauri Channels | window.emit broadcasts | Direct IPC pipe | No overhead |

## Quick Start

```bash
# Install dependencies
npm install

# Run development
npm run tauri dev

# Build for production
npm run tauri build
```

## Keyboard Shortcuts

Uses platform-aware keybinds: **Cmd** on macOS, **Ctrl** on Windows/Linux.

### Tab Management
| Shortcut | Action |
|----------|--------|
| `Cmd+T` | New tab |
| `Cmd+W` | Close tab |
| `Cmd+1-9` | Go to tab N |
| `Cmd+Shift+[` | Previous tab |
| `Cmd+Shift+]` | Next tab |

### UI
| Shortcut | Action |
|----------|--------|
| `Cmd+B` | Toggle context sidebar |

### Pane Management

| Shortcut | Action |
|----------|--------|
| `Cmd+D` | Split pane horizontally |
| `Cmd+Shift+D` | Split pane vertically |
| `Cmd+O` | Split outliner pane horizontally |
| `Cmd+Shift+O` | Split outliner pane vertically |
| `Cmd+Shift+W` | Close active pane |
| `Cmd+Option+←/→/↑/↓` | Focus adjacent pane |

### Mouse Controls
- Drag a pane using the small `⋮⋮` handle in the pane's top-right corner.
- Drop on a pane edge drop-zone (`←`, `→`, `↑`, `↓`) to place the dragged pane on that side.
- Press `Esc` during a pane drag to cancel without moving.

### Terminal Reserved (always pass through)
These keys are never intercepted - they reach the PTY for shell signals:
- `Ctrl+C` (SIGINT), `Ctrl+Z` (SIGTSTP), `Ctrl+D` (EOF)
- `Ctrl+L`, `Ctrl+R`, `Ctrl+A`, `Ctrl+E`, `Ctrl+K`, `Ctrl+U`, `Ctrl+W`

## ctx:: Marker Format

The terminal captures markers in this format:
```
- ctx::2025-12-16 @ 08:30 AM [project::myproject] [mode::coding] Your message here
```

Parsed into:
- **timestamp**: 2025-12-16
- **time**: 08:30 AM
- **project**: myproject
- **mode**: coding
- **message**: Your message here

## OSC 7337 Protocol

Send structured context via escape sequence (invisible in terminal):
```bash
printf '\e]7337;{"type":"ctx","line":"ctx::2025-12-16 @ 08:30 AM [project::x] message"}\a'
```

## Headless Architecture (NEW)

floatty is headless-first: the block store lives in a standalone HTTP server that desktop, CLI, and agents can all connect to.

```
┌──────────┐  ┌──────────┐  ┌──────────┐
│ Desktop  │  │   CLI    │  │  Agent   │
└────┬─────┘  └────┬─────┘  └────┬─────┘
     └──────┬──────┴───────┬──────┘
            │  HTTP/WS     │
      ┌─────▼──────────────▼─────┐
      │    floatty-server        │
      │    (127.0.0.1:8765)      │
      └──────────┬───────────────┘
           ┌─────▼─────┐
           │  SQLite   │
           └───────────┘
```

### HTTP API

```bash
# Get all blocks
curl -H "Authorization: Bearer $API_KEY" http://127.0.0.1:8765/api/v1/blocks

# Create block
curl -X POST -H "Authorization: Bearer $API_KEY" \
  -d '{"content": "Hello from CLI", "parentId": "..."}' \
  http://127.0.0.1:8765/api/v1/blocks
```

Blocks created via API appear instantly in UI via WebSocket.

API key is stored in `~/.floatty/config.toml`.

## Multi-Workspace Support (NEW)

All data paths derive from `FLOATTY_DATA_DIR` environment variable:

```bash
# Default behavior (production)
~/.floatty/

# Development workspace (isolated from release)
FLOATTY_DATA_DIR=~/.floatty-dev npm run tauri dev
```

**Data directory structure**:
```
{FLOATTY_DATA_DIR}/
├── config.toml       # workspace_name, server_port, ollama settings
├── ctx_markers.db    # SQLite database
├── server.pid        # Server process tracking
├── logs/             # Structured JSON logs
└── search_index/     # Tantivy full-text index
```

**Config options for workspace isolation**:
```toml
workspace_name = "dev"    # Shows in title bar
server_port = 8766        # Unique port per workspace
```

**Title bar**: Shows workspace + version + git commit: `floatty (dev) - workspace v0.4.2 (abc1234)`

This enables:
- Running dev and release builds simultaneously (different ports)
- Test isolation via temporary data directories
- Future workspace switching for multi-environment setups

## Structured Logging (NEW)

Floatty uses structured logging with `tracing` for LLM-parseable observability.

**Log location**: `{FLOATTY_DATA_DIR}/logs/floatty-{date}.jsonl` (daily rotation)

**JSON format** - every operation logs structured fields:
```json
{
  "timestamp": "2026-01-08T08:00:00.000Z",
  "level": "INFO",
  "target": "float_pty_lib",
  "fields": {
    "duration_ms": 42,
    "output_bytes": 1024,
    "exit_code": 0
  }
}
```

**Query logs with jq**:
```bash
# Find slow operations (use your data dir)
jq 'select(.fields.duration_ms > 1000)' ~/.floatty/logs/floatty-*.jsonl

# Trace specific operations
jq 'select(.span.marker_id == "ctx_abc123")' ~/.floatty/logs/*.jsonl
```

**Enable verbose logging**: `RUST_LOG=debug`

See `docs/CHANGELOG_STRUCTURED_LOGGING.md` for details.

## Tech Stack

- **Frontend**: SolidJS, TypeScript, Vite
- **Terminal**: xterm.js + WebGL + Unicode11 + Ligatures addons
- **Outliner**: Block tree with yjs CRDT, inline markdown formatting
- **Backend**: Tauri v2, Rust
- **Block Server**: floatty-server (Axum HTTP + WebSocket)
- **PTY**: Vendored tauri-plugin-pty with custom batching
- **Theming**: 5 bundled themes, hot-swap via ⌘;
- **Logging**: Structured tracing with JSON output for LLM observability

## Known Issues

- xterm decoration API unstable (removed for now)
- Auto-fire to evna not wired yet (manual capture works)

## Credits

- Architecture patterns pair-coded with Gemini
- Based on [tauri-plugin-pty](https://github.com/aspect-build/tauri-plugin-pty)

## License

MIT
