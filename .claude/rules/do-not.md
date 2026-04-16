# Do NOT

Critical anti-patterns that will break floatty.

## General (Meta)

- Claim architecture/system "doesn't exist" without grepping first (e.g., "no hook system exists" when `HookSystem` is in 13 files)
- Mark PR review comments as "out of scope" without verifying the infrastructure isn't already there
- Trust compacted conversation summary over actual codebase state
- Assume behavior is a regression without checking `git show HEAD:file` (the original may already work that way — e.g., output blocks already hid contentEditable before any changes)
- Add Tauri permissions without: (1) verifying plugin is installed in `Cargo.toml`, (2) checking plugin docs for permission format (many need scope objects, not strings), (3) checking generated schema for available permissions. `Permission X not found` means plugin isn't installed OR permission name is wrong.

## Iframe Sandbox

- Remove `allow-same-origin` from iframe sandbox attributes. In Tauri, iframe content (external URLs, localhost services) is ALWAYS cross-origin from the parent (`tauri://localhost`). Without `allow-same-origin`, the iframe's origin is forced to `null`, which breaks CORS for its own subresources, `canvas.toDataURL()`, cookies, and localStorage. The textbook "`allow-scripts` + `allow-same-origin` = sandbox escape" only applies when iframe content is same-origin with the parent — which never happens in Tauri. Bot reviewers will flag this; they're wrong. See comments in `EvalOutput.tsx`.

## Tracing / OTLP (floatty-server)

> **See also**: @.claude/rules/logging-discipline.md — policy for secrets/sinks/failure-modes/comments. This section lists specific traps; that file is the rule-set.

- **Don't enable `reqwest-client` on `opentelemetry-otlp` without `default-features = false`.** The 0.31.1 source has mutually-exclusive `cfg(all(not(reqwest-blocking-client), not(hyper-client), feature = "reqwest-client"))` gates for HTTP client selection. Default features include `reqwest-blocking-client` — if you enable `reqwest-client` on top, BOTH are on, neither cfg branch fires, and `LogExporter::build()` returns `NoHttpClient` at runtime. The error surfaces as `OTLP log exporter build failed: no http client specified` in the server startup log. Fix: `opentelemetry-otlp = { version = "0.31", default-features = false, features = [...] }`.

- **Don't use `reqwest-client` (async) with `SdkLoggerProvider::with_batch_exporter()`.** The BatchLogProcessor spawns a dedicated OS thread, NOT a tokio task. Inside that thread, `reqwest::Client` (async) panics with `there is no reactor running, must be called from the context of a Tokio 1.x runtime`. Use `reqwest-blocking-client` instead — matches the upstream `basic-otlp-http` example. The "blocking inside tokio" concern is misplaced: the blocking call happens on the dedicated processor thread, not on a tokio worker.

- **Don't call `.with_endpoint(url)` unconditionally when setting up the OTLP exporter.** Programmatic configuration overrides env vars per `opentelemetry_otlp::exporter::http::resolve_http_endpoint`. If the user has `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` set in their shell, your hardcoded endpoint will silently override it. Resolve endpoints in this order in application code: signal-specific env var → general env var → config file → None.

- **Don't add a new `tracing::info!(target: "floatty_startup", ...)` or any other target-override log line without updating the `EnvFilter` default in `floatty-server/src/main.rs`.** `EnvFilter` matches on the target string, not the crate path — `floatty_core=info` does NOT match `target: "floatty_startup"`, so the line silently defaults to OFF. The filter default must carry every overridden target explicitly. See @.claude/rules/config-and-logging.md for the current filter.

- **Don't forget the telemetry-induced-telemetry loop filter.** The OTLP exporter's HTTP client (hyper/reqwest) emits its own tracing events. Without `hyper=warn,reqwest=warn,opentelemetry=off` in the EnvFilter, every log export triggers more log events, triggering more exports. The existing filter has these entries — don't remove them when adding new targets.

