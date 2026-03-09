# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## TL;DR: Critical Context

**Tech Stack** (NOT React):
- **Frontend**: SolidJS (fine-grained reactivity, no virtual DOM)
- **Backend**: Tauri v2 + Rust (IPC, subprocess management)
- **Server**: Axum (headless Y.Doc authority)
- **CRDT**: Yjs (frontend) ↔ Yrs (backend) via base64-encoded updates

**Philosophy**: Shacks Not Cathedrals. Walls that can move.

**The Pattern** (40 Years Deep):
```text
Event → Handler → Transform → Project
BBS (1985) → mIRC (1995) → Redux (2015) → floatty (2026)
```

**Three Fatal Mistakes**:
1. Don't destructure SolidJS props (breaks reactivity)
2. Don't use `<For>` for heavy components (use `<Key>` from @solid-primitives/keyed)
3. Don't skip origin filtering in Y.Doc observers (causes sync loops)

---

## What This Is

**floatty** - A Tauri v2 terminal emulator with integrated outliner and consciousness siphon:
1. **High-performance PTY** - handles 4000+ redraws/sec from tools like Claude Code
2. **Multi-tab terminals** - independent PTY per tab, platform-aware keybinds (⌘ on macOS)
3. **Block-based outliner** - CRDT-backed (yjs), inline markdown formatting, zoom navigation, [[wikilinks]] for page navigation
4. **ctx:: Aggregation** - watches JSONL session logs, extracts markers, parses via Ollama, displays in sidebar
5. **Theming system** - 5 bundled themes (Dark, Light, Solarized Dark/Light, High Contrast), hot-swap via ⌘;

## Three-Layer Architecture

```text
┌─────────────────────────────────────────────────────────────────┐
│  FRONTEND (SolidJS)                                             │
│  - Y.Doc (local), debounced sync, reactive UI                   │
│  - Key: useSyncedYDoc.ts, useBlockStore.ts, httpClient.ts       │
└────────────────────────┬────────────────────────────────────────┘
                         │ invoke() for commands
                         │ HTTP/WS for Y.Doc sync
┌────────────────────────▼────────────────────────────────────────┐
│  TAURI BACKEND (Rust)                                           │
│  - Spawns floatty-server subprocess                             │
│  - ctx:: watcher, PTY management, shell execution               │
│  - Key: lib.rs, server.rs, commands/                            │
└────────────────────────┬────────────────────────────────────────┘
                         │ env: FLOATTY_PORT, FLOATTY_API_KEY
┌────────────────────────▼────────────────────────────────────────┐
│  HEADLESS SERVER (floatty-server)                               │
│  - Y.Doc authority, REST/WS API, SQLite persistence             │
│  - Key: api.rs, ws.rs, floatty-core/store.rs                    │
└─────────────────────────────────────────────────────────────────┘
```

**CRDT Sync Flow**:
1. User types → Y.Doc update → debounced queue (50ms)
2. `POST /api/v1/update` → server persists → applies to Yrs
3. Server broadcasts via WebSocket (with txId for echo prevention)
4. Other clients receive → decode base64 → `Y.applyUpdate(doc, bytes, 'remote')`

**Persistence**: SQLite append-only log + hourly .ydoc backups. Compacts every 100 updates.

## Commands

```bash
npm install           # Install JS dependencies
npm run tauri dev     # Dev mode (hot reload frontend, rebuilds Rust)
npm run lint          # ESLint
npm run test          # Run vitest (420 tests)
npm run test:watch    # Watch mode for TDD
```

### Rust Tests (IMPORTANT)

Cargo.toml is in `src-tauri/`, not the project root. The package name is `float-pty`, not `floatty`.

```bash
# Run from src-tauri/ — test filter goes AFTER `--`
cd src-tauri && cargo test -p float-pty -- test_name_here

# Multiple test filters
cd src-tauri && cargo test -p float-pty -- test_one test_two

# All Rust tests
cd src-tauri && cargo test -p float-pty
```

**Common mistakes** (do NOT do these):
```bash
cargo test -p floatty ...              # Wrong package name (it's float-pty)
cargo test -p float-pty test_name      # Missing `--` before test filter
cargo test ...                         # No Cargo.toml in project root
```

### Version Bumping

Three files must stay in sync. Use the Edit tool for JSON files — `mv` on this machine is aliased to `mv -i` which blocks on interactive confirmation.

```
src-tauri/Cargo.toml      # workspace.package.version AND package.version
package.json              # .version
src-tauri/tauri.conf.json # .version
```

**Correct approach** — use Edit tool for all three:
```
Edit: src-tauri/Cargo.toml  → "0.7.25" → "0.7.26" (replace_all: true)
Edit: package.json          → "0.7.25" → "0.7.26"
Edit: src-tauri/tauri.conf.json → "0.7.25" → "0.7.26"
```

**WRONG** — `jq ... | mv /tmp/out file` hangs waiting for interactive confirmation.

