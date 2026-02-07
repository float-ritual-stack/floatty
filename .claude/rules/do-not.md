# Do NOT

Critical anti-patterns that will break floatty.

## General (Meta)

- Claim architecture/system "doesn't exist" without grepping first (e.g., "no hook system exists" when `HookSystem` is in 13 files)
- Mark PR review comments as "out of scope" without verifying the infrastructure isn't already there
- Trust compacted conversation summary over actual codebase state
- Assume behavior is a regression without checking `git show HEAD:file` (the original may already work that way — e.g., output blocks already hid contentEditable before any changes)

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

## Y.Doc/Search (see @.claude/rules/ydoc-patterns.md)

- Recreate wikilink/marker parsing in Rust (reuse `inlineParser.ts` or port with TS as spec)
- Store metadata only in Tantivy (must be in `block.metadata` for CRDT sync)
- Create separate EventBus class (wrap Y.Doc `observeDeep()` instead)
- Use sync hooks for Tantivy indexing (blocks user input - use async with queue)
- Return search results directly from Tantivy (hydrate from Y.Doc for full data)
- Add debouncing without understanding the layer it belongs to
- Mutate Y.Array childIds via delete-all-then-push (creates divergent CRDT ops that duplicate on merge — use surgical helpers: `insertChildId`, `removeChildId`, etc. See ydoc-patterns.md #10)
- Call `setSyncStatus('synced')` without guarding with `!isDriftStatus()` (clobbers drift indicator — health check may still show green when counts diverge)

## Inline Parsing

- Add new token types to `inlineParser.ts` without updating `hasInlineFormatting()` in the same file (BlockDisplay early-exits if this gatekeeper returns false → tokens never render)
- Assume tests passing = feature working (take a screenshot, the parser might not even be called)

## Rust Backend

- Put business logic in Tauri commands (use `src-tauri/src/services/` for business logic)
- Skip the services pattern for new features (thin command adapters, pure service logic)
- Add block operations to API without emitting corresponding `BlockChange::*` event (hooks depend on complete event coverage - FLO-224 missed `Moved` event on reparent, caught by Greptile)