- **Don't promote high-cardinality tracing structured fields (e.g., `elapsed_ms`, `block_id`, `request_id`) to Loki labels without intent.** Loki's default OTLP mapping promotes every field to a label. For startup-rate events this is fine. For hot paths (per-request, per-block, per-keystroke) this explodes cardinality and Loki will complain. Mitigation is Loki-side (`limits_config.otlp_config.log_attributes` allowlist), not floatty-side — but the person adding `#[tracing::instrument]` to a hot path needs to know the risk exists.

## PTY/Rust

- Remove batching pattern (breaks performance)
- Use `window.emit()` instead of Channels
- Send `Vec<u8>` without base64 encoding
- Add sync work in batcher thread
- Change Ollama JSON schema without updating both `ctx_parser.rs` and `ContextSidebar.tsx`

## SolidJS

- Use `<For>` for terminal iteration (use `<Key>` instead - see @.claude/rules/solidjs-patterns.md)
- Destructure props in components (breaks reactivity)
- Put store proxies directly in new data structures (clone instead)
- Clear refs in `onCleanup` for components that might re-render
- Use `<Show>` for heavy components that should survive visibility changes
- Pass prop values to hooks that create event handlers (use getters instead - `getBlockId: () => props.id` not `blockId: props.id` - SolidJS updates props on same instance, closures go stale)
- Use bare `createEffect` when calling functions that read other stores (use `on()` to explicitly declare dependencies - function internals create implicit deps, effect runs on unrelated changes)

## Keyboard/Selection

- Use `cursor.isAtStart()` for block-level decisions like merge (use `cursor.getOffset() === 0` instead - `isAtStart()` can be true at start of ANY line in multi-line content!)
- Use `'set'` mode when you want to select a block (use `'anchor'` - 'set' only clears)
- Forget `containerRef?.focus()` after blurring contentEditable (tinykeys needs focus)
- Use `next` in Shift+Arrow range extension (use `props.id`, then move focus)
- Block merge just because block has children (only block when children are COLLAPSED/hidden - see @.claude/rules/contenteditable-patterns.md)
- Give embedded views (search results, daily views) their own `tabIndex` or `onKeyDown` (creates dual-focus event bubbling — `preventDefault()` does NOT stop propagation, both handlers fire. Keep focus on parent wrapper, pass visual state via props — see @.claude/rules/output-block-patterns.md)

## contentEditable (see @.claude/rules/contenteditable-patterns.md)