### Release Build

floatty uses a headless server architecture - the outliner CRDT state is managed by `floatty-server`, which runs as a sidecar process. For release builds:

```bash
# 1. Build the server sidecar (creates platform-specific binary)
./scripts/build-server.sh

# 2. Build the app (includes sidecar in bundle)
npm run tauri build
```

The build script copies `floatty-server` to `src-tauri/binaries/floatty-server-{target-triple}`. Tauri bundles this into the `.app`/`.dmg` automatically.

**Dev mode**: Server binary is found via workspace target paths (`target/debug/floatty-server`).

## Querying floatty-server (Claude Reference)

The server requires auth. Config lives at `~/.floatty-dev/config.toml` (dev) or `~/.floatty/config.toml` (prod).

```bash
# 1. Get port and API key from config
grep -E 'server_port|api_key' ~/.floatty-dev/config.toml

# 2. Query with auth header (example: count blocks)
curl -s -H "Authorization: Bearer <API_KEY>" "http://127.0.0.1:<PORT>/api/v1/blocks" | jq '.blocks | length'

# One-liner (extracts from config):
KEY=$(grep api_key ~/.floatty-dev/config.toml | cut -d'"' -f2) && \
PORT=$(grep server_port ~/.floatty-dev/config.toml | cut -d= -f2 | tr -d ' ') && \
curl -s -H "Authorization: Bearer $KEY" "http://127.0.0.1:$PORT/api/v1/blocks" | jq '.blocks | length'
```

**Response structure**: `{ "blocks": { "<id>": {...}, ... }, "root_ids": ["id1", "id2", ...] }`

**Common queries**:
- Block count: `.blocks | length`
- Root block count: `.root_ids | length`
- Single block: `.blocks["<block-id>"]`

### Block Context Retrieval (FLO-338)

`GET /api/v1/blocks/:id` supports optional `include` query param for context:

```bash
# Ancestors + siblings (1 API call replaces 3+ roundtrips)
curl -H "Authorization: Bearer $KEY" \
  "http://127.0.0.1:$PORT/api/v1/blocks/$ID?include=ancestors,siblings&sibling_radius=2"

# Full subtree with size estimate (agent budget planning)
curl -H "Authorization: Bearer $KEY" \
  "http://127.0.0.1:$PORT/api/v1/blocks/$ID?include=tree,token_estimate&max_depth=3"
```

| Include | What it adds |
|---------|-------------|
| `ancestors` | Parent chain up to root (max 10) |
| `siblings` | N blocks before/after within parent |
| `children` | Direct children (id + content) |
| `tree` | Full subtree DFS (max 1000 nodes) |
| `token_estimate` | totalChars, blockCount, maxDepth |

Search also supports `include_breadcrumb=true` and `include_metadata=true`.

### Short-Hash Block Resolution

`GET /api/v1/blocks/resolve/:prefix` resolves 6+ hex-char prefixes to full block UUIDs (git-sha style):

```bash
# Resolve 8-char prefix to full block
curl -H "Authorization: Bearer $KEY" \
  "http://127.0.0.1:$PORT/api/v1/blocks/resolve/0b3dc892"
# Returns: { "id": "0b3dc892-e563-4868-...", "block": {...} }
```

| Status | Meaning |
|--------|---------|
| 200 | Unique match — returns full block |
| 400 | Prefix too short (<6 chars) or invalid hex |
| 404 | No block matches prefix |
| 409 | Ambiguous — multiple blocks match (returns match list) |

If prefix is a full 36-char UUID, redirects to exact lookup. Case-insensitive matching with canonical stored key returned.

**Client-side**: `shortHashIndex` singleton memo in `WorkspaceContext` provides O(1) 8-char prefix lookups without server round-trip.

### Sync & Restore Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/v1/state` | GET | Full Y.Doc state (base64) |
| `/api/v1/state-vector` | GET | State vector for reconciliation |
| `/api/v1/state/hash` | GET | SHA256 hash + block count (sync health check) |
| `/api/v1/update` | POST | Apply Y.Doc update (CRDT merge) |
| `/api/v1/restore` | POST | **DESTRUCTIVE** - Replace entire Y.Doc state |
| `/api/v1/export/binary` | GET | Download raw Y.Doc as `.ydoc` file (Content-Disposition) |
| `/api/v1/export/json` | GET | Download human-readable JSON export (Content-Disposition) |
| `/api/v1/health` | GET | Health check with version and git info |

#### Health Endpoint

Returns server version and build info (no auth required):

```bash
curl http://127.0.0.1:$PORT/api/v1/health
# {"status":"ok","version":"0.7.17","gitSha":"b2b0c49","gitDirty":false}
```

| Field | Type | Description |
|-------|------|-------------|
| `status` | string | Always "ok" if server is running |
| `version` | string | Workspace version from Cargo.toml |
| `gitSha` | string? | Short (7-char) commit SHA at build time |
| `gitDirty` | bool? | Whether uncommitted changes existed at build |

