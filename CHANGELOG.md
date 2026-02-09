# Changelog

All notable changes to floatty are documented here.

## [Unreleased]

---

## [0.7.25] - 2026-02-08

### Features

- **Diagnostics strip**: Replaced hardcoded "DEV" badge with dynamic diagnostics strip showing server port, build type (`debug`/`release`), and config path. Toggled via `Ctrl+Shift+D`. Removed orange accent override — diagnostics is informational, not an alarm.

### Bug Fixes

- **`info::` showing undefined values**: Fixed `is_dev_build` and `data_dir` returning `undefined` in IPC responses. Changed `#[serde(skip)]` to `#[serde(skip_deserializing, default)]` with explicit filtering in `save_to` to prevent runtime fields leaking into config.toml.

### Improvements

- **Renamed dev-mode → diagnostics concept**: `dev_mode_visuals` → `show_diagnostics` (config field, with `alias` for backward compat), `toggle_dev_visuals` → `toggle_diagnostics` (Tauri command), `applyDevModeOverride` → `setDiagnosticsVisible` (frontend). 14 files updated.

---

## [0.7.24] - 2026-02-08

### Features

- **Dev mode visual distinction** (FLO-259): Orange accent override, DEV badge in status bar, port display, `Ctrl+Shift+D` toggle (persists to config.toml). Runtime-only `is_dev_build` and `data_dir` config fields.
- **`info::` diagnostic handler**: Dumps build/config/sync diagnostics as child blocks in outliner with topic filtering (`info:: sync`, `info:: config`, `info:: build`). Idempotent re-run via output block pattern.

### Bug Fixes

- **Terminal clipboard mediation** (FLO-310): Bracketed paste mode for nvim/helix, OSC 52 via `@xterm/addon-clipboard` with custom Tauri clipboard provider (tmux copy → system clipboard), clickable URLs via `@xterm/addon-web-links` with Tauri IPC handler.
- **WebLinksAddon clicks silently failing**: `window.open()` no-ops in Tauri webview. Added `open_url` command with http/https scheme validation, routed through native `open` command.
- **Serde config fields**: Changed `skip_deserializing` to `skip` on runtime-only config fields to prevent serialization of transient state.

### Improvements

- **Sync gap detection** (FLO-269): Handle heartbeat-only sequence gaps without fetching updates. Prevents unnecessary full resyncs from idle heartbeat increments.

---

## [0.7.23] - 2026-02-08

### Features