- Use `Range.toString().length` for cursor offset (doesn't count `<div>` boundaries as newlines)
- Use `innerText.length` for offset calculation (normalizes whitespace differently)
- Assume `\n` characters exist in DOM (browser uses `<div>` and `<br>` elements instead)
- Have mismatched logic between `setCursorAtOffset()` and `getAbsoluteCursorOffset()` (causes split corruption)
- Call `selection.getRangeAt(0)` without checking `selection.rangeCount` first (throws IndexSizeError after undo)
- Set cursor offset without clamping to node length (DOM may have changed, throws IndexSizeError)
- Assume ArrowUp/Down works when only newlines exist before/after cursor (browser can't navigate - handle manually)

## Structural Mutations (Block Tree)

- Remove a block from its parent before validating the insertion destination exists (orphan risk — always resolve the destination index BEFORE `removeChildId`. See `_outdentBlockSimple`, `outdentBlock` adopt path)
- Write a merge/combine operation without checking `isDescendant(sourceId, targetId)` (deleting source orphans target if target is in source's subtree — see `mergeBlocks`, `moveBlock`)
- Add a new block tree mutation without the pre-flight pattern: (1) validate all lookups, (2) bail if any return -1/null/undefined, (3) THEN mutate. The `mergeBlocks` `liftOk` flag is the reference implementation.

## HMR Cleanup

- Add module-level mutable state (`let foo = ...`, `const bar = new Map()`) or EventBus subscriptions without `import.meta.hot.dispose()` cleanup (leaks on hot reload — see `outlinksHook.ts`, `ctxRouterHook.ts` for the pattern, `funcRegistry.ts` and `doorLoader.ts` for what happens when you forget)
- Create Blob URLs (`URL.createObjectURL()`) without revoking them in HMR dispose (browser has limited Blob URL slots)

## Y.Doc/Search (see @.claude/rules/ydoc-patterns.md)

- Recreate wikilink/marker parsing in Rust (reuse `inlineParser.ts` or port with TS as spec)
- Store metadata only in Tantivy (must be in `block.metadata` for CRDT sync)
- Create separate EventBus class (wrap Y.Doc `observeDeep()` instead)
- Use sync hooks for Tantivy indexing (blocks user input - use async with queue)
- Return search results directly from Tantivy (hydrate from Y.Doc for full data)
- Add debouncing without understanding the layer it belongs to
- Mutate Y.Array childIds via delete-all-then-push (creates divergent CRDT ops that duplicate on merge — use surgical helpers: `insertChildId`, `removeChildId`, etc. See ydoc-patterns.md #10)
- Call `setSyncStatus('synced')` without guarding with `!isDriftStatus()` (clobbers drift indicator — health check may still show green when counts diverge)

## Pane Drag-Drop / Resize (see @.claude/rules/pane-drag-drop-patterns.md)

- Assume `ResizeObserver` catches position-only changes (it doesn't — only fires on size changes. After pane rearrangement, split containers can move without resizing. Watch layout tree root reference for structural changes.)
- Append outer drop zones after per-pane zones (prepend — `zones.find()` uses first match, outer must win at edge)
- Use real pane IDs for synthetic drop targets (use `__outer_` prefix convention — handler routes by prefix)
- Recompute drop zones continuously during drag (computed once at drag start — acceptable tradeoff, layout root doesn't move mid-drag)

## Inline Parsing

- Add new token types to `inlineParser.ts` without updating `hasInlineFormatting()` in the same file (BlockDisplay early-exits if this gatekeeper returns false → tokens never render)
- Assume tests passing = feature working (take a screenshot, the parser might not even be called)

## Rust Backend

- Put business logic in Tauri commands (use `src-tauri/src/services/` for business logic)
- Skip the services pattern for new features (thin command adapters, pure service logic)
- Add block operations to API without emitting corresponding `BlockChange::*` event (hooks depend on complete event coverage - FLO-224 missed `Moved` event on reparent, caught by Greptile)

## Test Fixtures (see @.claude/rules/test-fixtures-no-pii.md)

- Commit a fixture captured directly from a running floatty server, real user outline, conversation export, or session log without sanitizing first (FLO-633: `spec-7f5ef11c.json` shipped with real names, grief note, bank status, `/Users/evan/` paths — CodeRabbit flagged as 🟠 Major, required git history rewrite + force-push)
- Include real UUIDs that could be session / block / user IDs (use `00000000-0000-4000-8000-0000000000NN` synthetic placeholders)
- Leave terminal control sequences (`\u001b]1337;CurrentDir=/Users/...`) in fixtures — they often carry the CWD of the capture machine
- Use real names from colleagues, family, or clients in test assertions (use `Demo Alice`, `Demo Bob` — even if "it's just a test")
- Assume "it's my private repo" means PII is safe — branches get shared, forks get created, PRs get indexed by GitHub search before anyone reads the bot comments

## Paths/Config (Build Profile Isolation)

- Construct paths with hardcoded `.floatty` or `.floatty-dev` outside `paths.rs` (use `DataPaths::default_root()` or pass paths through from `DataPaths::resolve()`)
- Add new `data_dir()` / `default_*_path()` functions without `#[cfg(debug_assertions)]` gate (FLO-317: env-var fallback missed compile-time isolation switch)
- Call deprecated `AggregatorConfig::load()` / `save()` in new code (use `load_from(&paths.config)` / `save_to(&paths.config)`)
- Assume `config.save()` only writes the field you changed (it serializes the ENTIRE in-memory struct — every field gets written, including ports)
- Add file writes before the preflight assertion in `lib.rs` or `main.rs` (preflight must run before ANY `create_dir_all`, DB open, or server spawn)