#### Export Endpoints

For agents/cron to trigger exports without UI:

```bash
# Binary export (perfect CRDT restore)
curl -o floatty-backup.ydoc -H "Authorization: Bearer $KEY" \
  "http://127.0.0.1:$PORT/api/v1/export/binary"

# JSON export (human-readable, lossy)
curl -o floatty-backup.json -H "Authorization: Bearer $KEY" \
  "http://127.0.0.1:$PORT/api/v1/export/json"
```

Filenames include timestamp: `floatty-2026-02-02-134512.ydoc`

#### `/api/v1/update` vs `/api/v1/restore`

**`/update` (CRDT merge)**: Applies an update via CRDT merge. If the server has *newer* state vectors than the update, nothing happens (CRDT says "I already have this"). Use for normal sync.

**`/restore` (nuclear option)**: Completely replaces server state. Use for disaster recovery.

```bash
# CRDT merge (may do nothing if server is ahead)
curl -X POST -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"update": "<base64>"}' \
  "http://127.0.0.1:$PORT/api/v1/update"

# DESTRUCTIVE RESTORE - nukes server state, replaces with backup
curl -X POST -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"state": "<base64>"}' \
  "http://127.0.0.1:$PORT/api/v1/restore"
```

**When to use `/restore`**:
- Restoring from a `.ydoc` backup after data loss
- Migrating state between instances
- Server state is corrupted and needs full replacement

**Warning**: `/restore` clears ALL existing state. Connected clients will receive a broadcast of the new state and should resync their local Y.Doc.

### Binary Import Script

```bash
# Restore from .ydoc backup (uses /api/v1/restore)
npx tsx scripts/binary-import.ts ~/path/to/backup.ydoc
```

### Ghost Writer Path (REST → WebSocket Clients)

When external tools (CLI agents, automation) write to the server via REST, changes propagate to all connected WebSocket clients:

```text
REST Client
    │ POST /api/v1/update { update: "<base64>", tx_id: "..." }
    ▼
Server (api.rs)
    ├─ 1. Persist to SQLite (FIRST)
    ├─ 2. Apply to in-memory Y.Doc
    └─ 3. broadcaster.broadcast(update, tx_id)
    ▼
WebSocket Clients (via tokio::broadcast)
    └─ Each client receives: { txId: "...", data: "<base64>" }
        └─ Client applies if txId doesn't match recent sent IDs
```

**Known Risk**: Non-atomic persist→broadcast. Server crash between steps 1 and 3 means update is persisted but not broadcast. Mitigated by 120-second health check (`useSyncHealth.ts`) which detects block count drift and triggers full resync.

## Testing

**Stack**: Vitest + jsdom + @solidjs/testing-library

**Philosophy**: Store-first testability. Test pure logic without fighting DOM/contentEditable quirks.

### Key Files

| File | Purpose |
|------|---------|
| `src/context/WorkspaceContext.tsx` | DI context for block/pane stores; singleton memos (`pageNames`, `shortHashIndex`); `createMockBlockStore()` factory |
| `src/hooks/useCursor.ts` | Cursor abstraction; `createMockCursor()` for tests |
| `src/hooks/useBlockInput.ts` | Pure `determineKeyAction()` function returns typed `KeyboardAction` |
| `src/hooks/useBlockInput.test.ts` | 32 keyboard behavior tests (no DOM needed) |
| `src/lib/blockContext.ts` | Explicit discrete state types for keyboard behavior |
| `src/components/BlockItem.test.tsx` | Context injection tests |

### Testing Pattern

```typescript
// Test pure logic without rendering
import { determineKeyAction } from './useBlockInput';

it('splits block when Enter in middle', () => {
  const result = determineKeyAction('Enter', false, null, {
    block: { content: 'hello world', ... },
    cursorOffset: 5,
    ...
  });

  expect(result.type).toBe('split_block');
  expect(result.offset).toBe(5);
});

// Test components with mock stores
import { WorkspaceProvider, createMockBlockStore } from '../context/WorkspaceContext';

render(() => (
  <WorkspaceProvider blockStore={createMockBlockStore({ ... })}>
    <BlockItem id="test" paneId="pane" depth={0} onFocus={() => {}} />
  </WorkspaceProvider>
));
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
     (JSONL logs)              (file watcher)    (state)     (Ollama API)    (SolidJS)
```

**Rust modules** (`src-tauri/src/`):

| File | Purpose |
|------|---------|
| `lib.rs` | App setup, Tauri commands, config loading |
| `paths.rs` | Centralized `DataPaths` struct - all paths derive from `FLOATTY_DATA_DIR` |
| `config.rs` | `AggregatorConfig` with workspace_name, server_port, ollama settings |
| `ctx_watcher.rs` | Watches JSONL files, extracts ctx:: lines, tracks file positions |
| `ctx_parser.rs` | Background worker calling Ollama for structured parsing |
| `db.rs` | SQLite schema, marker CRUD, file position persistence |
| `server.rs` | Spawns floatty-server subprocess, passes `FLOATTY_DATA_DIR` env |

