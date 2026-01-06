# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

**floatty** - A Tauri v2 terminal emulator with integrated outliner and consciousness siphon:
1. **High-performance PTY** - handles 4000+ redraws/sec from tools like Claude Code
2. **Multi-tab terminals** - independent PTY per tab, platform-aware keybinds (⌘ on macOS)
3. **Block-based outliner** - CRDT-backed (yjs), inline markdown formatting, zoom navigation, [[wikilinks]] for page navigation
4. **ctx:: Aggregation** - watches JSONL session logs, extracts markers, parses via Ollama, displays in sidebar
5. **Theming system** - 5 bundled themes (Dark, Light, Solarized Dark/Light, High Contrast), hot-swap via ⌘;

## Commands

```bash
npm install           # Install JS dependencies
npm run tauri dev     # Dev mode (hot reload frontend, rebuilds Rust)
npm run lint          # ESLint
npm run test          # Run vitest (268 tests)
npm run test:watch    # Watch mode for TDD
```

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
| `LinkedReferences.tsx` | Backlinks display when zoomed into a page under `pages::` |

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
| `useBacklinkNavigation.ts` | Page navigation, `pages::` container lookup, backlinks extraction |

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
| `⌘⇧M` | Export outline to clipboard (markdown) | Export outline to clipboard (markdown) |
| `Click [[link]]` | Navigate to page | Navigate to page |
| `⌘Click [[link]]` | Open page in horizontal split | Open page in horizontal split |
| `⌘⇧Click [[link]]` | Open page in vertical split | Open page in vertical split |

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

## The Pattern (40 Years Deep)

Everything is: **Event → Handler → Transform → Project**

```
Block created  →  Handler matches prefix  →  Transform (execute)  →  Project to UI/index
Y.Doc update   →  Observer fires          →  Transform (sync)     →  Project to signals
User input     →  Keybind matches         →  Transform (action)   →  Project to state
```

This is store-and-forward. BBS message handlers. mIRC bots. Redux middleware. Same shape.

See `docs/ARCHITECTURE_LINEAGE.md` for the full philosophy.

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

## Known Issues

1. **xterm decorations** - `term.registerDecoration()` for highlighting ctx:: lines crashed with renderer errors. Removed. Could try debounced viewport-only approach.

## Do NOT

See @.claude/rules/do-not.md for critical anti-patterns (PTY/Rust and SolidJS).
