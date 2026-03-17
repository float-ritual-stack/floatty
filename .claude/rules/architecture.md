# Architecture Reference

## Three-Layer Stack

SolidJS (local Y.Doc) → Tauri IPC → Rust (floatty-server subprocess) → Axum (Y.Doc authority, SQLite).

Sync: User types → Y.Doc update (50ms debounce) → POST /api/v1/update → Yrs apply → WS broadcast.
Persistence: SQLite append-only + hourly .ydoc snapshots. Compacts every 100 updates.

## PTY Performance (DO NOT DEVIATE)

Reader thread → Batcher thread (greedy slurp ≤64KB) → IPC Channel (base64 string).

- Greedy slurp: block on first chunk, `try_recv()` drains queue
- Base64 encoding (60% faster than JSON array)
- Tauri Channels (NOT `window.emit()`)
- No sync work in batcher thread

## Terminal Manager

Singleton owning xterm lifecycle OUTSIDE SolidJS. Framework reactivity caused terminals to re-init on tab switch. `terminalManager.ts` eliminates this.

## Inline Formatting Overlay

Two-layer technique: display layer (styled tokens, pointer-events: none) on top of edit layer (contentEditable, transparent text, visible caret). Both in `.block-content-wrapper`. Colors via CSS variables (`--color-ansi-*`).

## Wikilinks & Pages

`pages::` block at root contains all linkable pages (stored with `# ` prefix). Clicking `[[link]]` creates page if missing, zooms to it. `LinkedReferences` shows backlinks when zoomed. Parser uses bracket-counting (not regex) for nested `[[outer [[inner]]]]`.

## Pane Linking (⌘L)

`Pane A ──link──▶ Pane B`: wikilink clicks in A navigate in B. Chain: A→B, B→C cascades.
Two overlay modes: Link (⌘L, cyan) picks target outliner. Focus (⌘J, yellow) jumps to any pane.
Unfocused panes dim to `unfocused_pane_opacity`. Linked partner gets cyan border.

## Artifact & Chirp

`artifact::` renders JSX via Babel in sandboxed iframe. `chirp::` is postMessage bridge (iframe↔outline). `chirp('navigate', {target})` routes through pane link.

## ctx:: Aggregation

JSONL files → CtxWatcher (file watcher) → SQLite (pending) → CtxParser (Ollama) → Sidebar (polls 2s).

## Sequence Number Architecture (PR #119)

Server broadcasts seq numbers. Client detects gaps, fetches `GET /api/v1/updates?after=N&before=M`. Heartbeat every 30s reveals gaps. IndexedDB persists `lastKnownSeq` across reloads. Restore resets all client seq baselines.

## Key File Inventory

### Rust (`src-tauri/src/`)
| File | Purpose |
|------|---------|
| `lib.rs` | App setup, Tauri commands, config |
| `paths.rs` | Centralized `DataPaths` — all paths from `FLOATTY_DATA_DIR` |
| `config.rs` | AggregatorConfig |
| `ctx_watcher.rs` | JSONL watcher, ctx:: extraction |
| `ctx_parser.rs` | Ollama parsing worker |
| `db.rs` | SQLite schema, marker CRUD |
| `server.rs` | Spawns floatty-server subprocess |

### SolidJS Components (`src/components/`)
| File | Purpose |
|------|---------|
| `Terminal.tsx` | Tab orchestration, keybinds, layout |
| `Outliner.tsx` | Block tree with zoom |
| `BlockItem.tsx` | Individual block (keybinds, rendering) |
| `BlockDisplay.tsx` | Inline formatting overlay + wikilink clicks |
| `Breadcrumb.tsx` | Navigation trail |
| `LinkedReferences.tsx` | Backlinks display |
| `PaneLinkOverlay.tsx` | ⌘L/⌘J letter overlay |
| `PaneLayout.tsx` | Recursive split layout |

### Frontend Modules (`src/lib/`)
| File | Purpose |
|------|---------|
| `terminalManager.ts` | xterm lifecycle singleton |
| `keybinds.ts` | Platform-aware keybind system |
| `layoutTypes.ts` | Layout tree types + pure transforms |
| `blockTypes.ts` | Block type detection (`sh::`, `ai::`, etc.) |
| `inlineParser.ts` | Inline markdown tokenizer + wikilinks |
| `navigation.ts` | Unified navigation (navigateToBlock, navigateToPage) |
| `handlers/artifact.ts` | JSX transpilation for artifact:: |
| `handlers/doorLoader.ts` | Door discovery + hot-reload |
| `handlers/doorTypes.ts` | Door type definitions (`selfRender` flag) |
| `events/blockEventBus.ts` | Block lifecycle event bus |
| `markdownParser.ts` | Markdown → block hierarchy (headings, lists, fences) |
| `cursorUtils.ts` | Cursor position utilities for keybind logic |
| `executor.ts` | `sh::` command execution via Tauri |
| `tvResolver.ts` | `$tv()` pattern → TV picker → selection |

**Block Lifecycle Hooks** (`src/lib/handlers/hooks/`):

| File | Purpose |
|------|---------|
| `ctxRouterHook.ts` | Extracts ctx:: markers → `block.metadata.markers` |
| `outlinksHook.ts` | Extracts [[wikilink]] targets → `block.metadata.outlinks` |

Hooks subscribe to `blockEventBus` with origin filtering. See `docs/architecture/FLOATTY_HOOK_SYSTEM.md`.

### Hooks (`src/hooks/`)
| File | Purpose |
|------|---------|
| `useBlockStore.ts` | Y.Doc-backed block CRUD |
| `usePaneStore.ts` | Per-pane state (zoom, focus, history). Use `zoomTo()` for navigation |
| `useLayoutStore.ts` | Per-tab split layouts |
| `useTabStore.ts` | Tab state |
| `useSyncedYDoc.ts` | CRDT sync, WebSocket, sequence tracking |
| `useBlockInput.ts` | Keyboard coordinator (`determineKeyAction()`) |
| `useBacklinkNavigation.ts` | Page finding, backlinks. Navigation goes through `lib/navigation.ts` |
| `usePaneLinkStore.ts` | Pane→pane linking, `resolveLink()` |
| `useCommandBar.ts` | ⌘K command palette |