**SolidJS components** (`src/components/`):

| File | Purpose |
|------|---------|
| `Terminal.tsx` | Tab orchestration, keybind handling, layout |
| `TerminalPane.tsx` | Thin wrapper, attaches to terminalManager |
| `ContextSidebar.tsx` | Polls Tauri commands, renders markers with tags |
| `PaneLayout.tsx` | Recursive split pane layout with resize handles |
| `ResizeOverlay.tsx` | Centralized resize handle rendering and drag logic |
| `Outliner.tsx` | Block tree view with zoom support |
| `OutlinerPane.tsx` | Wrapper for outliner in pane layout |
| `BlockItem.tsx` | Individual block with keybinds (Enter, Tab, etc.) |
| `BlockDisplay.tsx` | Display layer for inline formatting overlay |
| `Breadcrumb.tsx` | Navigation trail for zoomed block view |
| `LinkedReferences.tsx` | Backlinks display when zoomed into a page under `pages::` |
| `PaneLinkOverlay.tsx` | Dual-mode letter overlay for pane linking (⌘L) and focus jumping (⌘J) |

**Frontend modules** (`src/lib/`):

| File | Purpose |
|------|---------|
| `terminalManager.ts` | Singleton owning xterm lifecycle OUTSIDE SolidJS |
| `keybinds.ts` | Platform-aware keybind system (⌘ on macOS, Ctrl elsewhere) |
| `layoutTypes.ts` | Layout tree types and pure manipulation functions |
| `blockTypes.ts` | Block type definitions and prefix detection (`sh::`, `ai::`, etc.) |
| `markdownParser.ts` | Parses markdown output into block hierarchy (headings, lists, fences) |
| `inlineParser.ts` | Tokenizes inline markdown (`**bold**`, `*italic*`, `` `code` ``, `[[wikilinks]]`) for overlay |
| `cursorUtils.ts` | Cursor position utilities for keybind logic |
| `executor.ts` | Command execution for `sh::` blocks (child_process via Tauri) |
| `handlers/artifact.ts` | `artifact::` handler — React/Babel transpilation for Claude.ai JSX artifacts |
| `handlers/doorTypes.ts` | Door type definitions (`Door`, `DoorMeta`, `DoorContext`); `selfRender` flag for inline doors |
| `handlers/doorLoader.ts` | Door discovery, blob import pipeline, import shim system, hot-reload listener |
| `tvResolver.ts` | `$tv()` pattern resolution - spawns TV picker, receives selection from Rust |
| `events/blockEventBus.ts` | Typed event bus for block lifecycle events (`block:create`, `block:update`, `block:delete`, `block:move`) |

**Block Lifecycle Hooks** (`src/lib/handlers/hooks/`):

| File | Purpose |
|------|---------|
| `ctxRouterHook.ts` | Extracts `ctx::` markers → stores in `block.metadata.markers` |
| `outlinksHook.ts` | Extracts `[[wikilink]]` targets → stores in `block.metadata.outlinks` |

Hooks subscribe to `blockEventBus`, use Origin filtering to prevent infinite loops. See `docs/architecture/FLOATTY_HOOK_SYSTEM.md`.

**State** (`src/hooks/`):

| File | Purpose |
|------|---------|
| `useTabStore.ts` | SolidJS store for tab state (id, title, tmuxSession, ptyPid) |
| `useLayoutStore.ts` | SolidJS store for per-tab split pane layouts |
| `usePaneStore.ts` | Per-pane view state (collapsed, zoom, focus, navigation history). Use `zoomTo()` API for navigation. |
| `useBlockStore.ts` | Block tree CRUD operations (Y.Doc backed) |
| `useBlockOperations.ts` | Navigation helpers (findNext/Prev, getAncestors) |
| `useCursor.ts` | DOM cursor abstraction for testability |
| `useBlockInput.ts` | Keyboard coordinator — `determineKeyAction()` + sub-hook scaffold in `blockInput/` |
| `useBacklinkNavigation.ts` | Page navigation, `pages::` container lookup, backlinks extraction |
| `usePaneLinkStore.ts` | Session-scoped pane→pane linking, overlay mode, link resolution |
| `useCommandBar.ts` | Command palette state (⌘K) — pages + built-in commands |

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

**Shell hooks & semantic state** (`~/.floatty/shell-hooks.zsh` → `terminalManager.ts`):

Shell hooks emit OSC 133 (prompt lifecycle) and OSC 1337 (CurrentDir, Command) sequences. The terminal manager parses these into `SemanticState` per terminal instance: `cwd`, `lastCommand`, `lastExitCode`, `lastDuration`, `hooksActive`, `tmuxSession`.

