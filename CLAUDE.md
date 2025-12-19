# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

**floatty** - A Tauri v2 terminal emulator with three integrated systems:
1. **High-performance PTY** - handles 4000+ redraws/sec from tools like Claude Code
2. **Multi-tab terminals** - independent PTY per tab, platform-aware keybinds (⌘ on macOS)
3. **ctx:: Aggregation** - watches JSONL session logs, extracts markers, parses via Ollama, displays in sidebar

## Commands

```bash
npm install           # Install JS dependencies
npm run tauri dev     # Dev mode (hot reload frontend, rebuilds Rust)
npm run tauri build   # Production build
npm run lint          # ESLint
```

## Architecture

### PTY Performance Pattern (DO NOT DEVIATE)

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Reader Thread  │     │  Batcher Thread │     │   IPC Channel   │
│  (PTY read)     │ ──▶ │  (slurp ≤64KB)  │ ──▶ │  (base64 str)   │
│  blocks on read │     │  blocks on recv │     │  to frontend    │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

Critical rules:
- **Greedy slurp**: Batcher blocks on first chunk, then `try_recv()` drains all queued
- **Base64 encoding**: `Vec<u8>` → base64 string (60% faster than JSON array)
- **Tauri Channels**: Direct IPC pipe, NOT `window.emit()` (broadcasts are slow)
- **No sync work** in batcher thread

### ctx:: Aggregation System

```
~/.claude/projects/*.jsonl  ──▶  CtxWatcher  ──▶  SQLite  ──▶  CtxParser  ──▶  Sidebar
     (JSONL logs)              (file watcher)    (state)     (Ollama API)    (React)
```

**Rust modules** (`src-tauri/src/`):
| File | Purpose |
|------|---------|
| `lib.rs` | App setup, Tauri commands, config loading |
| `ctx_watcher.rs` | Watches JSONL files, extracts ctx:: lines, tracks file positions |
| `ctx_parser.rs` | Background worker calling Ollama for structured parsing |
| `db.rs` | SQLite schema, marker CRUD, file position persistence |

**React components** (`src/components/`):
| File | Purpose |
|------|---------|
| `Terminal.tsx` | Tab orchestration, keybind handling, layout |
| `TerminalPane.tsx` | Thin wrapper, attaches to terminalManager |
| `ContextSidebar.tsx` | Polls Tauri commands, renders markers with tags |

**Frontend modules** (`src/lib/`):
| File | Purpose |
|------|---------|
| `terminalManager.ts` | Singleton owning xterm lifecycle OUTSIDE React |
| `keybinds.ts` | Platform-aware keybind system (⌘ on macOS, Ctrl elsewhere) |

**State** (`src/hooks/`):
| File | Purpose |
|------|---------|
| `useTabStore.ts` | Zustand store for tab state |

### Key Data Flows

**ctx:: marker lifecycle**:
1. Watcher scans JSONL → extracts line containing `ctx::` + metadata (cwd, branch, session_id)
2. Inserts to SQLite with `status='pending'`, deterministic hash ID (dedupe)
3. Parser polls pending → calls Ollama → updates `status='parsed'` with JSON
4. Sidebar polls every 2s → displays with project/mode/issue tags

**Tauri commands** (invoked from frontend):
- `get_ctx_markers` / `get_ctx_counts` - sidebar data
- `get_ctx_config` / `set_ctx_config` - aggregator settings
- `clear_ctx_markers` - reset database

### Configuration

Config file: `~/.floatty/config.toml`
```toml
watch_path = "/Users/evan/.claude/projects"
ollama_endpoint = "http://float-box:11434"
ollama_model = "qwen2.5:7b"
poll_interval_ms = 2000
max_retries = 3
max_age_hours = 72
```

Database: `~/.floatty/ctx_markers.db` (SQLite, WAL mode)

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `⌘T` / `Ctrl+T` | New tab |
| `⌘W` / `Ctrl+W` | Close tab |
| `⌘1-9` | Jump to tab N |
| `⌘⇧[` / `⌘⇧]` | Prev/next tab |
| `⌘B` | Toggle sidebar |

Keys that always pass through to terminal: `Ctrl+C/Z/D/A/E/K/U/W/L/R` (signals, readline)

### Terminal Manager Architecture

```
React Component                    Singleton (outside React)
┌─────────────────┐               ┌─────────────────────────────┐
│  TerminalPane   │ ref callback  │    terminalManager          │
│  (thin wrapper) │ ───────────▶  │  - instances: Map<id, term> │
│                 │               │  - attach(id, container)    │
│                 │               │  - dispose(id)              │
└─────────────────┘               └─────────────────────────────┘
```

Why: React's useEffect dependency tracking caused terminals to re-initialize on tab switch. Moving lifecycle outside React eliminates this class of bugs.

## Known Issues

1. **xterm decorations** - `term.registerDecoration()` for highlighting ctx:: lines crashed with renderer errors. Removed. Could try debounced viewport-only approach.

## Do NOT

- Remove batching pattern (breaks performance)
- Use `window.emit()` instead of Channels
- Send `Vec<u8>` without base64 encoding
- Add sync work in batcher thread
- Change Ollama JSON schema without updating both `ctx_parser.rs` and `ContextSidebar.tsx`
