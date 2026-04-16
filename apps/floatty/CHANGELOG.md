# Changelog

All notable changes to floatty are documented here.

## [Unreleased]

---

## [0.11.8] - 2026-04-16

### ✨ Features

- **Colocated Apps**: `ink-chat` and `outline-explorer` are now part of the main monorepo for streamlined development and unified release cycles ([[PR #237]])
  - **Outline Explorer**: Advanced outliner with AI-powered analysis, custom catalog renderers, and full MCP server support
  - **Ink Chat**: Block-to-UI compiler with JSON-render catalog integration and structured form generation

### 🔧 Improvements

- **Server-side Markdown Projection**: Door blocks now compute `renderedMarkdown` server-side with fallback chain ([[FLO-633]]): `GET /api/v1/blocks/:id` injects markdown for door blocks whose frontend-hook `renderedMarkdown` is null or empty. New `floatty_core::projections` module walks `output.data.spec` with in-memory LRU caching (block_id, hash(output)). No Y.Doc writes, no WebSocket broadcasts — response-only projection.
- **API Event Coverage**: All block operations now emit corresponding `BlockChange` events for complete hook coverage

### 🛡️ Security

- Added sanitization rules for PII and credentials in colocated applications per test-fixtures-no-pii.md

---

## [0.11.7] - 2026-04-15

### Features

- **Reader view typography** ([[FLO-625]], #235): three new CSS variables (`--content-max-width: 720px`, `--body-line-height: 1.6`, `--text-primary: warm`) constrain body prose to a 720px reading column with roomier line-height and warmer off-white text color (~8:1 contrast, up from ~4:1). Constraint lives on direct block-level children of `.outliner-container` so zoomed door/iframe pane views escape naturally and use the full pane for sidebar+content and dashboard layouts. `.block-content-text`, `.block-content-bullet`, and `.block-content-ctx` pick up `--text-primary`; semantic block-type colors (`sh::`/`ai::`/headings/errors/quotes) remain on the ANSI palette so syntax hierarchy is preserved.

### Performance

- **Commit block content on blur, not every 150ms** ([[FLO-387]], #234): replaced the 150ms-debounced Y.Doc write path with boundary-triggered commits. Keystrokes stay in the DOM between boundaries; Y.Doc only sees user-meaningful commits at blur, structural operations, and unmount. Previously ~7 Y.Doc transactions per second during typing fired `observeDeep`, EventBus hooks, SolidJS reactivity, and OTLP spans — each blocking the writer lock. New model: ~1 transaction per edit session. Dirty-transition `contentAtFocus` snapshot catches remote-while-focused conflicts at commit time; diagnostic logged + `__floattyTestHooks.onConflictDetected` fired for observability (conflict-resolution UI tracked in [[FLO-623]]).
- **Cache cursor boundary snapshot per selection** ([[FLO-387]], #233): WeakMap + monotonic generation counter in `useCursor.ts` caches the four boundary values (offset, atStart, atEnd, contentLength) per element until the selection actually changes. `determineKeyAction` previously made 3 consecutive DOM walks per keystroke — now one walk per selection change, cache hits thereafter. Document-level `selectionchange`/`input`/`compositionupdate` listeners bump the generation; programmatic `innerText` mutations require explicit `cursor.invalidate()`.

### Theming System Cleanup

- **Three orphan CSS variables wired through theme system** ([[FLO-625]], #235): `--color-bg-secondary`, `--color-bg-hover`, `--color-fg-dimmed` were set in `:root` but never applied by `applyThemeToCSS()`. All 5 themes silently used the default-theme values. Added to `FloattyTheme` interface, populated per-theme, pushed through `applyThemeToCSS`.
- **Door variable fallback references fixed** (#235): `doors.css` referenced `--color-fg-primary` and `--color-bg-tertiary`, neither of which existed. Door output silently fell back to hardcoded OneDark-ish hex values regardless of active theme. Now uses `--text-primary`, `--color-fg`, and `--color-bg-hover`.
- **terminalManager theme cache** (#235): `new XTerm({ theme: toXtermTheme(defaultTheme) })` was hardcoded at both terminal-creation sites, so tabs/panes opened after a theme switch booted in the default theme. Added `currentXtermTheme` cache on the singleton; `updateAllThemes()` writes to it, new terminals read from it.
- **Hardcoded Gruvbox colors swapped for theme variables** (#235): `App.tsx` server-error fallback, `BlockOutputView.tsx` door error card, `Outliner.tsx` zoom crash button, and `SidebarDoorContainer.tsx` sidebar door error all contained hardcoded `#fb4934` / `#1d2021` / `#3c3836` / `#ebdbb2` values bypassing the theme system. All swapped for `var(--color-error)` / `var(--color-bg-secondary)` / `var(--color-fg)` / `var(--color-border)`.

### Render Door

- **Prose self-constraint** ([[FLO-625]], #235): `.bbs-entry-body` direct prose children (`p`, `ul`, `ol`, `blockquote`, `h1/h2/h3`) self-constrain to `max-width: var(--content-max-width)` so bare `EntryBody` / `PatternCard` content reads well at any pane width. Tables, `pre` blocks, and `hr` stay at container width so data/code can sprawl — matches the prose-vs-dashboard contract from FLO-625. Agent contract unchanged; same JSON spec now renders readably whether inline or zoomed.

### Internal

- **Rule files: pattern-fit-check, block-type-patterns, rule-audit, verify-citations** (#232): derived from a six-run AI tool evaluation on a `poll::` block design task (2026-04-13). `pattern-fit-check` adds the missing "does this pattern's invariants match my problem's invariants" step between finding a reference and copying it. `rule-audit` is a grep-based walker that verifies rule-file citations against the actual codebase. `verify-citations` runs the same checks on draft prompts/memos before they ship. `floatty-improve-prompt` refreshed with a Step 3 grep-verification requirement plus a chain-to-`verify-citations` rule for compound prompts.

### Documentation

- **`ydoc-patterns.md` rule 5 & 6 rewritten** ([[FLO-387]], #234): rule 5 ("Debounce at the Right Layer") replaced with "Commit at Boundaries, Not Ticks" — documents the new blur-is-the-boundary input-layer model and why keystroke-level debouncing was wrong. Rule 6 ("Blur/Remote-Update Race Condition") rewritten to reflect the dirty-transition snapshot instead of focus-time snapshot, with the full commit-time conflict-detection flow and the rationale for why the autocomplete/structured-paste paths needed the dirty-transition shape.
- **`door-development.md` monorepo paths** ([[FLO-625]], #235): deploy-path section updated with monorepo-aware paths. The compile script moved to `apps/floatty/scripts/` in the monorepo shift; the old rule still listed repo-root paths. Now has both "from `apps/floatty/`" and "from repo root with full paths" examples. Added a second burn entry for the 2026-04-15 monorepo script path case.

### Related

- [[FLO-628]] filed: backend `set_theme` accepts any string without validating against the theme registry — low priority config normalization.
- [[FLO-629]] filed: reader view heading line-height tightening (deferred from FLO-625 scope).
- [[FLO-630]] filed: theming audit — systematic grep for remaining orphan CSS variable references and hardcoded hex.

---

## [0.11.6] - 2026-04-13

### Features

- **Image component in `render::` door** ([[FLO-586]], #230): the render door now supports an `Image` component for displaying images inline in blocks. Filenames without slashes are treated as floatty attachments and fetched with auth; full URLs pass through directly. Includes loading state, error display, 5s timeout, and proper blob URL cleanup on `src` change. Specs using the legacy `"component"` field are normalized to `"type"` automatically so both formats work.
- **OTLP trace export to Tempo** (#230): `floatty-server` now exports traces to Tempo via OTLP when `otlp_endpoint` is configured. Trace and log endpoint resolution are now independent — each follows its own env-var priority chain (`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` → `OTEL_EXPORTER_OTLP_ENDPOINT` → config) rather than sharing a single endpoint config.

### Bug Fixes

- **`fetchWithAuth` header merging** (#230): fixed a bug where spreading a `Headers` instance into an object literal produced `{}` (the `Headers` API stores data internally — spreading gives an empty object). `fetchWithAuth` now uses `new Headers(init?.headers)` to normalize incoming headers before setting the auth header, ensuring the auth key always wins regardless of how headers are passed in.
- **Abort vs timeout disambiguation in Image fetch** (#230): the `AbortController` abort fired by the 5s timeout was indistinguishable from the `onCleanup` abort (both are `AbortError`). Added a `timedOut` boolean flag — timeout errors now correctly show "Request timed out" instead of being silently swallowed.

### Documentation

- **Architecture docs cleanup** (#230): added ADRs 001–005 under `docs/adrs/`, wired `docs/architecture/README.md` to the new agentic-runtime docs, fixed broken relative path in `ARCHITECTURE_MAP.md`, added ephemeral search index principle to `SEARCH_ARCHITECTURE_LAYERS.md`.
- **Agentic runtime docs** (#230): new `docs/architecture/agentic-runtime/` tree formalizing outline-native vs external-execution agent boundaries, clerk interface, state model, work log model, provenance, and four ADRs on agent role boundaries.

### Refactoring

- **Lock-poison error deduplication** ([[FLO-586]], #230): extracted `lock_poisoned()` helper in `outline_manager.rs` to replace 4 identical `map_err` closures. No behavior change — pure DRY cleanup.

---

## [0.11.4] - 2026-04-12

### Refactoring

- **Break up api.rs god object** (#225): split the 5,198-line `api.rs` into 7 handler modules + shared infrastructure (`api/mod.rs`). Each module owns one route family: `sync` (Y.Doc state sync), `blocks` (CRUD), `search` (full-text + page search), `export` (binary/JSON export, topology), `backup` (status/list/trigger/restore), `outlines` (outline management + per-outline scoped handlers), `discovery` (markers, stats, daily note, presence, attachments). Router composition via `Router::merge()` with per-module `pub fn router()`. Zero behavior changes — all endpoints return identical responses.

### Observability

- **Handler-level tracing instrumentation** (#225): added `#[tracing::instrument]` to 18 handler functions across all 7 modules. Low-cardinality structured fields: `route_family` (sync|blocks|search|export|backup|discovery|outlines), `handler` (function name), automatic `err` logging. Selective — only write paths, expensive reads, and destructive operations instrumented. Queryable in Grafana/Loki via `{service_name="floatty-server"} | json | route_family != ""`.

### Bug Fixes

- **Async file I/O for backup restore** (#225): replaced blocking `std::fs::read` with `tokio::fs::read` in the backup restore handler to avoid blocking a Tokio worker thread when reading large `.ydoc` backup files.

### Infrastructure

- **Monorepo scaffold** (eb11756..e8055e8): moved floatty into `apps/floatty/`, added `pnpm-workspace.yaml` + `turbo.json`, root-level passthrough scripts, scoped `.claude/rules` paths.

### Related

- [[FLO-605]] filed: restore paths clear search index before validating new state (pre-existing, surfaced by #225 review)
- [[FLO-606]] filed: reindex endpoint doesn't clear stale entries from deleted blocks (pre-existing, surfaced by #225 review)

---

## [0.11.3] - 2026-04-11

### Bug Fixes

- **Zombie floatty-server recovery** (#224): fixes a three-layer failure mode where a wedged `floatty-server` (TCP accept succeeds, HTTP handler never replies) held port 8765 and left the app stuck on "Loading workspace…" requiring manual `kill -9`. `wait_for_server_health` now uses `curl -m 1` so probes can't hang on a dead-responsive zombie. `kill_stale_server` escalates SIGTERM → SIGKILL with `pid_is_alive` re-check after each `send_signal` failure (distinguishes benign race where the process exits between `kill -0` and the actual signal from real delivery failure). `main.rs` bind matches `AddrInUse` explicitly and exits with a diagnostic instead of `.unwrap()` panicking.
- **PID recycling guard** (#224): `kill_stale_server` now calls `verify_pid_is_floatty_server` (`ps -p <pid> -o comm=`) before sending any signal. Between app exits the OS can recycle PIDs; without this guard we could have `kill -9`d an unrelated process that inherited the number.
- **Graceful `axum::serve` error handling** (#224): replaced `.unwrap()` with explicit exit codes (2 for `AddrInUse`, 1 for generic bind errors).

### Internal

- **State-transition table discipline** (#224): `kill_stale_server`'s SIGTERM and SIGKILL paths are now documented inline with the full 2×2 state-transition table (`send_signal` outcome × `pid_is_alive` after). Root-cause response to three rounds of PR review churn that kept finding unrouted cells in forward-pass-only code — the intervention is "write the state table before the code," not "be more careful."
- **Logging consistency sweep** (#224): replaced remaining `log::warn!` / `log::info!` calls in `server.rs` with `tracing::` equivalents (mixed macros violate `logging-discipline.md` rule 6). Replaced silent `.ok()` drops on log dir/file creation and config read/parse with logged warnings. Deleted stale docstring on `spawn_server` claiming `eprintln!` usage (function uses `tracing::` throughout — migration leftover).
- **Sweep Pattern 9** (`.claude/commands/floatty/sweep.md`): added hot-path `#[tracing::instrument]` cardinality tripwire. Promotes the documented warning in `config-and-logging.md` (high-cardinality fields explode Loki label index without `otlp_config.log_attributes` allowlist) to a mechanical sweep check.

### Related

- [[FLO-602]] filed: `feat(reliability): parent-side server watchdog for wedge recovery` — extends the infrastructure in this release so mid-session wedges trigger automatic respawn via `useSyncHealth` instead of requiring app relaunch. Depends on `kill_stale_server` + `verify_pid_is_floatty_server` from this PR.

---

## [0.11.2] - 2026-04-11

### Features

- **Structured JSONL logging for floatty-server** (#223): the server subprocess now writes daily-rotating JSON logs to the same `~/.floatty/logs/floatty.YYYY-MM-DD.jsonl` files as the Tauri process via `tracing-appender`. Both processes appear in one unified log stream distinguishable by `target`. ([[FLO-274]] Tier 1)
- **Optional OTLP log export** (#223): `floatty-server` can ship structured logs to any OTLP HTTP collector (Loki's native receiver, OTel Collector, Alloy, etc.) via the new `[server].otlp_endpoint` config key. Resolution order: `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` env → `OTEL_EXPORTER_OTLP_ENDPOINT` env → config file → off. Resource attributes surfaced as Loki labels: `service.name=floatty-server`, `service.version`, `deployment.environment=dev|release`. Default-off — floatty works normally with file-only logging when unconfigured.
- **Startup phase timing visibility** (#223): added `floatty_startup=info` to the default `EnvFilter` so previously-silent target-override events from `hooks/system.rs` and `store.rs` now land in logs: `phase=ydoc_store_ready`, `search_init_complete`, `cold_start_rehydration_complete`, `hook_system_init_complete`, `phase=server_ready`.

### Bug Fixes

- **Log noise reduction** (#223): demoted `ws::Broadcast N bytes` messages from `info` to `debug` (~214 lines/session). Added `tauri_plugin_pty=warn` to the Tauri-side filter default (~81 lines/session). Combined effect: ~38% drop in Rust-side log volume before remote ingest.
- **`EnvFilter` target matching gotcha** (#223): `tracing::info!(target: "X", ...)` bypasses crate-path filtering and requires an explicit `X=level` filter entry. Fixes three startup-phase events that had been silently dropped.
- **Tauri filter hardening** (#223): pre-emptively added `hyper=warn,reqwest=warn,opentelemetry=off` silencers to the Tauri process filter default so future OTLP wiring on that side doesn't trigger telemetry-induced-telemetry loops.

### Security

- **Credential leak prevention** (#223): removed two INFO-level log lines that were formatting the server API key into tracing events (`"API key: {key}"` and `"Authenticated: curl -H 'Authorization: Bearer {key}'"`). With OTLP export now available, these would have shipped credentials to the remote collector on every startup. API key is now logged as metadata only (`source`, `length`). Curl example moved to `#[cfg(debug_assertions)] eprintln!` so it only prints in dev builds and bypasses the tracing subscriber entirely.
- **OTLP endpoint leak prevention** (#223): the endpoint URL itself is no longer logged — OTLP endpoints can contain basic-auth userinfo, query tokens, or internal hostnames. Startup log is now presence-only: `otlp_log_export_enabled`.

### Documentation

- **New rule file: `.claude/rules/logging-discipline.md`** (#223): six directive-voiced rules codifying secrets-handling, sink routing, failure-mode alignment per subsystem, comment/mechanism drift prevention, `target:` override filter-entry requirements, and canonical filter defaults. Extracted as a root-cause response to three rounds of PR review finding the same class of bug in different shapes.
- **Sweep Pattern 8** (`.claude/commands/floatty/sweep.md`): added Logging Discipline Violations sweep with six greps keyed 1:1 to the rules in `logging-discipline.md` so regressions get caught mechanically on `/floatty:sweep` runs.
- **`do-not.md` cross-reference**: Tracing/OTLP section now points at `logging-discipline.md` as the policy; specific traps still listed there.
- **`docs/architecture/LOGGING_STRATEGY.md`**: added a status note marking which aspirational items from the original doc are now shipped (structured JSONL, OTLP export, startup phase timing) and which remain (trace spans → Tempo, MCP log-query tool, request ID correlation).

### Internal

- Replaced `RollingFileAppender` `.expect()` with `panic!` + explicit "refusing to start without file logging" message. Aligned with log-dir creation failure mode — the local JSONL file is the source of truth; silently running without file logging would hide exactly the startup-hang class of problem this branch was meant to diagnose (see [[FLO-599]]).
- `ServerConfig::load()` switched from `tracing::warn!` to `eprintln!` for early-stage config parse/read errors. `ServerConfig::load()` runs before `setup_logging()` initializes the tracing subscriber — previous calls were silently dropped.
- Aligned server-side `fmt::layer()` field set (`thread_ids`, `thread_names`, `file`, `line_number`) with the Tauri-side setup so `jq` queries against the unified JSONL stream see consistent schemas.
- First real bug caught by the new instrumentation: [[FLO-599]] filed 12 minutes after the filter fix landed — "Hook dispatch lagged by 8262 messages" during cold-start rehydration, diagnosed using the newly-visible `cold_start_rehydration_complete` marker.

---

## [0.11.1] - 2026-04-11

### Features

- **Command bar: cmdk-solid migration**: Replaced hand-rolled keyboard navigation
  (`<ul>/<li>` + `selectedIndex`) with `cmdk-solid` primitives — proper Arrow/Enter
  handling, ARIA attributes, and a foundation for argument-taking commands
- **Command bar: Tab autocomplete**: Tab now fills the query input with the
  highlighted item's label instead of escaping focus (was broken since initial
  implementation)
- **Startup phase timing logs**: Server logs `[startup]` markers with `elapsed_ms`
  at each startup phase (SQLite open, Y.Doc replay, cold-start rehydration, search
  init, server ready) — query with
  `jq 'select(.fields.message | startswith("[startup]"))' ~/.floatty/logs/floatty.*.jsonl`
- **WAL checkpoint on open**: `PRAGMA wal_checkpoint(PASSIVE)` runs automatically
  on every SQLite open, preventing read amplification from large uncheckpointed WAL
  files (40MB+ observed in production)

### Bug Fixes

- **Command bar: Shift+Tab**: Added `!e.shiftKey` guard — Shift+Tab was incorrectly
  triggering Tab autocomplete instead of passing through
- **Page name index cold start**: Pages were showing as stubs on startup due to
  ordering issue in cold-start rehydration — page name events now fire after all
  block data is available
- **Test temp dir leak**: `open_test_store` now returns `TempDir` to caller,
  preventing premature cleanup of test databases

---

## [0.11.0] - 2026-04-10

### Features

- **Multi-outline support**: Switch between named outlines via `outline::` handler,
  native macOS Outlines menu, or command bar — each outline is an independent Y.Doc
  with its own SQLite, search index, and backup namespace
- **outline:: handler**: `outline::` lists available outlines with current marker;
  `outline:: name` switches to that outline (creates if needed, then reloads)
- **Per-outline WebSocket routing**: WS connections carry `?outline=name` so the
  server broadcasts to the correct outline subscribers
- **Active connections + LRU eviction**: Server tracks which outlines have connected
  clients; evicts idle outlines when slot limit is reached
- **Block import endpoint**: `POST /api/v1/blocks/import` for bulk block creation
  with batch Y.Doc transactions
- **outline:: command bar integration**: Type outline name in command bar to switch
- **Command bar ordering** (FLO-466): Matched commands surface above create-page
  option — Enter now selects the command without requiring ArrowDown

### Bug Fixes

- **Error serialization in logger**: `{"err":{}}` in logs is now
  `{"err":{"message":"...","name":"...","stack":"..."}}` — `Error` properties are
  non-enumerable and were silently dropped by `JSON.stringify`
- **outline handler**: Block status no longer stuck `'running'` if outline switch
  is aborted — handler sets `'complete'` after signaling App.tsx
- **appEvents HMR**: Added `import.meta.hot.dispose()` for `pendingOutlineSwitch`
  signal to prevent stale subscribers on hot-reload
- **PTY resize deduplication**: Coalesced resize chatter — dedup gate, drag-end
  settle delay, sourceEvent labels for log tracing
- **Backup scoping**: IDB backup namespace now includes outline name — dev/release
  and different outlines no longer share IndexedDB state

---

## [0.10.10] - 2026-04-07

### Features

- **echoCopy:: handler** (FLO-582): Materializes render door output as plain markdown blocks in the outline — `echoCopy:: [[blockRef]]` resolves short-hash, page name, or UUID refs, reads `renderedMarkdown` metadata, parses to block tree, creates as children
- **outputSummaryHook**: Added `renderedMarkdown` projection — flattens door spec elements to markdown, stored in block metadata
- Backfill output summaries for pre-hook render blocks at startup (no re-render needed)

### Bug Fixes

- **Rust metadata**: Added `rendered_markdown` field to `BlockMetadata` struct — prevents silent field loss during Rust-side metadata round-trips; also added `summary` serialization to `metadata_to_ymap`
- **render door**: Made spec flattener resilient to malformed payloads — cycle guard, `Array.isArray()` checks on props
- **echoCopy**: Falls back to `blockStore.blocks` when `actions.getBlock` is undefined
- **esm.sh imports**: Added `?external=react,react-dom` to non-React packages to prevent duplicate React instances

### Documentation

- Added echoCopy:: guide and help:: topic

---

## [0.10.9] - 2026-04-07

### Bug Fixes

- **render door**: RENDER_TOOL_SCHEMA now derives component enum from catalog (44 components, was hardcoded to 29 — Claude path had 15 fewer components than ollama/agent)
- **render door**: Removed 4 dead catalog actions (selectEntry, filterTag, goBack, scrollTo) that silently no-oped on click
- **render door**: Removed unused DocLayout.sidebarWidth prop (schema advertised control that didn't exist)
- **render door**: Replaced `setTimeout` sizing hacks in BarChart/BarItem with `onMount` lifecycle
- **render door**: Fixed `onfocus`/`onblur` → `onFocus`/`onBlur` casing in TextInput/TextArea (SolidJS event delegation)
- **render door**: Guarded async title generation with execution nonce to prevent stale overwrites on rapid re-execution
- **render door**: Agent JSON extraction now takes the last fenced block instead of first (handles agent explanation text before spec)

---

## [0.10.8] - 2026-04-07

### Features

- Search hits now include `blockType` field (derived from content prefix)
- Topology nodes include `bid` (block UUID) for page blocks

### Bug Fixes

- Fixed `pages::` container detection — config blocks with "pages::" content no longer hijack the container ID, restoring topology block counts (`b` field)
- Used `as_str()` instead of `{:?}` debug format for block type serialization

---

## [0.10.7] - 2026-04-06

### Bug Fixes

- Render door footer now shows full session UUID instead of truncated 8-char prefix, making `--resume` command directly copyable

---

## [0.10.6] - 2026-04-06

### Bug Fixes

- **Terminal text smushing on tab switch** — Hidden tabs no longer get resized to garbage dimensions (11×5) by fitAddon. Visibility restore uses immediate fit with a visibility gate to prevent stale-frame flash

---

## [0.10.5] - 2026-04-06

### Bug Fixes

- **render:: title mode height collapse** (FLO-569) — Block height now matches title, not full prompt. ContentEditable hidden in title mode, replaced with focusable wrapper following table block pattern (#209)
- **render:: raw toggle sync** — Content populates immediately on title→raw toggle via queueMicrotask (same pattern as table blocks)
- **Shift+Enter on executable blocks** (FLO-571) — Creates sibling before when cursor at position 0. Applies to all handler blocks (`sh::`, `render::`, `ai::`, etc.) (#209)
- **Cmd+Enter zoom in title mode** — Zoom into render:: title blocks now works (was unhandled in dedicated keyboard handler)
- **Cmd+Backspace in title mode** — Force-deletes render:: title blocks with children, matching regular block behavior

---

## [0.10.4] - 2026-04-05

### Improvements

- **render:: agent title generation** (FLO-569) — Claude agent now includes a `title` field directly in JSON response, eliminating the Ollama title round-trip. Garbage titles (JSON blobs, >120 chars) are rejected with fallback to spec header (#208)
- **Development Workflow** section added to CLAUDE.md — study existing patterns before fixing UI

### Bug Fixes

- **Terminal columns desync after alt-tab** (FLO-568) — `handleVisibilityRestore` now calls `fitAddon.fit()` + PTY resize notify after WebGL recreation (#207)
- **render:: title mode height** (FLO-569) — block height now matches the displayed content in both directions (title↔raw toggle). Auto-switches to raw on edit (#208)

---

## [0.10.3] - 2026-04-05

### Improvements

- **Centralized config loading** (FLO-559) — replaced 7 independent `get_ctx_config` IPC calls with single `ConfigContext` provider. Three access layers: `useConfig()` (reactive), `getConfig()` (sync), `configReady` (async). Graceful degradation on IPC failure (#205)

### Bug Fixes

- **Double-tap Cmd too aggressive** (FLO-465) — fast Cmd+C → Cmd+V sequences no longer trigger the double-tap wikilink copy. Switched from tinykeys `'Meta Meta'` (1000ms window) to custom bare-tap detection (300ms window, rejects sequences with other keys between) (#206)

---

## [0.10.2] - 2026-04-05

### Features

- **render:: title display** (FLO-548) — render:: blocks show generated title instead of full prompt. Toggle button (⊞/⊟) switches between views. Title comes from render agent output (`data.title`) (#204)
- **GET /api/v1/daily/:date** — resolve daily note page by date string, returns block with children/tree (#190)
- **8 composite render:: components** — StatusPanel, ComparisonGrid, InboxDigest, SprintBoard, KnowledgeCard, ProjectTracker, TimelineView, ContextDashboard (FLO-548) (#203)

### Improvements

- **Bulk blocks endpoint perf** — `GET /api/v1/blocks` skips expensive output blob materialization (`yrs_out_to_json`) via `include_output` flag on `read_block_dto`. Output available on single-block endpoints (#204)
- **BlockDto deduplication** — consolidated 3 copies of inline Y.Doc field extraction into single `read_block_dto` helper (#204)
- **Display mode helpers extracted** — `isOutputBlock`, `hasCollapsibleOutput`, `resolveImgFilename` moved from BlockItem.tsx to `lib/blockItemHelpers.ts` with 26 contract tests encoding mutual-exclusivity invariant (#204)
- **Generated bindings deduplicated** (FLO-561) — 3 directories → 1 (`src/generated/`), ts-gen outputs directly to active copy (#201)
- **Dead code removal** (FLO-556) — removed unused `useBacklinkNavigation()` wrapper (#200)

### Bug Fixes

- **findPagesContainer matching** (FLO-557) — aligned matching logic between page search and container resolution (#202)
- **BarItem scaling** — percentage bars now resolve correctly against container height (#204)
- **outputSummaryHook** — reads envelope shape correctly (`data.spec` not `output.spec`), prefers `data.title` (#204)
- **CSS class rename** — `table-raw-toggle` → `block-mode-toggle` (shared by table and render:: toggles)

### Documentation

- Added Canonical Paths + Protected Architecture sections to CLAUDE.md (FLO-554) (#199)

---

## [0.10.1] - 2026-04-02

### Improvements

- **Structured logging (FLO-555)** — migrated 423 console.* calls across 48 files to `createLogger()` API. All frontend logs now flow through logger.ts with proper level semantics (trace/debug/info/warn/error), structured `js_target` fields in Rust log output, and ESLint `no-console` rule preventing regression (#197)
- **Log hygiene** — removed user-authored content from log payloads (deep-link content, external block content, picker output) — metadata only

### Bug Fixes

- **render:: door** — stripped extra brackets from `connectsTo` values, fixed BarItem scaling (#193)
- **Config grep safety** — anchored `grep '^api_key'` and `grep '^server_port'` across 9 files to prevent matching `anthropic_api_key`

---

## [0.10.0] - 2026-03-27

### Features

- **render:: door system** — json-render/solid pipeline that lets LLMs generate structured UI specs rendered inside outline blocks. 34 component catalog (DocLayout, ArcTimeline, MeetingDiff, DecisionLog, DependencyChain, ContextStream, PatternCard, TuiPanel, TuiStat, BarChart, EntryHeader/Body, NavBrand/Section/Item, WikilinkChip, BacklinksFooter, and more)
- **Spec generation modes** — `render:: demo` (hardcoded), `render:: claude` (structured outputs), `render:: ollama` (local), `render:: agent` (multi-turn Claude Code subprocess with outline context search)
- **Agent session management** — `--continue` / `--resume <id>` for iterative spec refinement across render:: agent calls
- **Deep link write verbs** — `floatty://` handler with navigate, block, execute, upsert verbs for outline mutations from doors and external tools
- **findChildByPrefix + upsertChildByPrefix** — atomic Y.Doc transactions for prefix-based child block lookup and creation (14 tests)
- **chirpWriteHandler** — shared write dispatch for create-child and upsert-child across 3 chirp sites (artifact, inline door, pane door)
- **DoorPaneView** — full-pane zoom into door output via Cmd+Enter
- **outputSummaryHook** — extracts title + headings from door output into `block.metadata.summary` for search discovery
- **BlockMetadata.summary** field added (Rust + TS generated type)
- **LAYOUT_PATTERNS** — agent prompt guidance for when to use sidebar vs vertical stack, DocLayout 2-children rule
- **floatty-dev:// scheme** — dev build scheme isolation so dev and release instances run simultaneously
- **compile-door-bundle.mjs** — esbuild + babel-preset-solid door compilation pipeline

### Improvements

- **BlockItem decomposition** — extracted useContentSync (292 lines), useDoorChirpListener (59 lines), BlockOutputView (387 lines). BlockItem.tsx 1446→891 lines (−38%)
- **ErrorBoundary UX** — shared doorErrorFallback with Clear button across all door rendering sites
- **ArcTimeline memoization** — createMemo for arcEntries, shared entryMatchesArc predicate, pre-computed arc boundaries
- **Single-pass extractRenderSummary** — 3 loops over elements collapsed to 1
- **Agent prompt auto-sync** — replaced static prompt with catalog.prompt() so prompt stays current with component additions

### Bug Fixes

- **Sidebar width persistence** (FLO-507) — moved from config.toml to localStorage, capped max at 40vw, converted Corvu fractions to pixels
- **Server retry on startup** — wraps full IPC+health flow with backoff, prevents dev restart from killing healthy server
- **upsertChild prefix/match mismatch** — LLM used `prefix` param, handler only read `match`. Now accepts both.
- **Raw JSON normalizeSpec bypass** — raw JSON spec path now goes through normalizeSpec like other routes
- **fireHandler content mismatch** — uses existing block content when upsert finds a match, not URL content
- **Server body limit** — bumped 16MB → 64MB for large Y.Doc restores

---

## [0.9.8] - 2026-03-21

### Features

- **Artifact content sniffing** — `artifact::` auto-detects file content type and routes to appropriate renderer: HTML renders directly, JSON gets syntax-highlighted viewer, text/markdown shows in monospace code viewer. ~429 previously-broken artifact files now render
- **Artifact CDN deps** — lucide-react, framer-motion, recharts, zod, rxjs added to import map (lucide-react alone fixes 244 artifacts)
- **Cmd+. on output blocks** — toggle collapse now works on blocks with output (artifact/eval/door), not just blocks with children

### Bug Fixes

- **Expand/collapse 30s hang** — batch() wrapping on all expand/collapse setState loops. 265 children under pages:: triggered 265 individual SolidJS reactivity updates; now batched into one
- **pages:: children default collapsed** — children of the pages:: container now always default to collapsed, showing page titles instead of 265 expanded page trees
- **Indent into large parent** — Tab-indent under pages:: now uses expansion policy to auto-collapse children instead of expanding everything
- **N×M reactivity fix** — isPageChild check uses untrack() for parent content read, preventing 265 memo re-evaluations on every keystroke in parent
- **Artifact language detection** — Python (shebang), Go (package+import), Rust (use/fn/pub), bash scripts detected before JSX check, routed to text viewer instead of Sucrase error
- **Artifact runtime errors** — global error handler in iframe catches CDN import failures and render errors, shows message instead of blank white iframe
- **expandAncestors batched** — consistency with expandToDepth/collapseToDepth
- **JSON.parse size cap** — 64KB cap prevents blocking thread on large non-JSON files starting with `{`

---

## [0.9.7] - 2026-03-19

### Features

- **Unified expansion policy** — five competing expand/collapse systems consolidated into one pure function (`expansionPolicy.ts`) with 20 tests. All triggers (toggle, zoom, navigate, keybind) route through a single policy with smart thresholds (FLO-281, FLO-504, #183)
- **Navigation funnel** — all navigation paths (wikilink click, Cmd+Enter, search/filter/pick results, ⌘K Today, LinkedReferences, deep links) now route through `lib/navigation.ts` with pane link resolution at each call site (FLO-427, FLO-378, FLO-424)
- **Config-driven child render limit** — `child_render_limit` in config.toml (default 0 = no limit). Removes "77 more..." truncation; all children render collapsed
- **Search quality Phase 3** — content preprocessing, field boosting, type exclusion, snippet generation, depth scoring (FLO-368)

### Improvements

- Smart expand on toggle: expanding a block with 10+ children auto-collapses grandchildren
- Zoom auto-expand: large subtrees (500+ nodes) cap at depth 1 to prevent UI freeze
- `expandAncestors` capped at 10 levels to prevent deep-tree navigation hangs (FLO-464)
- `expandToDepth` (Cmd+E) with size cap — bails to depth 1 for 500+ node subtrees (FLO-203)
- Active pane tracks correctly after pane-link navigation (Cmd+J overlay)

### Refactoring

- `findTabIdByPaneId` moved from useBacklinkNavigation to useLayoutStore (layout utility, not backlink concern)
- Dead code removed: `ensureExpandedToDepth`, `useZoomActions.ts`, `scrollToBlockInPane` (-121 lines)
- `resolveSameTabLink` extracted, removing 118 lines of duplication across navigation callers
- HMR dispose fix for module-level `createRoot` in BlockItem config loading

### Documentation

- `docs/architecture/EXPAND_COLLAPSE_NAVIGATION.md` — architecture reference for expand/collapse + navigation routing
- `.claude/rules/architecture.md` updated with expansionPolicy.ts, useTreeCollapse.ts, useLayoutStore.findTabIdByPaneId

---

## [0.9.6] - 2026-03-18

### Features

- Resizable sidebar with @corvu/resizable, ⌘\ toggle, left/right swap (FLO-267, #178)

### Bug Fixes

- Use default import for @corvu/resizable (named export doesn't exist)

### Infrastructure

- Harden sync & tree integrity with parent validation and diagnostics (#180)
  - Parent existence validation in all createBlock operations
  - Y.Doc-authoritative descendant walks in deleteBlock/deleteBlocks
  - Centralized sync diagnostics module (syncDiagnostics.ts)
  - Transaction Authority Rules documented (ydoc-patterns.md §14)

---

## [0.9.5] - 2026-03-17

### Features

- Position-dependent outdent: first child adopts younger siblings, non-first child extracts cleanly (FLO-498, #175)
- Atomic merge: `mergeBlocks()` in single Y.Doc transaction (was 3 transactions, 3 undo entries)
- Flush/cancel discipline across all structural operations (9 actions previously unprotected)

### Bug Fixes

- Pre-flight validation: validate destination before `removeChildId` (prevents orphan on failed lookup)
- `mergeBlocks` guards: self-merge, target-is-descendant-of-source checks
- `liftOk` flag pattern: bail if children can't be safely relocated

### HMR Cleanup

- `funcRegistry`: EventBus subscription leaked on hot reload
- `doorLoader`: Blob URLs from shim creation never revoked
- `syncSequenceTracker`: `resetSharedTracker()` now called in HMR dispose
- `idbBackup`: IDB connection accumulated across reloads

### Documentation

- Compressed CLAUDE.md from 948 to 191 lines (#177)
- Extracted API reference, architecture, and config/logging to focused rules files
- Terrain map committed to `docs/evaluations/`
- Updated `do-not.md` and `ydoc-patterns.md` with new structural mutation rules

### Tests

- 587 new surgical block store tests (outdent, merge, lift, concurrent CRDT scenarios)

## [0.9.4] - 2026-03-15

### Features

- ⌘K command bar surfaces commands above pages when query matches (FLO-466)
- Double-tap ⌘ copies focused block ID as `[[wikilink]]` to clipboard
- ⌘K "Home" command — zoom out to document root
- ⌘K "Today's Daily Note" — navigate to today's date page
- Unfocused outliner panes now scroll with mouse wheel (removed blocking overlay)

### Bug Fixes

- Clear stale command bar pane snapshot when no active tab
- Consolidate BlockItem navigation through `lib/navigation` wrapper (partial FLO-378)

### Reverted

- Todo progress counter (FLO-472) — performance regression, needs parent-level computation
- Double-click checkbox toggle (FLO-473) — event conflict with collapse bullet

## [0.9.3] - 2026-03-15

### Features

- Own vs inherited marker filter — `inherited=false` query param filters to own-only markers (#173, FLO-491)
- `marker_val` param replaces broken `marker_value` — no more `::` URL encoding issues
- Vocabulary discovery endpoints: `GET /markers`, `GET /markers/:type/values`, `GET /stats`
- `BlockIndexData` struct replaces 12-arg writer sprawl

### Bug Fixes

- `q` param now optional in search API — filter-only queries without `q=` no longer return 400

## [0.9.2] - 2026-03-15

### Features

- Search metadata round-trip fix + schema enrichment + API filters (#172)
  - Fixed `has_markers=true` returning 0 results — `extractedAt` stored as f64, serde rejected for `Option<i64>`
  - Lenient timestamp deserializer for legacy Y.Doc data
  - Parser: bare markers (`floatctl::`), ctx:: value capture, `extract_ctx_datetime()` with 12h→24h
  - 5 new Tantivy fields: `outlinks`, `marker_types`, `marker_values`, `created_at`, `ctx_at`
  - 7 new search API filter params: `outlink`, `marker_type`, `marker_value`, `created_after/before`, `ctx_after/before`
  - Filter-only search (empty `q` + filters uses `AllQuery`)
  - Inherited markers included in filter fields via `InheritanceIndex`

### Bug Fixes

- Add `X-Floatty-Confirm-Destructive` header to binary-import script
- `get_block_metadata_json` now handles `Any::Map` and `YMap` variants (was `Any::String` only)
- Pin chrono >= 0.4.31 for `NaiveDateTime::and_utc()`

## [0.9.1] - 2026-03-14

### Bug Fixes

- **Cross-pane drag-and-drop restored** (PR #171, FLO-483): `pane-inactive-overlay` (added for iframe click activation) blocked pointer events on non-active panes, preventing drop target detection. Overlay now becomes pointer-transparent during block drag via `body.block-dragging`.

---

## [0.9.0] - 2026-03-13

### Features

- **Fuzzy page search** (PR #170): `GET /api/v1/pages/search?fuzzy=true` — typo-tolerant page name matching via nucleo-matcher. Existing pages beat stubs at tie scores; deterministic name tie-breaker. Page search now returns `blockId` for existing pages.
- **Presence API** (PR #170): `POST /api/v1/presence` persists last focused block; `GET /api/v1/presence` returns `{ blockId, paneId }` or 204. Validates block still exists before returning.
- **Deep links** (PR #170): `floatty://navigate/<page>?pane=<uuid>` routes to linked outliner pane or active tab fallback.
- **`[[wikilinks]]` clickable in xterm** (PR #170): Custom link provider matches `[[page]]` and `[[hash|alias]]` in terminal output. Click navigates to linked outliner pane.
- **Terminal → outliner pane linking** (PR #170): `Cmd+L` from terminal opens letter overlay. Many→one: multiple terminals can link to same outliner.
- **PTY env injection** (PR #170): `FLOATTY_PANE_ID`, `FLOATTY_URL`, `FLOATTY_API_KEY` injected into every spawned PTY for agent/extension integration.
- **`img::` inline media viewer**: Auth-fetched blob URLs render images, PDFs, and HTML files inline. Full-bleed CSS via `--block-depth`, right-edge resize for images, bottom-edge resize for PDFs. Extension-gated auto-execute prevents 404 mid-type.
- **Expanded `artifact::` read scope**: `~/.rotfield`, `~/Desktop`, `~/Documents` added to Tauri fs capabilities.

### Performance

- **Eliminate O(N) effect cascade** (FLO-452): Untrack `lastUpdateOrigin` from SolidJS store — was triggering full block tree re-render on every keystroke.

### Bug Fixes

- **`resolveTargetPane` fallback**: Returns active tab's outliner when no pane hint provided.
- **Wikilink off-by-one**: `getLine()` 0-based vs `provideLinks(y)` 1-based — underline was on wrong line.
- **`isMac` is boolean not function**: Was throwing TypeError on every keydown.
- **`Cmd+L` dead code**: Handler was after early-return guard; moved before it.
- **`strip_heading_prefix` symmetry**: Core and server now both take first line only, mirroring frontend.
- **Tauri bumped to 2.10** to match `@tauri-apps/api` 2.10.1.

---

## [0.8.5] - 2026-03-12

### Features

- **Short-hash block resolution** (PR #168): All block ID endpoints now accept 6+ hex-char prefix lookups (git-sha style). `GET /api/v1/blocks/resolve/:prefix` returns unique match or conflict list. Client-side `shortHashIndex` singleton in WorkspaceContext provides O(1) prefix lookups without server round-trip.

### Bug Fixes

- **Large container lock-up on zoom-navigate** (PR #169): Block render limit (100 children) now resets when a `BlockItem` is rebound to a new block ID. Prevents stale `childLimit` from over-mounting children when navigating from a large container (e.g. `pages::`) to a new zoom target.
- **dailylog:: date filter misses target file** (PR #169): Removed `head -N` limiter for date-specific and `today` lookups. Previously `dailylog:: 2026-01-15` would silently miss files not in the two most-recent results.
- **dailylog:: project color prefix shadowing** (PR #169): `float-av` entries now correctly get the amber color rather than falling through to the `float` blue. Keys are sorted by descending length before prefix match.
- **stripOSC drops ST-terminated sequences** (PR #169): `@floatty/stdlib` `stripOSC` now handles both BEL (`\x07`) and String Terminator (`\x1b\`) OSC terminators. Shell hooks emitting OSC 133/1337 with ST were corrupting `execJSON` output.
- **Search total count truncated** (PR #168): Search result total now reflects true match count, not the truncated page size.
- **resolve_block_prefix 400 validation** (PR #168): Restored proper validation error responses for short-hash resolution edge cases.

---

## [0.8.4] - 2026-03-11

### Bug Fixes

- **Wikilink block-id zoom overshoots to root** (FLO-432, PR #166): `navigateToBlock` now walks ancestor chain to pick a useful zoom target — stops before root-level blocks like `pages::`. Block-level wikilinks (`[[id|label]]`) land in focused context instead of the entire outline.
- **Full-width toggle broken in multi-pane** (PR #166): `Cmd+Shift+F` now guards against inactive pane, preventing toggle from firing on wrong pane.
- **Per-pane highlight cleanup** (PR #166): Replaced global highlight singleton with `Map<string, () => void>` keyed by paneId. Concurrent multi-pane navigation no longer tears down each other's highlights.
- **Strict pane scoping for highlight retry** (PR #166): Removed global `document.querySelector` fallback from `findBlockInPane`. Per-pane cancellation via Symbol tokens prevents stale retry loops.
- **setCursorAtOffset ReferenceError**: Guarded async cursor positioning against detached DOM nodes and non-contentEditable elements after block merge/navigation.
- **Stale highlight on highlight:false navigation**: Old pane highlights now explicitly cleaned up when navigating with highlight disabled.
- **Event listener leak in highlight dismiss** (PR #166): Fixed split `if/else` listener target so cleanup always removes from the same target that `addEventListener` used.

---

## [0.8.3] - 2026-03-09

### Features

- **Chirp bridge for IframePaneView**: cmd+click navigate works when zoomed into portless block full-pane (previously only EvalOutput's UrlViewer had the postMessage bridge)
- **Stub page dimming**: Wikilinks to pages with no real content (0 children or single empty child) render dim instead of full link color. New `stubPageNameSet` singleton memo in WorkspaceContext
- **Dimmed pane activation overlay**: Clicking inside a dimmed iframe now activates the pane via transparent overlay (iframe clicks don't bubble to parent)

## [0.8.2] - 2026-03-09

### Bug Fixes

- **Image paste lands file icon instead of image** (PR #165): Finder copy-paste produced file type icons because arboard's text clipboard returned filenames that the outliner rendered as text blocks. Now probes Tauri `readFiles()` for actual file paths, with `contentRef` refocus guard for async focus drift.

### Documentation

- **`blockId` vs `id` convention** (FLO-431): Search hits use `blockId` (foreign key, greppable), block CRUD uses `id` (primary key). Documented in `serde-api-patterns.md`.

## [0.8.1] - 2026-03-09

### Features

- **Short-hash block resolution** (PR #164): `GET /api/v1/blocks/resolve/:prefix` resolves 6+ hex-char prefixes to full block UUIDs. Client-side `shortHashIndex` singleton memo in WorkspaceContext for O(1) 8-char lookups
- **selfRender doors** (PR #164): `DoorMeta.selfRender` flag lets doors render inline via `setBlockOutput()`, bypassing adapter child-block envelope
- **Unified chirp navigate** (PR #164): `handleChirpNavigate()` replaces duplicated iframe→outline navigation logic across EvalOutput and DoorHost
- **blockInput sub-hook scaffold** (PR #164): `useBlockInput` split into `blockInput/` sub-hooks (editing, navigation, execution, zoom) for future delegation

### Bug Fixes

- **UUID validation tightened**: Resolve endpoint validates dash positions and hex digits, not just string length
- **Canonical ID on case-insensitive match**: Returns stored key casing, not request casing
- **Door hot-reload kind change**: Stale view unregistered from doorRegistry when door changes from view→block
- **Door selfRender error handling**: try/catch in both initial load and hot-reload paths
- **Dead imports removed**: Unused sub-hook imports cleaned from useBlockInput.ts

### Documentation

- Accessibility baseline rule (ARIA landmarks, focus indicators, motion preferences)
- YJS decoupling audit document (`docs/architecture/AUDIT_2026-03.md`)
- CLAUDE.md updated with resolve endpoint, door types, blockInput sub-hooks, shortHashIndex
- floatty-backend skill updated: stale "use search to resolve" gotcha replaced with resolve endpoint

---

## [0.8.0] - 2026-03-06

### Features

- **Door plugin system** (Units 1.0–12.0, PR #158, #159): Extensible door architecture — `func::` meta-handlers with iframe rendering, `eval::` JS expression engine with outline access, `timestamp::` validation door, `claude-mem` door, full-width block mode, sidebarEligible phases, hot reload via file watcher, config integration for plugin settings, help docs
- **Artifact handler & chirp protocol** (PR #162): `artifact::` renders Claude.ai JSX artifacts in sandboxed iframes via Sucrase transform + esm.sh import maps. Bidirectional chirp bridge — artifacts write blocks to outline (`window.chirp()`), outline pokes artifacts (`window.onPoke`). Supports TSX, anonymous default exports, `</script>` escape
- **Pane linking** (FLO-223, PR #162): tmux-inspired cross-pane navigation — `⌘L` links source pane to target, wikilink clicks and chirp navigates route through linked pane. Chaining supported (A→B→C)
- **Focus overlay** (PR #162): `⌘J` jumps to any pane (terminals + outliners) via letter overlay picker
- **Unfocused pane dimming** (PR #162): Configurable opacity for non-active panes, linked panes get cyan tint at midpoint brightness. Toggle via `⌘K` command
- **Context retrieval API** (FLO-338): `GET /api/v1/blocks/:id` supports `include` query param for ancestors, siblings, children, tree, token estimates. Search endpoints support breadcrumb and metadata includes
- **Copy Block ID** command: `⌘K` → "Copy Block ID" copies git-sha style 8-char block UUID prefix to clipboard

### Bug Fixes

- **Block ID wikilinks** created pages instead of navigating — added hex-prefix guard at 3 navigation sites (wikilink click, chirp navigate, DoorHost navigate). Hex-looking strings never fall through to page creation
- **Stale pane link indicators**: `hasBlockLink()`/`hasPaneLink()` validated pane existence instead of raw map membership
- **Chirp rate limiting**: Per-block 100ms cooldown prevents runaway iframe `setInterval` from creating unbounded child blocks
- **Anonymous default exports** in artifact transform: `export default function() {}` now handled correctly
- **Import map subpath URLs**: Fixed `esm.sh` format from `pkg/sub@ver` to `pkg@ver/sub`
- **`</script>` injection**: Escaped in artifact HTML to prevent document parser breakage
- **ReactDOM import detection**: Checks for default import binding specifically, not just any react-dom import
- **Hardcoded CSS**: Replaced last `rgba()` in pane-link styles with theme-aware `color-mix()`
- **fs read scope**: Narrowed `fs:allow-read-text-file` from `$HOME/**/*` to specific project paths
- **Unicode-correct token estimates** in API response
- **API overflow guards**: Parameter caps on sibling_radius and max_depth

### Documentation

- CLAUDE.md updated with pane linking, artifact handler, chirp protocol sections
- Keybind registry updated with `⌘L`, `⌘J`, `⌘⌥Arrow`

---

## [0.7.42] - 2026-03-01

### Performance

- **Batch Y.Doc transactions for paste/import** (FLO-322, PR #154): Paste and `sh::` output now create all blocks in a single Y.Doc transaction instead of 2N individual transactions. 100 pasted blocks = 1 transaction (was 200). Single `observeDeep` fire, single SolidJS batch, single undo step. Uses `bulk_import` origin to skip synchronous EventBus — metadata (ctx:: markers, [[wikilink]] outlinks) extracted asynchronously via ProjectionScheduler.
- **Singleton pageNames memo** (FLO-322): Lifted identical `pageNames` computation from per-BlockItem (N copies, all identical) to WorkspaceContext singleton. Eliminates N×M recomputation on every keystroke with 500+ blocks.

### Bug Fixes

- **WebSocket reconnect gap** (sweep find): `new WebSocket()` throwing synchronously left connection permanently dead — no reconnect scheduled, no error status set. Added catch with exponential backoff reconnect timer.
- **Homebase keybind fallback**: `⌘⇧0` collapse-to-depth used `?? 0` (disabled) when config missing — changed to `?? 2` for sensible default.
- **ExecutorActions missing batch API**: `batchCreateBlocksAfter` was available on the store but not wired through `ExecutorActions` interface — handlers couldn't batch-create siblings. Wired in both action builders.

### Documentation

- Project rules updated: SolidJS patterns #10 (lift identical memos), Y.Doc patterns #11 (batch transactions), #12 (observer API return type)

---

## [0.7.41] - 2026-02-28

### Features

- **Typed text first in autocomplete** (FLO-400, PR #153): User's typed text always appears as the first suggestion in `[[` wikilink and `⌘K` command bar autocomplete. Selecting it creates a new page (or navigates if exact match exists). Removes the old "Create" item from the bottom of the list. Case-insensitive exact match resolves to canonical page name.

### Bug Fixes

- **Dead else-if branch** (FLO-400): Removed unreachable branch in CommandBar Enter handler that could never fire after typed-text-first reordering.

---

## [0.7.39] - 2026-02-24

### Bug Fixes

- **Echo gap storm** (FLO-391, PR #151): Server-side hooks (MetadataExtraction, InheritanceIndex) consumed seq numbers without broadcasting via WebSocket, causing ~20 gap-fill HTTP requests/sec during typing. Fixed with server broadcast callback on hook mutations + client-side 200ms echo gap debounce. Downstream: resolves FLO-392 selection+delete corruption caused by gap-storm-triggered resyncs.
- **info:: build health endpoint** (sweep find): Fixed wrong URL (`/health` → `/api/v1/health`) — `info:: build` was always showing "(health endpoint unreachable)".

---

## [0.7.38] - 2026-02-24

### Bug Fixes

- **WebGL font corruption on wake** (FLO-390, PR #149): Recreate WebGL addons on `visibilitychange` to prevent garbled terminal glyphs after sleep/display changes. Consolidated 3 inline creation sites into `recreateWebGL()`.
- **Multi-line page title matching** (PR #150): Pages with metadata on subsequent lines (`[board:: recon]`, `[relates:: ...]`) couldn't be found via `[[Title]]`. New `getPageTitle()` extracts first line only before matching. Autocomplete also shows clean titles.

---

## [0.7.37] - 2026-02-24

### Features

- **Fuzzy autocomplete** (FLO-389, PR #148): Typo-tolerant matching for `[[` wikilinks and `⌘K` command bar via fuse.js. `[[sun` finds "fun in the sun". Pinned recent: top 3 most-recently-edited pages shown first, rest alphabetical.

---

## [0.7.36] - 2026-02-18

### Features

- **Command bar ⌘K** (FLO-276, PR #147): Modal command palette for page navigation and built-in commands. Type to filter pages (recency-sorted) and commands (Export JSON/Binary/Markdown). Enter navigates to page or creates new one under `pages::`. Keyboard nav with wrap, click support, ARIA combobox pattern. Theme-aware via CSS variables.

### Bug Fixes

- **Focus after ⌘K navigation**: First child block of the target page receives DOM focus so keyboard works immediately — no mouse click needed.
- **Outliner pane targeting**: When focus is in a terminal pane, ⌘K now finds the first outliner pane in the layout instead of targeting the terminal.
- **Platform-aware command dispatch**: Export commands triggered via command bar use `Ctrl` on Windows/Linux instead of hardcoded `Meta`.

---

## [0.7.33] - 2026-02-18

### Bug Fixes

- **Blank line navigation** (PR #144): ArrowDown/Up now correctly step through blank lines in multi-line blocks instead of getting trapped or skipping. Rewrote boundary detection as offset-based comparison (`getAbsoluteCursorOffset >= getContentLength`) replacing broken structural DOM checks. Fixed edge case where cursor at `(root, childCount)` returned wrong offset for trailing `<br>`.
- **Cmd+A tiered selection** (PR #144): First Cmd+A selects all text within block, second escalates to block selection. Uses `Range.compareBoundaryPoints` for robust detection (old string-length comparison broke on multi-line blocks).
- **Delete focus priority** (PR #144): Deleting a block now focuses the previous sibling instead of jumping to parent. Priority: prev sibling → next sibling → parent.
- **Ghost selection states** (PR #144): Block selection borders now clear when clicking into a contentEditable block. Arrow keys escape block selection mode and restore editing focus.

### Tests

- Added 29 `cursorUtils` tests covering offset calculation, boundary detection, and `setCursorAtOffset` roundtrips against real DOM structures (bare `<br>` model matching floatty's actual contentEditable behavior).

### Documentation

- Promoted "Inspect real DOM before writing cursor code" to section 0 meta-rule in contenteditable-patterns.md.

---

## [0.7.32] - 2026-02-18

### Features

- **`[[` Inline Autocomplete** (FLO-376, PR #143): Type `[[` in any block to trigger autocomplete popup showing pages from `pages::` container. Arrow keys navigate, Enter/Tab selects, Escape dismisses. Filters by case-insensitive substring match. Popup viewport-clamped, dismiss-on-scroll, mouse hover support. ARIA listbox pattern for accessibility.

### Bug Fixes

- **Export keybind dedup** (FLO-367, PR #142): Export keybinds (Cmd+Shift+M/J/B) fired once per Outliner pane instead of once. Deduplicated via tinykeys on the active pane only.

---

## [0.7.31] - 2026-02-16

### Bug Fixes

- **Hook thread starvation** (FLO-361, PR #141): Metadata extraction and inheritance index hooks ran synchronously on the Yrs observe callback thread, blocking all Y.Doc writes during processing. Moved to `spawn_blocking`, batched metadata updates (N write locks → 1), and added incremental `update_affected()` to InheritanceIndex (only recomputes changed blocks + descendants instead of full rebuild).
- **Shell command PATH** (PR #140): `sh::` blocks using `-li` (interactive login shell) hung on machines with starship/p10k prompt init. Switched to `-lc` with explicit `.zshrc` source to get PATH without requiring a TTY.
- **Batch metadata read lock consolidation**: Replaced N individual `get_block_metadata_json()` calls with single read lock using `parse_metadata_from_out()`, which correctly handles all 3 metadata formats (legacy JSON string, Any::Map, native Y.Map).

### Improvements

- **Sweep hardening** (P1-P5): `setApplyingRemote` guarded with try/finally (3 call sites), `deny_unknown_fields` on `PresenceRequest`, `.catch()` on fire-and-forget async (`validateSyncedState`, `loadInitialState`, `autoExecute`).
- **`data_dir()` consolidation** (FLO-317): Four identical implementations collapsed into single `floatty_core::data_dir()`. Prevents sibling drift.

### Testing

- 12 store-backed unit tests for `InheritanceIndex::rebuild()` and `update_affected()` covering root blocks, deleted blocks with descendants, depth >50, and stale inheritance removal (229 Rust tests, 731 JS tests).

---

## [0.7.30] - 2026-02-15

### Bug Fixes

- **GUI edits missing metadata** (FLO-358, PR #139): `MetadataExtractionHook`, `InheritanceIndexHook`, and `PageNameIndexHook` all rejected `Origin::Remote` — meaning ~90% of blocks (created/edited via GUI) had `metadata: null`. Added `Origin::Remote` to all three hooks and updated `triggers_metadata_hooks()`. Server is sole metadata extractor; the "already extracted at source" assumption was wrong.

---

## [0.7.29] - 2026-02-15

### Features

- **Metadata inheritance** (FLO-351, PR #134): Blocks inherit `ctx::`, `project::`, `mode::` markers from ancestors. O(1) `InheritanceIndex` rebuilt on block changes replaces compute-on-get traversal. Inherited markers included in Tantivy search index and API responses.
- **Block repositioning API** (FLO-283, PR #135): `PATCH /api/v1/blocks/:id` now accepts `afterId` (place after sibling) and `atIndex` (place at position) for precise block ordering. Self-referential `afterId` rejected.
- **Ratatui TUI spike** (PR #136): Read-only terminal UI for floatty outliner with presence broadcast for cursor following.

### Bug Fixes

- **Data integrity hardening** (FLO-348/349/350, PR #133): Recursive delete for blocks with children, export validation guards, orphan block detection and re-homing on startup.
- **Config save deprecation** (PR #137): Removed deprecated `load()`/`save()`/`default_config_path()` from `config.rs`, threaded explicit `config_path` through `AppState`. Prevents config clobber from feature branches.
- **Short block ID panic** (4e50c7b): TUI status bar and focus log no longer panic on block IDs shorter than expected.
- **Y.Map metadata parsing** (3d2d7d6): `store.get_block()` now correctly parses metadata stored as Y.Map (not just plain JSON).

---

## [0.7.28] - 2026-02-11

### Bug Fixes

- **Export ACL failure**: Fixed JSON (⌘⇧J) and binary (⌘⇧B) export failing with "Command plugin:fs|write_text_file not allowed by ACL". Root cause: `tauri-plugin-fs` wasn't installed. Added plugin to `Cargo.toml`, registered in `lib.rs`, and configured proper scope permissions in `capabilities/default.json` with `$HOME/**/*` path allowlist for dialog-selected files.

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
