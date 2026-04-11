# floatty

A high-performance terminal emulator with an integrated outliner and consciousness siphon, built with Tauri v2 + SolidJS + Rust.

## Features

- **Multi-tab terminals** with full PTY support, GPU-accelerated rendering via xterm.js WebGL
- **Block-based outliner** with CRDT sync (Yjs), inline markdown formatting, `[[wikilinks]]`, and zoom navigation
- **ctx:: aggregation** watches session logs, extracts structured markers, parses via Ollama, displays in sidebar
- **Split panes** with drag-and-drop rearrangement and resizable dividers
- **Command bar** (`Cmd+K`) for fuzzy page navigation and actions
- **5 themes** (Default, Dracula, Nord, Tokyo Night, Matte Black), hot-swap via `Cmd+;`
- **Platform-aware keybinds** (Cmd on macOS, Ctrl on Windows/Linux)
- **High-throughput optimized** - handles 4000+ redraws/sec from tools like Claude Code
- **tmux auto-reattach** - tabs remember tmux sessions across restarts
- **Shell hooks** - semantic terminal state (cwd, last command, exit code, duration)
- **Undo/redo** - full CRDT-backed undo history in the outliner

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  FRONTEND (SolidJS + xterm.js + Yjs)                            │
│  Reactive UI, local Y.Doc, debounced sync                       │
└────────────────────────┬────────────────────────────────────────┘
                         │ invoke() for commands
                         │ HTTP/WS for Y.Doc sync
┌────────────────────────▼────────────────────────────────────────┐
│  TAURI BACKEND (Rust)                                           │
│  PTY management, ctx:: watcher, shell execution                 │
└────────────────────────┬────────────────────────────────────────┘
                         │ FLOATTY_PORT, FLOATTY_API_KEY
┌────────────────────────▼────────────────────────────────────────┐
│  HEADLESS SERVER (floatty-server, Axum)                         │
│  Y.Doc authority, REST/WS API, SQLite persistence               │
└─────────────────────────────────────────────────────────────────┘
```

The block store lives in a standalone HTTP server (`floatty-server`) that desktop, CLI, and agents can all connect to. CRDT sync flows through Yjs (frontend) and Yrs (backend) via base64-encoded updates.

### PTY Performance

```
PTY Output → Reader Thread → mpsc → Batcher Thread → base64 → IPC Channel → xterm
```

The "greedy slurp" pattern: batcher blocks on first byte (0 CPU idle), then drains all queued data (up to 64KB). Result: 4000 IPC calls/sec collapse to 60-144Hz steady updates.

| Optimization | Problem | Solution |
|--------------|---------|----------|
| Greedy Slurp | 4000+ events/sec kills UI | Batch in Rust before IPC |
| Base64 | `Vec<u8>` → slow JSON array | Base64 string (60% faster) |
| Tauri Channels | `window.emit()` broadcasts | Direct IPC pipe |

## Quick Start

```bash
# Install dependencies
npm install

# Run in development mode (hot reload frontend, rebuilds Rust)
npm run tauri:dev

# Run tests
npm run test:run

# Lint
npm run lint
```

### Release Build

```bash
# 1. Build the server sidecar
./scripts/build-server.sh

# 2. Build the app (includes sidecar in bundle)
npm run tauri build
```

### Rust Tests

The Cargo workspace is in `src-tauri/`. The package name is `float-pty`.

```bash
cd src-tauri && cargo test -p float-pty              # All Rust tests
cd src-tauri && cargo test -p float-pty -- test_name  # Specific test (note the --)
```

## Keyboard Shortcuts

Platform-aware: **Cmd** on macOS, **Ctrl** on Windows/Linux.

### Tabs

| Shortcut | Action |
|----------|--------|
| `Cmd+T` | New tab |
| `Cmd+W` | Close tab |
| `Cmd+1-9` | Jump to tab N |
| `Cmd+Shift+[` / `]` | Previous / next tab |

### Panes

| Shortcut | Action |
|----------|--------|
| `Cmd+D` | Split terminal horizontally |
| `Cmd+Shift+D` | Split terminal vertically |
| `Cmd+O` | Split outliner horizontally |
| `Cmd+Shift+O` | Split outliner vertically |
| `Cmd+Shift+W` | Close active pane |
| `Cmd+Option+Arrow` | Focus adjacent pane |

Panes can also be rearranged by dragging the `:::` handle in the top-right corner and dropping on an edge zone.

### Outliner

| Shortcut | Action |
|----------|--------|
| `Enter` | Create sibling / split block at cursor |
| `Cmd+Enter` | Zoom into subtree |
| `Escape` | Zoom out to full tree |
| `Tab` / `Shift+Tab` | Indent / outdent |
| `Cmd+.` | Toggle collapse |
| `Cmd+Backspace` | Delete block and subtree |
| `Cmd+Up` / `Down` | Move block up / down |
| `Cmd+A` | Select all (escalates: text, block, tree) |
| `Cmd+0-3` | Expand to level N |
| `Cmd+[` / `]` | Navigation history back / forward |
| `Cmd+Z` / `Cmd+Shift+Z` | Undo / redo |
| `Cmd+Shift+M` | Export markdown to clipboard |
| `Cmd+Shift+J` | Export JSON to clipboard |
| `Cmd+Shift+B` | Export binary Y.Doc |

### Global

| Shortcut | Action |
|----------|--------|
| `Cmd+B` | Toggle sidebar |
| `Cmd+K` | Command bar |
| `Cmd+;` | Next theme |
| `Cmd+=` / `Cmd+-` | Zoom in / out |

### Terminal Reserved

These keys always pass through to the PTY:
`Ctrl+C`, `Ctrl+Z`, `Ctrl+D`, `Ctrl+L`, `Ctrl+R`, `Ctrl+A`, `Ctrl+E`, `Ctrl+K`, `Ctrl+U`, `Ctrl+W`

## Outliner

The outliner is a block-based editor backed by a Yjs CRDT document. Blocks support:

- **Inline formatting**: `**bold**`, `*italic*`, `` `code` `` rendered as overlays on contentEditable
- **Wikilinks**: `[[Page Name]]` for inter-page navigation (Roam-style)
- **Prefix types**: `sh::` (executable shell), `ai::` (AI context), `ctx::` (context markers)
- **Nested zoom**: `Cmd+Enter` zooms into any block's subtree, `Escape` zooms out
- **Backlinks**: When zoomed into a page, linked references are shown below

Pages live under a `pages::` container block. Clicking a `[[wikilink]]` creates the page if it doesn't exist, then zooms to it.

## Headless Server API

The block store is served by `floatty-server`. All endpoints require `Authorization: Bearer <API_KEY>` (except `/health`).

Config lives at `~/.floatty-dev/config.toml` (dev) or `~/.floatty/config.toml` (release).

```bash
# Get API key and port from config
grep -E 'server_port|api_key' ~/.floatty-dev/config.toml

