# Do NOT

Critical anti-patterns that will break floatty.

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

## Keyboard/Selection

- Use `cursor.isAtStart()` for block-level decisions like merge (use `cursor.getOffset() === 0` instead - `isAtStart()` can be true at start of ANY line in multi-line content!)
- Use `'set'` mode when you want to select a block (use `'anchor'` - 'set' only clears)
- Forget `containerRef?.focus()` after blurring contentEditable (tinykeys needs focus)
- Use `next` in Shift+Arrow range extension (use `props.id`, then move focus)
- Block merge just because block has children (only block when children are COLLAPSED/hidden - see @.claude/rules/contenteditable-patterns.md)

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

## Inline Parsing

- Add new token types to `inlineParser.ts` without updating `hasInlineFormatting()` in the same file (BlockDisplay early-exits if this gatekeeper returns false → tokens never render)
- Assume tests passing = feature working (take a screenshot, the parser might not even be called)

## Rust Backend

- Put business logic in Tauri commands (use `src-tauri/src/services/` for business logic)
- Skip the services pattern for new features (thin command adapters, pure service logic)
