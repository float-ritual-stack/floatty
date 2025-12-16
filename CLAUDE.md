# CLAUDE.md - floatty

Instructions for Claude Code when working on this codebase.

## What This Is

A high-performance Tauri v2 terminal emulator with a "consciousness siphon" - it captures `ctx::` context markers from terminal output and displays them in a sidebar.

## Architecture

### The Performance Pattern (DO NOT DEVIATE)

The terminal handles 4000+ redraws/sec from tools like Claude Code. This requires:

1. **Greedy Slurp Batching** (Rust side)
   - Reader thread blocks on PTY read
   - Pushes chunks to mpsc channel
   - Batcher thread blocks on first chunk (0 CPU idle)
   - Then `try_recv()` slurps ALL queued data (up to 64KB)
   - Emits ONE batched payload via IPC Channel

2. **Base64 Encoding**
   - `Vec<u8>` serializes to slow JSON array `[255, 0, 12...]`
   - Base64 string is 60% faster to parse in JS

3. **Tauri Channels**
   - `Channel<String>` is a direct IPC pipe
   - Passed from frontend to `spawn` command
   - No broadcast overhead like `window.emit()`

### Key Files

```
src-tauri/plugins/tauri-plugin-pty/src/lib.rs  # Vendored PTY plugin with batching
src/components/Terminal.tsx                     # xterm.js + ctx:: detection + sidebar
src/index.css                                   # Sidebar styling
```

### The ctx:: Siphon

Terminal output is scanned for:
```
ctx::YYYY-MM-DD @ HH:MM AM/PM [project::X] [mode::Y] message
```

Parsed markers appear in sidebar. Dedupe prevents duplicates from rapid redraws.

### OSC 7337

Custom escape sequence for structured metadata:
```
\x1b]7337;{"type":"ctx","line":"..."}\x07
```

Invisible in terminal, intercepted by parser.

## Commands

```bash
npm install          # Install deps
npm run tauri dev    # Dev server
npm run tauri build  # Production build
```

## Known Issues (For Future Claude)

1. **Sidebar resize** - `Ctrl+Shift+C` toggles sidebar but terminal doesn't refit properly. The `useEffect` with `fitAddon.fit()` fires but xterm doesn't resize. Needs investigation.

2. **xterm decorations** - Tried `term.registerDecoration()` for highlighting ctx:: lines. Crashed with renderer errors. Removed. Could try debounced approach (wait for scroll stop, then decorate viewport).

3. **evna auto-capture** - The `// TODO: Fire to evna automatically` is stubbed. When ready, uncomment and add proper evna plugin invoke.

## Do NOT

- Remove the batching pattern (will break performance)
- Use `window.emit()` instead of Channels (slow)
- Send `Vec<u8>` without base64 encoding (slow JSON)
- Add synchronous work in the batcher thread

## The Pattern Library

This codebase demonstrates patterns reusable for other Float Substrate experiments:
- High-throughput IPC
- PTY integration
- Metadata siphoning
- Sidebar ToC UI