**tmux auto-reattach**: Detected via command parsing, NOT shell-hook OSC (OSC sequences from inside tmux don't pass through to the outer terminal). When `Command=tmux new -s NAME` or `Command=tmux attach -t NAME` is seen, `tmuxSession` is set on the tab. Persisted in workspace SQLite. On restart, tabs with tmuxSession spawn `zsh -c "tmux attach-session -t NAME 2>/dev/null || exec zsh -l"` — falls back to fresh shell if session is gone.

### Configuration

**Data Directory** (Build Profile Isolation):

Paths derive from build profile (prevents accidental dev/release data sharing):
- **Debug builds** (`cargo build`): `~/.floatty-dev`
- **Release builds** (`cargo build --release`): `~/.floatty`

Override with `FLOATTY_DATA_DIR` environment variable if needed.

Path resolution (in `src-tauri/src/paths.rs`):
```
{FLOATTY_DATA_DIR}/
├── config.toml       # User configuration
├── ctx_markers.db    # SQLite (WAL mode)
├── server.pid        # Server process tracking
├── logs/             # Structured JSON logs (daily rotation)
└── search_index/     # Tantivy full-text index
```

**Exception**: `shell-hooks.zsh` always stays at `~/.floatty` (hardcoded in user's `.zshrc`).

**Path Resolution Rule** (FLO-317): Every function that resolves a data directory path MUST either:
1. Accept an explicit path argument (preferred), OR
2. Use `#[cfg(debug_assertions)]` in its fallback (like `DataPaths::default_root()`)

Never hardcode `.floatty` as a fallback without a `#[cfg]` gate. Runtime preflight asserts in `lib.rs` and `main.rs` catch violations at startup.

**Config file**: `{data_dir}/config.toml`
```toml
watch_path = "~/.claude/projects"       # Claude Code session logs
ollama_endpoint = "http://localhost:11434"  # Standard Ollama port
ollama_model = "qwen2.5:7b"
poll_interval_ms = 2000
max_retries = 3
max_age_hours = 72                      # Look back 3 days for markers
workspace_name = "default"              # Shows in title bar
server_port = 8765                      # Per-workspace port isolation
```

**Title bar format**: `floatty (dev) - workspace_name v0.4.2 (abc1234)`

**floatty-server** (headless CRDT sync):
- Default port: `33333` (dev) / `8765` (release) - visually distinct for log scanning
- Override: `server_port` in config.toml
- WebSocket: `ws://127.0.0.1:{port}/ws`
- REST API: `http://127.0.0.1:{port}/api/v1/blocks`
- Server receives `FLOATTY_DATA_DIR` from parent process

### Logging (Structured with tracing)

**Log location**: `{data_dir}/logs/floatty.YYYY-MM-DD.jsonl` (JSON lines, rotates daily)

**IMPORTANT**: Log filename uses DOT not DASH: `floatty.2026-01-23.jsonl`

**Frontend → Rust forwarding**: `src/lib/logger.ts` intercepts all `console.*` calls and forwards to Rust via `invoke('log_js')`. Messages appear with `"target":"js"` and `js_target` field showing the source (e.g., `"js_target":"useSyncedYDoc"`).

**Log level filtering**: Default level is `info`. Debug logs are enabled in dev scripts:
```bash
npm run tauri dev   # Includes RUST_LOG=debug automatically
```

**Query logs with jq**:
```bash
# Find frontend logs (all console.* output)
jq 'select(.target == "js")' ~/.floatty-dev/logs/floatty.*.jsonl

# Find specific frontend module logs
jq 'select(.target == "js" and .fields.js_target == "useSyncedYDoc")' ~/.floatty-dev/logs/floatty.*.jsonl

# Find slow shell commands (>1s)
jq 'select(.fields.duration_ms > 1000)' ~/.floatty-dev/logs/floatty.*.jsonl

# AI command errors only
jq 'select(.level == "ERROR" and .target == "floatty::commands::ai")' ~/.floatty-dev/logs/floatty.*.jsonl
```

**Example log entries**:
```json
// Rust-originated
{"timestamp":"...","level":"INFO","target":"float_pty_lib::server","fields":{"message":"Spawning floatty-server"},...}

// Frontend-originated (via logger.ts)
{"timestamp":"...","level":"INFO","target":"js","fields":{"message":"Full resync complete: 257928 bytes applied","js_target":"useSyncedYDoc"},...}
```

**Why some logs are missing**: `console.debug()` maps to `tracing::debug!` which is filtered at `info` level. Use `console.log()` for logs that should always appear, `console.debug()` for verbose output.

**Dev builds**: Pretty-printed to stdout AND written to file.

See `docs/architecture/LOGGING_STRATEGY.md` for complete guide and LLM integration patterns.

### Keybind Registry

**Purpose**: When adding new keybinds, check this list to avoid conflicts.

**Reserved (pass through to terminal)**: `Ctrl+C/Z/D/A/E/K/U/W/L/R` (signals, readline)

**Terminal/Global** (in `Terminal.tsx`):
- `⌘T` / `Ctrl+T` - New tab
- `⌘W` / `Ctrl+W` - Close tab
- `⌘1-9` - Jump to tab N
- `⌘⇧[` / `⌘⇧]` - Prev/next tab
- `⌘B` - Toggle sidebar
- `⌘K` - Command palette
- `⌘L` - Link pane (overlay picker)
- `⌘J` - Focus pane (overlay picker — jump to any pane)
- `⌘⌥Arrow` - Directional pane focus (up/down/left/right)

**Outliner** (in `Outliner.tsx` via tinykeys):

| Key | Behavior |
|-----|----------|
| `Enter` | Command block: execute handler. Regular: create sibling/split |
| `⌘Enter` | Zoom into subtree |
| `Escape` | Zoom out to full tree |
| `Tab` | Indent (at line start) or insert spaces |
| `⇧Tab` | Outdent (at line start) |
| `⌘.` | Toggle collapse |
| `⌘⌫` | Delete block and subtree |
| `⌘⇧M` / `Ctrl+Shift+M` | Export markdown to clipboard |
| `⌘⇧J` / `Ctrl+Shift+J` | Export JSON (FLO-247) |
| `⌘⇧B` / `Ctrl+Shift+B` | Export binary Y.Doc (FLO-247) |
| `⌘[` / `⌘]` | Navigation history back/forward |
| `⌘Z` / `⌘⇧Z` | Undo/redo |
| `⌘A` | Select all (escalates: text → block → tree) |
| `⌘0-3` | Expand to level N |

**Click handlers** (in `BlockDisplay.tsx`): `[[wikilinks]]` navigate to pages, modifier-click opens in splits.

### Terminal Manager Architecture

```
SolidJS Component                  Singleton (outside SolidJS)
┌─────────────────┐               ┌─────────────────────────────┐
│  TerminalPane   │ ref callback  │    terminalManager          │
│  (thin wrapper) │ ───────────▶  │  - instances: Map<id, term> │
│                 │               │  - attach(id, container)    │
│                 │               │  - dispose(id)              │
└─────────────────┘               └─────────────────────────────┘
```

Why: Framework reactivity caused terminals to re-initialize on tab switch. Moving lifecycle outside SolidJS eliminates this class of bugs.

### Inline Formatting Overlay Architecture

Two-layer technique for styled inline markdown while preserving cursor behavior:

```
┌─────────────────────────────────────────────────────────────┐
│  .block-content-wrapper (position: relative, color class)   │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  .block-display (position: absolute, pointer-events:   │ │
│  │                  none, color: inherit)                  │ │
│  │  └─ <For> tokens → <span class="md-bold/italic/code">  │ │
│  └────────────────────────────────────────────────────────┘ │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  .block-edit (contentEditable, color: transparent,     │ │
│  │               caret-color: visible)                    │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

**Key mechanics:**
- Display layer shows styled tokens (`**bold**` → yellow, `*italic*` → cyan, `` `code` `` → green)
- Edit layer has transparent text but visible cursor via `caret-color`
- Block-type colors (headings, prefixes) applied to wrapper, inherited by display layer
- Tokens parsed via `inlineParser.ts` using `createMemo()` for reactivity
- Uses `<For>` for token iteration (lightweight, no identity issues)

**Theme-awareness:** All colors use CSS variables (`--color-ansi-*`), auto-adapting on theme switch.

### Wikilinks & Page Navigation

Roam-style `[[wikilinks]]` with a `pages::` container architecture:

```
Root blocks
├── some block with [[Page Name]] link
├── pages::                          ← Container (like sh::, ai::)
│   ├── # Page Name                  ← Pages are children of pages::
│   ├── # Another Page
│   └── # meeting:: [[nick <--> evan]]  ← Nested brackets supported
└── more blocks
```

**Key mechanics:**
- `pages::` block at root level contains all linkable pages
- Pages stored with `# ` prefix for heading styling when zoomed
- Matching strips heading prefix (case-insensitive): `[[My Page]]` matches `# My Page`
- Clicking `[[link]]` creates page under `pages::` if missing, then zooms to it
- `LinkedReferences` component shows backlinks when zoomed into a page

**Nested wikilinks:**
- Parser uses bracket-counting (not regex) for proper nesting
- `[[outer [[inner]]]]` is one link with target `outer [[inner]]`
- Inner `[[inner]]` is separately clickable (dotted underline, cyan hover)
- Backlinks extracted recursively: `[[outer [[inner]]]]` creates backlinks to both targets

**Files:**
- `inlineParser.ts` - Bracket-counting tokenizer for `[[Target]]` and `[[Target|Alias]]`
- `useBacklinkNavigation.ts` - Navigation logic, page creation, backlink extraction
- `LinkedReferences.tsx` - Displays backlinks when zoomed into page
- `BlockDisplay.tsx` - Renders nested wikilinks with separate click handlers

### Pane Linking & Focus (FLO-223)

tmux-inspired cross-pane navigation. Pane links are session-scoped (pane IDs are ephemeral UUIDs).

```
Pane A (source) ──link──▶ Pane B (target)
  │                          │
  ├─ [[wikilink]] click  ───▶ navigates in B (not A)
  ├─ chirp navigate      ───▶ navigates in B
  └─ Chaining: A→B, B→C     navigates cascade
```

**Two overlay modes** (in `PaneLinkOverlay.tsx`):
- **Link** (`⌘L`): Pick target outliner pane. Excludes source. Cyan accent.
- **Focus** (`⌘J`): Jump to any pane (terminals + outliners). Yellow accent.

**Visual feedback**:
- Unfocused panes dim to `unfocused_pane_opacity` (config.toml, default 0.4)
- Linked partner pane: cyan border + midpoint opacity (brighter than unlinked)
- Toggle dimming via Cmd+K "Toggle Pane Dimming"

**Key files:**
- `usePaneLinkStore.ts` - Pane link map, overlay mode signal, `resolveLink()` chain
- `PaneLinkOverlay.tsx` - Letter overlay picker, dual-mode (link/focus)
- `Terminal.tsx` - Keybind + command handlers, dimming config, link tint effect

### Artifact Handler & Chirp Protocol

`artifact::` renders Claude.ai JSX artifacts in sandboxed iframes. `chirp::` enables bidirectional iframe↔outline communication.

```
Outliner                           Iframe (artifact)
  │ artifact:: path/to/file.jsx      │
  │ ──── render via Babel ──────────▶│
  │                                   │ chirp('block', {content})
  │◀──── postMessage ────────────────│
  │ creates chirp:: child block       │
  │                                   │ chirp('navigate', {target})
  │◀──── postMessage ────────────────│
  │ routes through pane link          │
```

**Key files:**
- `src/lib/handlers/artifact.ts` - Transpile JSX + mount in iframe
- `src/components/views/DoorHost.tsx` - Iframe lifecycle, postMessage bridge

## The Pattern (40 Years Deep)

Everything is: **Event → Handler → Transform → Project**

```text
Block created  →  Handler matches prefix  →  Transform (execute)  →  Project to UI/index
Y.Doc update   →  Observer fires          →  Transform (sync)     →  Project to signals
User input     →  Keybind matches         →  Transform (action)   →  Project to state
```

This is store-and-forward. BBS message handlers. mIRC bots. Redux middleware. Same shape.

See `docs/architecture/FORTY_YEAR_PATTERN.md` for the full philosophy.

### Shacks Not Cathedrals

This codebase follows a "shacks not cathedrals" philosophy:
- **Prefer pragmatic solutions** over elegant abstractions
- **Walls that can move** — avoid over-engineering future flexibility
- **Store-and-forward** — the 40-year invariant from BBS to floatty
- **Transcribe, don't invent** — the patterns are known, just write them down

The architecture isn't designed — it's emerged from BBS thinking (1985), mIRC bots (1995), Redux middleware (2015), and floatty hooks (2026). Same shape. Event-driven. Interceptable. Transformable. Projectable.

## Four Bug Categories

When debugging or reviewing code, check for these patterns:

| Category | Symptoms | Fix |
|----------|----------|-----|
| **Re-Parenting Trap** | xterm WebGL errors on tab/split change | Dispose WebGL addon BEFORE DOM reparent |
| **Sync Loop** | Infinite updates, frozen UI | Add origin filtering in Y.Doc observers |
| **PTY Zombies** | Orphan processes after close/crash | Guard disposal with `disposing` Set, `kill_all` on window close |
| **Split Brain** | Stale data after sync, wrong block selected | Use ID-based lookups (not index), re-fetch after CRDT update |

## SolidJS Mental Models (CRITICAL)

See @.claude/rules/solidjs-patterns.md for detailed patterns on:
- `<For>` vs `<Key>` for heavy components
- Props destructuring (don't)
- Store proxy cloning
- `<Show>` vs CSS display
- Ref cleanup timing

## Keyboard & Selection Architecture

### Cursor Detection

**Use `cursor.isAtStart()` not `cursor.getOffset() === 0`**

The `isAtStart()` method uses `isCursorAtContentStart()` which properly handles empty text nodes, leading `<br>` elements, and other contentEditable edge cases. The `getOffset()` approach uses range cloning and innerText measurement which can disagree in edge cases.

### Selection Modes

The outliner has four selection modes in `handleSelect()`:

| Mode | Behavior | Use Case |
|------|----------|----------|
| `'set'` | Clear selection, set anchor only | Plain click/navigation |
| `'anchor'` | Select block AND set as anchor | First Shift+Arrow, Cmd+A |
| `'toggle'` | Toggle block in/out of selection | Cmd+Click |
| `'range'` | Select from anchor to target | Subsequent Shift+Arrow |

**Common bug**: Using `'set'` when you mean `'anchor'` - 'set' clears selection without adding the block.

### Shift+Arrow Selection Pattern

```text
1. Focus A, no selection
2. Shift+Down → onSelect(A, 'anchor'), focus(B)  // A selected, B focused
3. Shift+Down → onSelect(B, 'range'), focus(C)   // A,B selected, C focused
```

Key insight: `'range'` uses `props.id` (current block), not `next`. The range extends TO where you are, THEN focus moves.

### Focus Transitions (Text Mode → Block Mode)

When exiting contentEditable to do block operations (e.g., Cmd+A):

```typescript
if (isEditing) {
  (document.activeElement as HTMLElement)?.blur();
  containerRef?.focus();  // CRITICAL: keeps keyboard events flowing to tinykeys
}
```

The outliner container has `tabIndex={-1}` for this purpose.

### CSS Selection States

```css
/* Editing: cursor in block (DOM focus) - accent border */
.block-item:not(.block-selected):focus-within .block-content { ... }

/* Selected for operations (Cmd+A, Shift+Arrow) - cyan border */
.block-selected .block-content { ... }
```

These are independent states. Selection always wins visually (`:not(.block-selected)` on focus rule).

### Intentional Safeguards

**Deleting blocks with children** requires explicit selection:
1. Backspace at start of parent → does nothing (protection)
2. Cmd+A → Backspace → deletes block + subtree

This prevents accidental deletion of large branches. Document as intentional, not a bug.

## Sync Debugging Infrastructure

**Health Check** (`useSyncHealth.ts`): Polls server every 120s comparing block counts (NOT hash — Y.Doc encoding varies). Reduced from 30s — sequence numbers now handle fast gap detection, this is a safety net. Two consecutive mismatches trigger full resync.

### Sequence Number Architecture (PR #119)

Fast gap detection layer complementing CRDT eventual consistency.

```
Server broadcasts:  seq 100 → 101 → 102 → [client offline] → 105
Client receives:    seq 100 → 101 → 102 → reconnect → 105 (gap: 103-104!)
                                                      ↓
                                          Fetch GET /api/v1/updates?after=102&before=105
                                                      ↓
                                          Apply 103, 104, then 105
```

**Key Components**:
| File | Purpose |
|------|---------|
| `SyncSequenceTracker.ts` | Gap detection, contiguous range tracking, fill orchestration |
| `useSyncedYDoc.ts` | Integrates tracker, handles echo vs external messages |
| `api.rs` | `GET /api/v1/updates` - paginated update retrieval (50/batch) |

**Heartbeat**: Server broadcasts seq-only messages every 30s when idle. Closes the window between persist and broadcast—if server persists update but crashes before broadcast, heartbeat reveals the gap on next connection.

**Two Observer Paths**:
- `observeSeq(seq)` - External messages: detect gaps, trigger fill
- `observeEcho(seq)` - Own messages echoed back: still detect gaps (your update at seq 105 reveals you missed 101-104)

**IndexedDB Persistence**: `lastKnownSeq` survives page reload. On reconnect, client requests updates since persisted seq rather than full state fetch.

**Restore Handling**: Full state restore (`/api/v1/restore`) broadcasts special message that resets all clients' seq baselines—prevents "gap from beginning of time" scenario.

See @.claude/rules/serde-api-patterns.md for API contract patterns discovered during this work.

**Key Logging Points**:
| Location | Log | Purpose |
|----------|-----|---------|
| `useSyncedYDoc.ts:270` | `[useSyncedYDoc] Attached singleton update handler` | Handler lifecycle |
| `useSyncedYDoc.ts:638` | `[WS] First connection — accepting messages immediately` | FLO-269 fix |
| `useSyncHealth.ts:101` | `[SyncHealth] Block count mismatch detected` | Drift detection |
| `ws.rs:53` | `Broadcast {} bytes to {} client(s)` | Server broadcasts |

**State Validation** (`FLO-247`): `validateSyncedState()` warns on suspicious conditions (zero blocks but backup exists, orphaned blocks, etc.)

**Silent No-Op Risk**: CRDT merge is idempotent. If server already has an update, `applyUpdate()` is a no-op — no observeDeep fires, no UI change. This is correct CRDT behavior, not a bug.

## Known Issues

1. **xterm decorations** - `term.registerDecoration()` for highlighting ctx:: lines crashed with renderer errors. Removed. Could try debounced viewport-only approach.

## Do NOT

See @.claude/rules/do-not.md for critical anti-patterns (PTY/Rust, SolidJS, Y.Doc/Search, Rust Backend).

## Y.Doc Patterns

See @.claude/rules/ydoc-patterns.md for CRDT architecture patterns (source of truth, metadata storage, observer wrapping, origin filtering).
