# Changelog

All notable changes to floatty are documented here.

## [0.2.1] - 2026-01-03

### Keyboard Navigation & Selection (PR #54)

Major improvements to outliner keyboard behavior and visual feedback.

#### Bug Fixes
- **Backspace merge** - Fixed cursor detection using `cursor.isAtStart()` instead of unreliable `getOffset()===0`
- **Cmd+A selection** - First press selects text, second press selects block (progressive expansion)
- **Shift+Arrow** - New 'anchor' mode properly selects starting block on first press

#### Visual Distinction
- Editing blocks show accent border (`:focus-within`)
- Selected blocks show cyan border (`.block-selected`)
- Clear separation prevents confusion between states

#### New Features
- **⌘⇧M Export** (FLO-102) - Export outline to clipboard as markdown
- Clipboard error handling with graceful fallback (#55)

### Outliner Improvements (PR #50, #51)

- **Block movement** (FLO-75) - ⌘⇧↑/↓ to move blocks within siblings
- **Pane state cloning** (FLO-77) - Clone-on-split preserves focused block + zoom
- **Progressive expand/collapse** (FLO-66) - ⌘E/⌘⇧E with depth sequences
- **Extended Cmd+A** (FLO-95) - Selection includes collapsed subtrees, 10 indent levels

### Sync Reliability (PR #48, #49)

- **Ref-counted handlers** - Fixed multiple handlers per pane causing 3x network traffic
- **Backup preservation** - Partial sync failures no longer clear local backup
- **Echo prevention** - Transaction ID tracking prevents broadcast loops
- **WS reconnect sync** - Proper state fetch after reconnection

### Backend Cleanup (PR #53)

- Modularized `lib.rs` (1141→648 lines)
- Extracted `config.rs` (154 lines) + `server.rs` (327 lines)
- Renamed `CtxDatabase` → `FloattyDb` (reflects actual scope)

### Linear Tickets Closed
FLO-66, FLO-75, FLO-77, FLO-95, FLO-102

---

## [0.2.0] - 2026-01-03

### Headless Architecture (PR #47)

Major architectural shift: floatty is now headless-first. The block store lives in a standalone HTTP server.

#### floatty-core Extraction
- Extracted `floatty-core` crate with Block types, YDocPersistence, YDocStore
- Schema v2: Nested Y.Map structure for proper CRDT sync
- Tauri commands are now thin wrappers over floatty-core

#### floatty-server (HTTP API)
- Standalone Axum HTTP server at `127.0.0.1:8765`
- REST endpoints: `/blocks` (GET/POST), `/blocks/:id` (GET/PATCH/DELETE)
- Y.Doc sync: `/state`, `/update`, `/health`
- API key authentication via Bearer token
- WebSocket broadcast for realtime sync across clients

#### UI Wiring
- Frontend uses HTTP client instead of Tauri IPC for Y.Doc sync
- Server auto-spawned by Tauri on app start
- Blocks created via curl appear instantly in UI

#### Testing
- 9 API tests for floatty-server (Axum tower ServiceExt pattern)
- 283 frontend tests (Vitest)
- 13 floatty-core tests

#### Bug Fixes
- Fixed Axum route syntax (`:id` not `{id}`)
- Fixed tilde expansion in `watch_path` config
- Fixed Ollama endpoint config (pointed to wrong host)

### Linear Tickets Closed
FLO-87 (External write API)

---

## [0.1.0] - 2025-12-28

### 10-Day Sprint (Dec 19-28) - Foundation to Usable

This sprint took floatty from "barely works" to "daily driver capable" - a terminal emulator with integrated outliner and consciousness siphon.

### Core Infrastructure (Week 1)

- **Multi-tab terminals** (PR#1) - Independent PTY per tab with platform-aware keybinds
- **Split pane support** (PR#2) - Focus navigation (⌘⌥Arrow), draggable resize handles
- **SolidJS migration** (PR#3) - Moved from React to SolidJS for better reactivity

### Outliner Features (Week 2)

- **Block zoom** (FLO-40, PR#9) - Cmd+Enter focuses on subtree with breadcrumb navigation
- **Keybind unification** (PR#11) - Centralized keybind system, platform-aware
- **Inline formatting** (FLO-51, PR#17) - Two-layer overlay for bold/italic/code styling
- **Markdown parser** (FLO-42, PR#16) - Auto-formats command output into block hierarchy
- **Multi-block selection** (FLO-74, PR#30) - Click, Shift+Click, Cmd+Click, Shift+Arrow
- **Progressive Cmd+A** - Select block → heading scope → all (tinykeys sequences)

### Terminal Features

- **OSC 133/1337 integration** (FLO-54/55, PR#20) - Shell integration with status bar
- **Terminal config** (PR#19) - Shift+Enter, clipboard paste, new icon
- **Scroll position fix** (FLO-88, PR#27) - Preserved during pane resize

### Persistence & State

- **Y.Doc append-only** (FLO-61, PR#21) - CRDT deltas instead of full doc writes
- **Y.Doc singleton** (PR#25) - Fixed lifecycle for outliner persistence
- **Workspace persistence** (FLO-81, PR#26) - Layout, split ratios, pane types restored
- **Close button fix** (FLO-85) - Red X works after onCloseRequested change

### Theming

- **Theme system** (FLO-50, PR#15) - 5 bundled themes, hot-swap via ⌘;

### Testing & Architecture

- **Testing infrastructure** (FLO-73, PR#23-24) - Store-first testability, mock factories
- **Keyboard architecture refactor** - 5-layer architecture documented, BlockContext type
- **268 tests** - Up from 0 at project start

### Bug Fixes

- **Split pane block structure** (FLO-41) - No longer reverts to single text block
- **ArrowDown navigation** (FLO-92, PR#29) - Creates trailing block at tree end
- **Focused pane targeting** (FLO-43, PR#12) - Split/close operates on focused pane
- **Shift+Arrow selection** - Works regardless of cursor position
- **Markdown export** - No longer double-adds prefixes

### PRs Merged

29 PRs merged in 10 days:
- #1-3: Tabs, splits, SolidJS
- #6-9: Context sidebar, identity fixes, block zoom
- #11-17: Keybinds, panes, resize, themes, markdown, formatting
- #19-27: Terminal, persistence, testing
- #28-29: UX fixes, navigation
- #30: Multi-select (in progress)

### Linear Tickets Closed

FLO-6, FLO-7, FLO-40, FLO-41, FLO-42, FLO-43, FLO-50, FLO-51, FLO-54, FLO-55, FLO-60, FLO-61, FLO-73, FLO-81, FLO-85, FLO-88, FLO-92

---

*floatty: Terminal + Outliner + Consciousness Siphon*