- **Cross-pane block drag-and-drop** (FLO-115, PR #127): Drag blocks between outliner panes using drag handles. Pointer-based drop resolution with above/below/inside zones, cycle prevention, undo isolation via `stopUndoCaptureBoundary()`, and `block:move` event emission. Auto-expands collapsed targets on drop, scrolls dropped block into view, and flashes subtree highlight for 1.2s.

### Bug Fixes

- **Block text vanishing while typing `::`** (PR #128): Fixed display overlay rendering empty when `hasInlineFormatting()` hint fired but parser produced no tokens. BlockDisplay now falls back to raw content instead of empty overlay. Tightened prefix marker detection to line-leading or bracketed `[word::` only.
- **UTF-8 panic in log previews** (45ece30): Fixed byte-slice panic on multi-byte characters (box-drawing, arrows) in metadata extraction and ctx parser — use `.chars().take(N)` instead of `&content[..N]`.

### Improvements

- **Event system**: `block:move` event type with `BlockMoveDetails` payload (source/target pane, drop position, old/new parent and index). Block updates now populate `changedFields` in event envelopes.
- **Sync reliability**: Force full recovery on reconnect buffer overflow. Seed workspace save sequence from persisted state. Drain projection scheduler queue during active flush. Prevent stale async saves from overwriting newer state.
- **Architecture**: Event-driven ctx sidebar refresh (replaces polling). Scoped terminal keybind capture to global actions. Explicit dependency control for workspace bootstrap. Version-signal persistence tracking replaces deep object diffing.

---

## [0.7.22] - 2026-02-07

### Features

- **Layout**: Outer edge drop zones for full-height column snapping (PR #126). Dragging a pane to the absolute left or right edge of the layout creates a full-height column alongside the entire existing layout tree.

### Bug Fixes

- **Layout**: Fixed ghost resize dividers lingering after pane drag-drop rearrangement. ResizeOverlay now re-syncs handle positions when the layout tree structure changes.

---

## [0.7.21] - 2026-02-07

### Features

- **Pane drag-and-drop rearrangement** (FLO-120, PR #124): Drag handles on terminal and outliner panes for rearranging split layouts via drop zones (left/right/up/down). Pure immutable tree operations, event-driven resize sync, Esc to cancel, visual glyph hints.

### Improvements

- **Accessibility**: `prefers-reduced-motion` media query disables drag handle and drop zone transitions
- **Debuggability**: `fitAndFocusWhenPaneRefsReady` logs warning on retry exhaustion instead of silent fallthrough

---

## [0.7.20] - 2026-02-06

### Features

- **Box-drawing pretty-print** (PR #122): Block tree debug output uses box-drawing characters with ANSI coloring for readable hierarchy visualization
- **Bidirectional resync** (PR #123): `triggerFullResync()` now pushes local-only diff via state vector before pulling server state — prevents silent data loss when local edits haven't reached server
- **Post-resync health verification** (PR #123): After full resync, re-checks block counts and shows yellow "drift" indicator instead of false green if counts still diverge

### Bug Fixes

- **Surgical Y.Array mutations** (FLO-280, PR #123): Replaced destructive delete-all-then-push pattern on `childIds` Y.Arrays with surgical helpers (`insertChildId`, `removeChildId`, `appendChildId`, etc.) — prevents CRDT duplication when divergent docs merge during bidirectional resync or crash recovery. 17 call sites migrated, 6 helpers added.
- **Cross-parent childIds duplication** (PR #123): Startup integrity check detects and fixes blocks appearing in multiple parents' `childIds` arrays — keeps the canonical parent, removes stale references
- **Orphan block re-homing** (PR #123): Blocks whose `parentId` points to a parent that doesn't list them in `childIds` are now re-homed on startup
- **Tree integrity check** (PR #123): Comprehensive startup validation covers orphans, cross-parent duplication, and parent↔child consistency
- **Insert index clamping** (PR #123): `insertChildId` and `insertChildIds` clamp `atIndex` to valid range, preventing Y.Array out-of-bounds errors
- **Drift status protection** (PR #123): `setSyncStatus('synced')` now guards with `!isDriftStatus()` to prevent health check drift indicator from being clobbered by normal sync paths

---

## [0.7.19] - 2026-02-05

### Features

- **Block lifecycle hooks** (PR #120): Hook system using `blockEventBus` for metadata extraction
  - `ctxRouterHook` extracts `ctx::` markers and `[project::X]`, `[mode::Y]`, `[issue::Z]` tags → `block.metadata.markers`
  - `outlinksHook` extracts `[[wikilink]]` targets → `block.metadata.outlinks` (enables backlink queries)
  - Hooks use Origin filtering to prevent infinite loops
  - Null-safe metadata merge guards against legacy data
  - Stale metadata cleared when patterns removed from blocks

---

## [0.7.18] - 2026-02-05

### Features

- **Server health endpoint** (b2b0c49): Added version and git info to health endpoint for operational visibility

### Bug Fixes

- **Scroll lock race condition** (FLO-278, PR #121): Replaced inline `overflow: hidden` manipulation with CSS class toggle (`scroll-locked`), eliminating race between focus routing and RAF-based scroll preservation that caused scroll to stop responding after zoom/paste/wikilink/history operations
- **Stale server cleanup** (427031a): Kill stale servers by port before rebuild to prevent port conflicts

---

## [0.7.17] - 2026-02-05

### Features

- **Sequence number sync hardening** (PR #119): Complete CRDT sync layer with gap detection, incremental reconnect, and 30-second heartbeat for reliable message ordering
- **SyncSequenceTracker** (PR #119): Extracted pure state machine class for sequence tracking with 23 unit tests — tracks `lastSeenSeq`, `lastContiguousSeq`, gap queue management
- **Incremental reconnect** (PR #119): On WebSocket reconnect, fetch only missing updates via `/api/v1/updates?since=X` instead of full resync — bandwidth optimization for stable connections
- **REST→WS broadcast** (PR #119): External tools (CLI agents, automation) can write via REST `/api/v1/update` and changes automatically broadcast to all WebSocket clients

### Bug Fixes

- **Split-brain prevention** (PR #119): Persist `lastContiguousSeq` instead of `lastSeenSeq` — prevents missing updates after reload when gaps exist (lastSeenSeq can jump on out-of-order messages)
- **Gap detection on echo** (PR #119): Own messages returning with higher-than-expected seq now trigger gap detection (your update at seq 105 reveals you missed 101-104)
- **HMR timer cleanup** (PR #119): Fixed reference to renamed timer variable in HMR disposal block
- **API unknown fields rejection** (PR #119): Added `deny_unknown_fields` to all request structs — snake_case `parent_id` now returns 400 instead of being silently ignored

### Documentation

- **Architectural audit report** (`docs/ARCHITECTURAL_AUDIT.md`): Complete review of sync layer including known risks and mitigations
- **Sequence number review** (`docs/architecture/SEQUENCE_NUMBER_REVIEW.md`): Deep dive into gap detection, persistence safety, and edge cases
- **serde API patterns rule** (`.claude/rules/serde-api-patterns.md`): Codifies `deny_unknown_fields` requirement and camelCase conventions

---

## [0.7.16] - 2026-02-04

### Bug Fixes

- Fixed first API PATCH not rendering in client by skipping redundant HTTP fetch on initial WS connect (FLO-269)
- Bumped server broadcast logging to info level for sync diagnostics
- Redirected floatty-server stderr to `server.log` for release build visibility

---

## [0.7.15] - 2026-02-03

### Features

- **Inline breadcrumb tree expansion** (FLO-263, PR #118): Search result breadcrumbs unfold inline as a tree — click `▸` between crumbs to peek at siblings, on-path child continues with remaining trail, multiple peeks supported concurrently
- **Output block keyboard navigation** (FLO-263, PR #118): Arrow keys enter/exit search results, Escape deselects, Enter navigates to focused result, Cmd+Enter opens in split. Output blocks are no longer keyboard dead zones
- **Output block operations** (FLO-263, PR #118): Tab/⇧Tab indent/outdent, ⌘↑↓ move, Backspace delete (with child-protection guard) — all work on search/daily output blocks

### Bug Fixes

- **Output block focus routing** (FLO-263): Separate `outputFocusRef` wrapper prevents focus from being stolen by the main contentEditable routing effect
- **Platform-aware modifier keys**: Use `isMac ? metaKey : ctrlKey` consistently across output block keyboard handler and search result split-click
- **Breadcrumb empty ancestors**: Empty parent blocks show `(empty)` placeholder instead of being silently skipped (prevents peek index misalignment)
- **Breadcrumb sibling rendering**: Siblings appearing after the on-path child in tree order are now rendered
- **ARIA on non-focused element**: Removed `aria-activedescendant` from display-only listbox (focus lives on parent wrapper)

### Documentation

- **Architecture map** (`ARCHITECTURE_MAP.md`): Canonical four-layer model with status markers, six invariants, document index
- **Keyboard control patterns** (`KEYBOARD_CONTROL_PATTERNS.md`): Four keyboard patterns with decision tree
- **Rich output handler guide** (`RICH_OUTPUT_HANDLER_GUIDE.md`): Step-by-step guide for adding new `prefix::` handlers
- **Inline expansion patterns** (`INLINE_EXPANSION_PATTERNS.md`): Per-item state signals within output views
- **MDX-lite vision** (`MDX_LITE_VISION.md`): Ghost spec for outline hierarchy as component container syntax
- **Output block patterns rule** (`.claude/rules/output-block-patterns.md`): Display-only views, single focus point, dual-focus anti-pattern

---

## [0.7.14] - 2026-02-03

### Features

- **Search reindex endpoint** (FLO-261, PR #117): `POST /api/v1/search/reindex` triggers full rehydration from Y.Doc without restart

### Bug Fixes

- **Search query escaping** (FLO-261, PR #117): Escape all Tantivy query syntax characters (`::`, `[]`, `()`, `*`, `?`, etc.) — queries containing `ctx::`, `[[wikilinks]]`, or `[project::X]` no longer cause 500 errors
- **Search error status code**: Query parse errors now return 400 Bad Request instead of 500 Internal Server Error
- **Search error logging**: Frontend handler properly serializes non-Error objects with cyclic-safe fallback (was logging `{}`)

---

## [0.7.13] - 2026-02-03

### Bug Fixes

- **Nuke Tantivy index on restart** (FLO-186, PR #116): Delete `search_index/` directory on server startup before creating fresh index — eliminates ghost IDs and stale entries that persisted across restarts
- **Backup failure log level**: Escalated Y.Doc IndexedDB backup failure from `console.warn` to `console.error` — backup is the crash recovery path, failures shouldn't be quiet

---

## [0.7.12] - 2026-02-03

### Features

- **MCP bridge plugin** (PR #115): Added `tauri-plugin-mcp-bridge` for dev-mode automation — WebSocket on port 9223 enables screenshot capture, DOM inspection, console log reading, and keyboard/mouse automation from Claude Code

### Bug Fixes

- **Backspace merge newline** (PR #115): Blocks now merge with `\n` separator when pressing backspace at start, turning siblings into multi-line blocks instead of concatenating content

---

## [0.7.11] - 2026-02-03

### Bug Fixes

- **WebSocket reconnect sync race** (FLO-256, PR #114): Added `reconnect-authority` origin that bypasses `hasLocalChanges()` guard, allowing authoritative server state to sync during reconnect
- **HMR store preservation**: Preserved `blockStore` instance across hot module replacement via `import.meta.hot.data` to prevent empty state after dev mode file edits
- **Reconnect echo prevention**: Wrapped reconnect Y.Doc apply with `isApplyingRemoteGlobal` guard to prevent update observer from echoing state back to server
- **Stale debounce on authority sync**: Cancel pending content debounce and clear dirty flags when authoritative update arrives, preventing stale local content from overwriting server state
- **Image paste path quoting**: Temp file paths with spaces now quoted before sending to PTY
- **HTTP client init race**: Moved `initPromise = null` from catch to finally block, preventing stuck rejected promise on transient init failures

### Improvements

- **Clipboard paste visibility**: Image and text paste failures now display inline warnings in terminal instead of silent console errors
- **Workspace load error banner**: Yellow warning banner when workspace fails to load instead of silent failure
- **Friendly PUT error message** (FLO-255): Returns 405 with "Did you mean PATCH?" when agents try PUT on `/api/v1/blocks/:id`

---

## [0.7.10] - 2026-02-02

### Features

- **Automated rolling backup daemon** (FLO-251, PR #113)
  - Hourly backups to `~/.floatty/backups/` (configurable)
  - Tiered retention: 24h hourly, 7d daily, 4w weekly
  - `backup::status` - Daemon health and timing
  - `backup::list` - Show recent backups with sizes
  - `backup::trigger` - Force immediate backup
  - `backup::config` - View retention settings
  - `backup::restore <file> --confirm` - Restore from backup

- **Export endpoints for agents/cron** (FLO-249)
  - `GET /api/v1/export/binary` - Download raw .ydoc
  - `GET /api/v1/export/json` - Download human-readable JSON

### Improvements

- Use `chrono` crate for UTC timestamps (replaces 50+ lines of manual date calc)
- Async file writes in backup daemon (`tokio::fs::write`)
- Proper error propagation in config serialization

---

## [0.7.9] - 2026-02-02

### Features

- **Binary restore endpoint** (`/api/v1/restore`) for disaster recovery (FLO-247, PR #111)
  - Destructive replacement of Y.Doc state from binary backup
  - Clears search index and rehydrates hooks after restore
  - Broadcasts new state to all connected WebSocket clients

- **Rolling backup insurance** (FLO-247, PR #110)
  - `⌘⇧B` - Binary Y.Doc export (perfect restore with CRDT metadata)
  - `⌘⇧J` - JSON export with validation (human-readable fallback)
  - Export validation catches structural issues before download

- **IndexedDB namespace isolation** (FLO-247): Prevents dev/release data mixing
  - Database names now include build type and workspace: `floatty-backup-{dev|release}-{workspace}`

- **Build profile data isolation**: Dev and release can't cross-contaminate
  - Different bundle identifiers for dev builds
  - Distinct default ports: dev (33333) vs release (8765)

### Bug Fixes

- **16MB body limit** for large .ydoc restores (was 2MB axum default)
- **Timestamped export filenames** to avoid `(1)` `(2)` collisions
- **Unified port config** - server reads `server_port` from top level
- **Export script** (FLO-247): Fixed `export-outline.mjs` to use `childIds` for sibling order

---

## [0.7.8] - 2026-02-01

### Features

- **API reparenting** (FLO-224, PR #108): Blocks can now be moved between parents via PATCH `/api/v1/blocks/:id`
  - `parentId: null` moves block to root
  - `parentId: "<id>"` moves block under specified parent
  - Children automatically travel with reparented block
  - Cycle detection prevents parenting under self or descendants
  - Emits `BlockChange::Moved` event for hook integration

### Bug Fixes

- **Server auth**: Skip auth for localhost connections (dev ergonomics)

---

## [0.7.7] - 2026-01-30

### Features

- **Markdown table rendering** (FLO-58, PR #107): Full interactive table support in the outliner
  - Parses markdown table syntax (`| A | B |`) into structured table view
  - Cell editing with Tab/Shift+Tab navigation between cells
  - Column resizing via drag handles (zero-sum model, Shift+drag for proportional)
  - Text wrapping in all cells
  - Toggle between table view and raw markdown (≡ button)
  - Inline formatting preserved in cells (bold, italic, wikilinks)
  - Column widths persist in block metadata

---

## [0.7.6] - 2026-01-29

### Bug Fixes

- **Terminal scroll**: Replaced broken `onScroll` detection with wheel events (FLO-220)
  - xterm's `onScroll` only fires on content changes, not user scroll ([xterm #3201](https://github.com/xtermjs/xterm.js/issues/3201))
  - Wheel events reliably detect user scroll intent
  - Added visual indicator (⇡) in tab bar when detached from output
  - Fixed memory leak: wheel listener now cleaned up on dispose

---

## [0.7.5] - 2026-01-29

### Bug Fixes

- **Terminal scroll**: Fixed race condition where programmatic `scrollToBottom()` calls would yank user back after scrolling up (FLO-220)
  - Removed auto-reattach on reaching bottom - only explicit `Cmd+End` or `Cmd+Down` reattaches now
  - Added `Cmd+Down` (`Ctrl+Down` on Linux/Windows) as alternative for compact keyboards without End key

---

## [0.7.4] - 2026-01-29

### Bug Fixes

- **Terminal scroll**: Fixed user scroll detection during output (FLO-220)
  - v0.7.3's `pendingWrites` guard blocked ALL scroll events during output
  - Now uses direction detection: scroll UP (viewportY decreases) = detach, at bottom = reattach
  - Removes stale state capture - callback checks current `stickyBottom` value

---

## [0.7.3] - 2026-01-29

### Fixed

- **Terminal scroll behavior** (FLO-220, PR #106): Fixed two scroll issues that became more frequent with recent Claude Code updates:
  - Random scroll jumps to top during heavy output
  - Mouse scroll not quite reaching bottom (requiring arrow key)

  New sticky-bottom mode tracks user scroll intent - scrolling up detaches from output, scrolling to bottom reattaches. Added `Cmd+End` / `Ctrl+End` shortcut to explicitly scroll to bottom and reattach.

---

## [0.7.2] - 2026-01-28

### Features

- **Split Ollama model configuration** - Configure separate models for ctx:: sidebar parsing (`ctx_model`) and `/send` conversations (`send_model`) in config.toml. Inline override with `/send:model-name` syntax. (FLO-216, #105)

### Documentation

- Added `/send` command guide (`docs/guides/SEND.md`)
- Added `send` topic to help handler

### Maintenance

- Fixed unused import lint warning in workspace.rs

---

## [0.7.1] - 2026-01-27

### Bug Fixes

- **Outliner**: Back navigation (`⌘[`) now restores focus to the exact block you navigated from, not just the zoom level (FLO-211, PR #104)
  - Added `originBlockId` capture to `zoomTo()` API
  - `expandAncestors()` ensures restored block is visible even if parent was collapsed
  - Fixed memory leak in `historyNavigationPending` Set cleanup

---

## [0.7.0] - 2026-01-27

### New Features

- **Navigation history** (`⌘[`/`⌘]`) - Browser-style back/forward navigation in the outliner (FLO-180, PR #103)
  - Each pane maintains its own navigation history (up to 50 entries)
  - History skips deleted blocks automatically
  - History persists across sessions
  - Split panes start with empty history (like browser tab duplication)

---

## [0.6.2] - 2026-01-27

### Bug Fixes

- **Nested zoom navigation**: Fixed keyboard navigation after zooming into a child block. Changed `blockId: props.id` to `getBlockId: () => props.id` to ensure event handlers read fresh props when SolidJS updates the same component instance. (PR #102)

### Documentation

- Added SolidJS stale closure pattern to rules documentation (`solidjs-patterns.md`, `do-not.md`) to prevent similar bugs.

---

## [0.6.1] - 2026-01-27

### Bug Fixes

- **Outliner**: Scroll viewport to keep focused block visible during keyboard navigation (ArrowUp/ArrowDown)

---

## [0.6.0] - 2026-01-27

### New Features

- **Scoped expand keybinds** (PR #101) - `⌘E` now expands focused subtree only instead of entire outline
  - Fixes jank with large outlines (2,774+ root blocks)
  - `⌘⇧E` provides global expand (all roots, capped at depth 3)
  - `⌘⇧0` adds "homebase reset" to collapse all to `initial_collapse_depth`
  - Config is now cached at startup for keybind access

- **Block timestamps in API** (PR #100) - `createdAt`/`updatedAt` exposed in floatty-server `/api/v1/blocks` response
  - Enables age-based queries and sorting

### Documentation

- Added "Permeable Boundaries" section to PHILOSOPHY.md (architectural principle for context boundaries)

---

## [0.5.1] - 2026-01-26

### Bug Fixes

- **Outliner**: Fixed backspace at blank lines incorrectly triggering block merge - now correctly uses absolute offset (`getOffset() === 0`) instead of DOM position (`isAtStart()`) for merge decisions
- **Outliner**: Fixed ArrowUp/Down navigation when cursor is surrounded by only newlines (browser can't navigate, now handled manually)
- **Outliner**: Fixed IndexSizeError crashes by adding rangeCount guards and offset clamping in cursor utilities
- **Outliner**: Blocks with expanded children can now merge (children lifted to siblings); collapsed children still protected

### Performance

- **Terminal**: Batched clipboard IPC calls (3 → 1) reducing paste latency

### Internal

- Wired `useBlockInput` hook as single source of truth for keyboard handling (~400 lines removed from BlockItem.tsx)
- Added `liftChildrenToSiblings()` to block store for merge operations
- Updated contenteditable-patterns.md with §7-10 documenting cursor edge cases

---

## [0.5.0] - 2026-01-24

### Fixed

- **Content sync race condition** - Added `hasLocalChanges` dirty flag to prevent remote updates from overwriting pending debounced edits (FLO-197 P0)
- **Focus race on pane click** - `OutlinerPane.focus()` now respects `focusedBlockId` instead of always focusing first block (FLO-197 P1)
- **Sync health false positives** - Replaced broken hash comparison with block count (Y.Doc encoding includes client IDs, so hashes never match) (FLO-197 P4)
- **Startup freeze with large outlines** - Gate render on config loaded to apply collapse BEFORE mounting 10K+ BlockItem components (FLO-197 P5)
- **Version sync** - `tauri.conf.json` was stuck at 0.2.3, now properly synced

### Added

- **Configurable collapse depth on split** - New config `split_collapse_depth` to force-collapse blocks deeper than N when splitting panes (FLO-197 P3)
- **Initial collapse depth** - New config `initial_collapse_depth` for controlling expansion on app startup
- **Scroll-to-focus on split** - New pane centers the focused block instead of starting at scroll top 0
- **Y.Doc garbage collection** - Enabled `gc: true` to prevent tombstone accumulation

### Documentation

- Added AGENTS.md for multi-agent floatty development patterns
- Added floatty-server query reference to CLAUDE.md
- Updated `/floatty:release` command to sync all THREE version files (package.json, Cargo.toml, tauri.conf.json)

---

## [0.4.4] - 2026-01-23

### Bug Fixes

- **IndexedDB backup migration** (PR #97) - Fixed Y.Doc backup storage
  - Migrated from localStorage (5MB limit) to IndexedDB (50MB+)
  - Prevents silent data loss when Y.Doc exceeds localStorage quota
  - Automatic migration: existing localStorage backups move to IndexedDB on first access
  - Added error logging for database initialization failures
  - Added objectStore guard for future version upgrades

### Documentation

- Updated CLAUDE.md logging section (debug logs in dev scripts)
- Clarified hasLocalBackup() docstring (only checks localStorage, not IndexedDB)

---

## [0.4.3] - 2026-01-18

### New Features

- **FLOATTY_DATA_DIR** (PR #95) - Multi-workspace data isolation
  - All paths derive from single `FLOATTY_DATA_DIR` env var (default: `~/.floatty`)
  - Dev builds default to `~/.floatty-dev` for automatic isolation
  - Config-driven `workspace_name` shows in title bar
  - Config-driven `server_port` for per-workspace server isolation
  - New `paths.rs` module centralizes path resolution

- **/floatty:float-loop** - Generic work track command for Claude Code skills
  - Session-type-aware Stop hook
  - PostToolUse lint + Stop validation hooks

### Infrastructure

- Enhanced title bar: `floatty (dev) - workspace v0.4.3 (abc1234)`
- Git commit embedding via `vergen-gix` at build time
- `serial_test` crate for env mutation test isolation

### Documentation

- Updated CLAUDE.md with DataPaths architecture, FLOATTY_DATA_DIR usage
- Updated README.md with Multi-Workspace Support section

---

## [0.4.2] - 2026-01-15

### New Features

- **filter:: handler** (PR #94, FLO-170) - Dynamic query blocks that filter outline by markers
  - Query syntax: `filter:: project::floatty status::active`
  - Filter functions: `include(marker)`, `exclude(marker)`, `children()`
  - Live results panel with match highlighting, click to navigate
  - Respects zoom scope - searches within focused subtree

- **help:: handler** (PR #94) - Documentation viewer in outliner
  - Usage: `help:: filter`, `help:: keyboard`, `help:: handlers`
  - Hierarchical markdown parsing preserves heading structure
  - Results insert at top for quick iteration

### Bug Fixes

- **Path traversal vulnerability** (PR #94) - Fixed `read_help_file` to use `starts_with()` instead of `contains()` for proper path validation
- **Verbose logging** (PR #94) - Changed metadata extraction `info!` logs to `debug!` to reduce noise

### Documentation

- Added FILTER.md comprehensive guide (247 lines) covering query syntax, functions, and use cases
- Updated CLAUDE.md keyboard table with command block terminology
- Added inline parsing lesson to do-not.md rules (hasInlineFormatting gatekeeper)

### Tests

- 475 tests (up from 420 in 0.4.1)
  - 55 new filterParser tests (parsing, escaping, complex queries)
  - 4 new inlineParser tests (hasInlineFormatting gatekeeper coverage)

---

## [0.4.1] - 2026-01-14

### New Features

- **/send handler** (PR #88) - Execute blocks with LLM using conversation context
  - Walks zoomed subtree to build multi-turn conversation (## user / ## assistant markers)
  - Respects zoom scope - sends only the focused context, not full document
  - Hook architecture with `execute:before` / `execute:after` lifecycle

- **Executor system** - Unified block execution with typed actions
  - Actions: `execute`, `stream`, `abort` for different execution modes
  - Origin tracking: `Origin.Executor` for executor-generated changes
  - Hook support for validation, logging, transformation

- **Event system** - Two-lane architecture for Y.Doc changes
  - `EventBus` (sync) - Immediate UI updates, validation
  - `ProjectionScheduler` (async) - Batched index writes with 2s flush interval
  - `EventFilters` - Composable predicates for handler targeting

- **Hook registry** - Priority-ordered hooks with error isolation
  - Type-safe registration by event type (block lifecycle, execution)
  - `HookContext` with abort capability, shared data passing
  - HMR-safe with `import.meta.hot.dispose()` cleanup

### Bug Fixes

- **Multi-line cursor offset** (PR #88) - Extended contentEditable patterns rule with `<div>` boundary edge cases
- **HMR timer cleanup** - Added dispose handlers to ProjectionScheduler singleton

### Documentation

- Updated solidjs-patterns.md with store proxy clone pattern
- Updated ydoc-patterns.md with event timing guidelines
- Added contenteditable-patterns.md edge case documentation

### Tests

- 420 tests (up from 318 in 0.4.0)
  - 19 sendContextHook tests (zoom scoping, multi-turn, implicit first turn)
  - 13 executor tests (lifecycle hooks, abort handling)
  - 18 eventBus tests (subscription, filtering, error isolation)
  - 19 projectionScheduler tests (batching, flush, HMR)
  - 26 hookRegistry tests (priority ordering, context passing)

---

## [0.4.0] - 2026-01-13

### New Features

- **search:: handler** - Inline search results view with score-ranked hits, clickable navigation to blocks
- **pick:: handler** - Interactive fzf-style fuzzy picker for block selection (uses $tv pattern)
- **Multi-turn conversations** (FLO-200) - Role inference (user/assistant/system prefixes), context directives, conversation tree walking for ai:: blocks
- **JS console logging** - `console.log/warn/error` bridged to Rust tracing via `[target]` prefix parsing

### Bug Fixes

- **ContentEditable cursor offset** (PR #84) - Fixed multi-line offset calculation to count `<div>` boundaries as newlines, preventing block split corruption
- **UTF-8 truncation** - Search results use char-safe truncation (200 chars) instead of byte slicing
- **CSS variables** - Added `--color-bg-secondary`, `--color-bg-hover`, `--color-fg-dimmed` for search UI theming
- **Picker resize** - Added ResizeObserver for dynamic terminal sizing in picker overlay

### Documentation

- Added FLO-200 multi-turn conversation architecture spec
- Added contentEditable patterns rule (cursor offset edge cases)

---

## [0.3.2] - 2026-01-13

### Bug Fixes

- **HMR cleanup**: Added `import.meta.hot.dispose()` handlers across 5 modules to prevent state accumulation during development hot reload (useSyncedYDoc, useSyncHealth, handlers, httpClient, terminalManager)
- **Sync hygiene**: Fixed race condition in httpClient initialization; wrapped terminalManager dispose in try/finally; fixed TypedArray boundary issue in useSyncHealth hash computation
- **Handler registration**: Added guard against duplicate handler registration; added `.catch()` on async handler executions
- **UI**: Removed font-size transition on ctx:: tags

### New Features

- **Dev workflow commands**: Added `/floatty:plan`, `/floatty:pr-check`, `/floatty:sweep` slash commands encoding six-pattern bug taxonomy for systematic development hygiene

## [0.3.1] - 2026-01-12

### Bug Fixes

- **WebSocket reconnect race condition** (FLO-152, PR #82) - Fixed race where incoming WS messages during reconnect could be processed before full state sync completed, causing stale overwrites. Added message buffering during reconnect and connection ID guards against stale async handlers.

## [0.3.0] - 2026-01-11

### Search Infrastructure (Work Units 0.x - 3.6)

Complete Tantivy-backed search system with hook-based metadata extraction.

#### Architecture
- **Hook system** (Work Units 1.5.x) - Origin-filtered hook registry for block change events
- **Change emitter** (Work Units 1.x) - Y.Doc observer wrapper with debouncing and deduplication
- **Writer actor** (Work Unit 3.2) - Async Tokio actor for non-blocking Tantivy index writes
- **Search service** (Work Unit 3.4) - HTTP endpoint with block ID + score results

#### Search Features
- **Marker extraction** (Work Unit 3.6) - Extracts `ctx::`, `project::`, `mode::`, `issue::` from block content
- **Wikilink indexing** - `[[Page Name]]` and `[[Page|Alias]]` extracted to `outlinks` field
- **Full-text search** - Tantivy query syntax on content and extracted markers
- **API endpoints** - `/api/v1/search?q=...` returns ranked block IDs

#### Metadata Schema
```rust
BlockMetadata {
    markers: Vec<Marker>,      // ctx::, project::, mode::, issue::
    outlinks: Vec<String>,     // [[wikilink]] targets
    has_markers: bool,         // fast filter
}
```

### Backend Modularization (PR #76)

- **Services pattern** - Business logic extracted from Tauri commands to `src-tauri/src/services/`
- **Thin command adapters** - Tauri commands delegate to services for testability
- **Handler registry** - Consolidated block type executors (`sh::`, `ai::`, `daily::`)

### Frontend Handler Registry (PR #77)

- **Unified handler API** - `executeHandler(type, block, context)` pattern
- **Removed legacy handlers** - Consolidated `ai.ts` and `sh.ts` into registry

### Structured Logging (PR #75)

- **tracing migration** - Replaced tauri-plugin-log with tracing + tracing-subscriber
- **JSON log format** - `~/.floatty/logs/floatty-YYYY-MM-DD.jsonl`
- **Queryable with jq** - Structured fields for duration, targets, errors

### Bug Fixes

- **Text selection bleeding** (FLO-145, PR #74) - Selection no longer crosses block boundaries
- **Cursor/text sync** (PR #73) - Focus-based ctx tag styling fixed
- **CSS containment revert** (PR #71) - Removed rules causing text to vanish
- **10 code review issues** (PR #72) - Address findings from 6-agent parallel review

### Documentation

- **Architecture snapshot** (PR #78) - 15k line comprehensive pattern analysis
- **Search work units** - Detailed specs for all 20+ implementation units
- **Handoff documents** - Per-unit completion notes with test evidence

### Developer Experience

- **search-test.sh** - Helper script for testing search API
- **318 tests** - Up from 283 in 0.2.x

### Linear Tickets Closed
FLO-145, FLO-146

---

## [0.2.3] - 2026-01-06

### Ephemeral Panes / Quick Peek (FLO-136, PR #64)

Preview panes that auto-replace until you engage with content.

#### Click Behaviors
- **Opt+Click** on [[wikilink]] → ephemeral horizontal split (replaces previous)
- **Shift+Opt+Click** → ephemeral vertical split
- **Cmd+Click** → permanent horizontal split (unchanged)
- **Cmd+Shift+Click** → permanent vertical split (unchanged)

#### Pin Triggers (ephemeral → permanent)
- Typing in the pane
- 5-second timeout

#### Visual
- Dashed border indicates ephemeral state
- Stronger accent when active

### Performance

- **CSS containment** - `content-visibility: auto` on block children, `contain: layout style paint` on blocks
- Large documents significantly faster (poor man's virtualization)

### Developer Experience

- **Window title** shows `(dev)` or `(release)` build mode
- No more guessing which floatty instance you're testing

### Documentation

- **FLO-137 spec** - Pinned panes design document for future implementation

### Linear Tickets Closed
FLO-135, FLO-136

---

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
