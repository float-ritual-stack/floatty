# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

**floatty** - A Tauri v2 terminal emulator with integrated outliner and consciousness siphon:
1. **High-performance PTY** - handles 4000+ redraws/sec from tools like Claude Code
2. **Multi-tab terminals** - independent PTY per tab, platform-aware keybinds (⌘ on macOS)
3. **Block-based outliner** - CRDT-backed (yjs), inline markdown formatting, zoom navigation
4. **ctx:: Aggregation** - watches JSONL session logs, extracts markers, parses via Ollama, displays in sidebar
5. **Theming system** - 5 bundled themes (Dark, Light, Solarized Dark/Light, High Contrast), hot-swap via ⌘;

## Commands

```bash
npm install           # Install JS dependencies
npm run tauri dev     # Dev mode (hot reload frontend, rebuilds Rust)
npm run tauri build   # Production build
npm run lint          # ESLint
npm run test          # Run vitest (268 tests)
npm run test:watch    # Watch mode for TDD
```

## Testing

**Stack**: Vitest + jsdom + @solidjs/testing-library

**Philosophy**: Store-first testability. Test pure logic without fighting DOM/contentEditable quirks.

### Key Files

| File | Purpose |
|------|---------|
| `src/context/WorkspaceContext.tsx` | DI context for block/pane stores; `createMockBlockStore()` factory |
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
| `ctx_watcher.rs` | Watches JSONL files, extracts ctx:: lines, tracks file positions |
| `ctx_parser.rs` | Background worker calling Ollama for structured parsing |
| `db.rs` | SQLite schema, marker CRUD, file position persistence |

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

**Frontend modules** (`src/lib/`):

| File | Purpose |
|------|---------|
| `terminalManager.ts` | Singleton owning xterm lifecycle OUTSIDE SolidJS |
| `keybinds.ts` | Platform-aware keybind system (⌘ on macOS, Ctrl elsewhere) |
| `layoutTypes.ts` | Layout tree types and pure manipulation functions |
| `blockTypes.ts` | Block type definitions and prefix detection (`sh::`, `ai::`, etc.) |
| `markdownParser.ts` | Parses markdown output into block hierarchy (headings, lists, fences) |
| `inlineParser.ts` | Tokenizes inline markdown (`**bold**`, `*italic*`, `` `code` ``) for overlay |
| `cursorUtils.ts` | Cursor position utilities for keybind logic |
| `executor.ts` | Command execution for `sh::` blocks (child_process via Tauri) |
| `tvResolver.ts` | `$tv()` pattern resolution - spawns TV picker, receives selection from Rust |

**State** (`src/hooks/`):

| File | Purpose |
|------|---------|
| `useTabStore.ts` | SolidJS store for tab state |
| `useLayoutStore.ts` | SolidJS store for per-tab split pane layouts |
| `usePaneStore.ts` | Per-pane view state (collapsed, zoomedRootId) |
| `useBlockStore.ts` | Block tree CRUD operations (Y.Doc backed) |
| `useBlockOperations.ts` | Navigation helpers (findNext/Prev, getAncestors) |
| `useCursor.ts` | DOM cursor abstraction for testability |
| `useBlockInput.ts` | Pure keyboard logic extraction (`determineKeyAction`) |

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
watch_path = "~/.claude/projects"       # Claude Code session logs
ollama_endpoint = "http://localhost:11434"  # Standard Ollama port
ollama_model = "qwen2.5:7b"
poll_interval_ms = 2000
max_retries = 3
max_age_hours = 72                      # Look back 3 days for markers
```

Database: `~/.floatty/ctx_markers.db` (SQLite, WAL mode)

### Logging

**Log location**: `~/Library/Logs/dev.float.floatty/float-pty.log`

Setup in `lib.rs` via `tauri_plugin_log`:
```rust
tauri_plugin_log::Builder::default()
    .level(log::LevelFilter::Info)
    .targets([
        tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
        tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Webview),
        tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir { file_name: None }),
    ])
```

**When debugging ctx:: sidebar issues**, check for:
```bash
grep -i "ctx\|watcher\|parser\|ollama" ~/Library/Logs/dev.float.floatty/float-pty.log
```

**Common ctx:: issues**:
- No ctx:: logs at all → watcher/parser not starting (check `CtxDatabase::open()` or config issues)
- "Failed to watch directory" → `watch_path` in config doesn't exist (tilde not expanded?)
- Parser errors → Ollama endpoint wrong or unreachable (check `ollama_endpoint` in config)

**Note**: Early boot logging (before tauri_plugin_log init) uses `eprintln!` and goes to stderr, not the log file.

### Keyboard Shortcuts

**Terminal/Global:**

| Key | Action |
|-----|--------|
| `⌘T` / `Ctrl+T` | New tab |
| `⌘W` / `Ctrl+W` | Close tab |
| `⌘1-9` | Jump to tab N |
| `⌘⇧[` / `⌘⇧]` | Prev/next tab |
| `⌘B` | Toggle sidebar |

Keys that always pass through to terminal: `Ctrl+C/Z/D/A/E/K/U/W/L/R` (signals, readline)

**Outliner (block editing):**

| Key | On `sh::`/`ai::` block | On regular block |
|-----|------------------------|------------------|
| `Enter` | Execute command | Create sibling/split |
| `⌘Enter` | Zoom into subtree | Zoom into subtree |
| `Escape` | Zoom out to full tree | Zoom out to full tree |
| `Tab` | Indent (at line start) or insert spaces | Indent (at line start) or insert spaces |
| `⇧Tab` | Outdent (at line start) or remove spaces | Outdent (at line start) or remove spaces |
| `⌘.` | Toggle collapse | Toggle collapse |
| `⌘⌫` | Delete block and subtree | Delete block and subtree |

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

## SolidJS Mental Models (CRITICAL)

See @.claude/rules/solidjs-patterns.md for detailed patterns on:
- `<For>` vs `<Key>` for heavy components
- Props destructuring (don't)
- Store proxy cloning
- `<Show>` vs CSS display
- Ref cleanup timing

## Known Issues

1. **xterm decorations** - `term.registerDecoration()` for highlighting ctx:: lines crashed with renderer errors. Removed. Could try debounced viewport-only approach.

## Do NOT

See @.claude/rules/do-not.md for critical anti-patterns (PTY/Rust and SolidJS).
