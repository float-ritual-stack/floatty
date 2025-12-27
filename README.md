# floatty

A high-performance terminal emulator built with Tauri v2 + xterm.js, featuring a "consciousness siphon" that captures structured context markers in real-time.

## What It Does

- **Multi-tab terminals** with full PTY support per tab
- **GPU-accelerated rendering** via WebGL addon
- **ctx:: Siphon** - Parses terminal output for `ctx::` markers and displays them in a sidebar ToC
- **Platform-aware keybinds** - Cmd on macOS, Ctrl on Windows/Linux
- **High-throughput optimized** - Handles Claude Code's 4000+ redraws/sec without stuttering

## Architecture Highlights

### The "Greedy Slurp" Pattern
```
PTY Output → Reader Thread → mpsc channel → Batcher Thread → base64 → IPC Channel → xterm
```

- **Reader Thread**: Blocks on PTY read, pushes to channel
- **Batcher Thread**: Blocks on first byte (0 CPU idle), then "slurps" all queued data (up to 64KB)
- **Result**: 4000 IPC calls/sec → 60-144Hz steady updates

### Performance Optimizations

| Optimization | Problem | Solution | Impact |
|--------------|---------|----------|--------|
| Greedy Slurp | 4000+ events/sec kills UI | Batch in Rust before IPC | 60Hz smooth |
| Base64 | Vec<u8> → slow JSON array | Base64 string | 60% faster |
| Tauri Channels | window.emit broadcasts | Direct IPC pipe | No overhead |

## Quick Start

```bash
# Install dependencies
npm install

# Run development
npm run tauri dev

# Build for production
npm run tauri build
```

## Keyboard Shortcuts

Uses platform-aware keybinds: **Cmd** on macOS, **Ctrl** on Windows/Linux.

### Tab Management
| Shortcut | Action |
|----------|--------|
| `Cmd+T` | New tab |
| `Cmd+W` | Close tab |
| `Cmd+1-9` | Go to tab N |
| `Cmd+Shift+[` | Previous tab |
| `Cmd+Shift+]` | Next tab |

### UI
| Shortcut | Action |
|----------|--------|
| `Cmd+B` | Toggle context sidebar |

### Terminal Reserved (always pass through)
These keys are never intercepted - they reach the PTY for shell signals:
- `Ctrl+C` (SIGINT), `Ctrl+Z` (SIGTSTP), `Ctrl+D` (EOF)
- `Ctrl+L`, `Ctrl+R`, `Ctrl+A`, `Ctrl+E`, `Ctrl+K`, `Ctrl+U`, `Ctrl+W`

## ctx:: Marker Format

The terminal captures markers in this format:
```
- ctx::2025-12-16 @ 08:30 AM [project::myproject] [mode::coding] Your message here
```

Parsed into:
- **timestamp**: 2025-12-16
- **time**: 08:30 AM
- **project**: myproject
- **mode**: coding
- **message**: Your message here

## OSC 7337 Protocol

Send structured context via escape sequence (invisible in terminal):
```bash
printf '\e]7337;{"type":"ctx","line":"ctx::2025-12-16 @ 08:30 AM [project::x] message"}\a'
```

## Tech Stack

- **Frontend**: SolidJS, TypeScript, Vite
- **Terminal**: xterm.js + WebGL + Unicode11 + Ligatures addons
- **Outliner**: Block tree with yjs CRDT, inline markdown formatting
- **Backend**: Tauri v2, Rust
- **PTY**: Vendored tauri-plugin-pty with custom batching
- **Theming**: 5 bundled themes, hot-swap via ⌘;

## Known Issues

- xterm decoration API unstable (removed for now)
- Auto-fire to evna not wired yet (manual capture works)

## Credits

- Architecture patterns pair-coded with Gemini
- Based on [tauri-plugin-pty](https://github.com/aspect-build/tauri-plugin-pty)

## License

MIT
