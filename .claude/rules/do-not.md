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

- Use `cursor.getOffset() === 0` for start detection (use `cursor.isAtStart()` instead)
- Use `'set'` mode when you want to select a block (use `'anchor'` - 'set' only clears)
- Forget `containerRef?.focus()` after blurring contentEditable (tinykeys needs focus)
- Use `next` in Shift+Arrow range extension (use `props.id`, then move focus)

## contentEditable (see @.claude/rules/contenteditable-patterns.md)

- Use `Range.toString().length` for cursor offset (doesn't count `<div>` boundaries as newlines)
- Use `innerText.length` for offset calculation (normalizes whitespace differently)
- Assume `\n` characters exist in DOM (browser uses `<div>` and `<br>` elements instead)
- Have mismatched logic between `setCursorAtOffset()` and `getAbsoluteCursorOffset()` (causes split corruption)

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