# Query blocks
curl -H "Authorization: Bearer $KEY" http://127.0.0.1:$PORT/api/v1/blocks

# Health check (no auth)
curl http://127.0.0.1:$PORT/api/v1/health
```

### Key Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/v1/blocks` | GET | All blocks |
| `/api/v1/state` | GET | Full Y.Doc state (base64) |
| `/api/v1/update` | POST | Apply CRDT update (merge) |
| `/api/v1/restore` | POST | Replace entire Y.Doc state (destructive) |
| `/api/v1/export/binary` | GET | Download `.ydoc` backup |
| `/api/v1/export/json` | GET | Download human-readable JSON |
| `/api/v1/health` | GET | Version, git SHA, status |

Changes made via REST propagate to all connected WebSocket clients in real time.

## ctx:: Aggregation

The terminal watches Claude Code session logs (`~/.claude/projects/*.jsonl`) for `ctx::` markers:

```
ctx::2026-01-15 @ 10:30 AM [project::floatty] [mode::debugging] Fixed sync loop
```

Markers are extracted by a file watcher, stored in SQLite, parsed by Ollama into structured data (project, mode, tags), and displayed in the sidebar. Poll interval, Ollama model, and look-back window are configurable in `config.toml`.

## Configuration

Data paths are isolated by build profile to prevent dev/release collisions:

| Build | Data Directory |
|-------|---------------|
| Debug | `~/.floatty-dev/` |
| Release | `~/.floatty/` |
| Override | `FLOATTY_DATA_DIR=...` |

```
{data_dir}/
├── config.toml       # workspace_name, server_port, ollama settings
├── ctx_markers.db    # SQLite (WAL mode)
├── server.pid        # Server process tracking
├── logs/             # Structured JSON logs (daily rotation)
└── search_index/     # Tantivy full-text index
```

### config.toml

```toml
workspace_name = "default"
server_port = 8765
watch_path = "~/.claude/projects"
ollama_endpoint = "http://localhost:11434"
ollama_model = "qwen2.5:7b"
poll_interval_ms = 2000
max_age_hours = 72
```

Title bar displays: `floatty (dev) - workspace_name v0.7.41 (abc1234)`

## Logging

Structured JSON logs via `tracing`, daily rotation.

**Location**: `{data_dir}/logs/floatty.YYYY-MM-DD.jsonl`

Frontend `console.*` calls are forwarded to Rust and appear with `"target":"js"`.

```bash
# Find frontend logs
jq 'select(.target == "js")' ~/.floatty-dev/logs/floatty.*.jsonl

# Find slow operations
jq 'select(.fields.duration_ms > 1000)' ~/.floatty-dev/logs/floatty.*.jsonl
```

Verbose logging: `RUST_LOG=debug` (enabled automatically in dev mode).

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | SolidJS, TypeScript, Vite |
| Terminal | xterm.js + WebGL + Unicode11 addons |
| Outliner | Yjs CRDT, contentEditable, tinykeys |
| Backend | Tauri v2, Rust |
| Server | Axum (HTTP + WebSocket), Yrs, SQLite |
| Search | Tantivy full-text index |
| Theming | 5 themes, CSS variables, hot-swap |
| Logging | tracing (Rust) + structured JSON |

### Rust Workspace

```
src-tauri/
├── Cargo.toml          # Workspace root
├── src/                # float-pty (Tauri app + PTY)
├── floatty-core/       # Shared CRDT and block store logic
└── floatty-server/     # Headless server (Axum)
```

## Credits

- Architecture patterns pair-coded with Gemini
- Based on [tauri-plugin-pty](https://github.com/aspect-build/tauri-plugin-pty)

## License

MIT
