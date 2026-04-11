---
created: 2025-12-16 @ 10:52 AM
type: research
project: float-pty
---

# xterm.js + Tauri 2 Terminal Patterns Research

Research conducted 2025-12-16 via parallel web research agents.

## Executive Summary

Found 6+ open source terminal emulators built with Tauri and xterm.js. Most promising patterns: **tauri-plugin-pty** (official plugin approach), **claude-code-gui** (Tauri 2.0 + React), **Kerminal** (Tauri 2 + Vue 3), and **Liquid Terminal** (Tauri 2 with advanced visual effects). Key architectural pattern: xterm.js frontend + portable-pty backend + Tauri IPC bridge using event-driven bidirectional data flow.

## Repos to Study

### 1. tauri-plugin-pty - Official Plugin Approach
**Repository**: https://github.com/Tnze/tauri-plugin-pty
**Tauri Version**: Tauri 2.0
**Tech Stack**: Rust (portable-pty ^0.9.0), TypeScript bindings
**Frontend**: Framework-agnostic (works with any xterm.js setup)

**PTY Handling**: Clean spawn API with bidirectional event streams
```typescript
const pty = spawn("powershell.exe", [/* args */], {
    cols: term.cols,
    rows: term.rows,
})
pty.onData(data => term.write(data))
term.onData(data => pty.write(data))
```

**IPC Pattern**: Event-driven architecture. PTY outputs emit as Tauri events, terminal inputs write to PTY process.

**Notable**: Full vanilla example at `/examples/vanilla`. Simplest integration path for new projects. Plugin initialization: `.plugin(tauri_plugin_pty::init())`.

**Why Interesting**: Official plugin status, clean API, minimal boilerplate. Best starting point for pattern stealing.

---

### 2. claude-code-gui - Tauri 2.0 + React
**Repository**: https://github.com/5Gears0Chill/claude-code-gui
**Tauri Version**: Tauri 2.0
**Tech Stack**: Next.js 14, React 18, TypeScript, Rust backend
**xterm.js**: With WebLinks, Search, and Fit addons

**PTY Handling**: Uses portable-pty with dedicated process lifecycle management, including cleanup of orphaned processes and signal handling. Each session gets its own PTY process with dedicated I/O streams.

**IPC Pattern**:
1. Frontend invokes Tauri commands via invoke API
2. Backend executes through PTY processes
3. Terminal output streams back as event emissions
4. Type-safe commands from Rust

**Architecture**: Next.js static export pattern for Tauri integration, event-driven terminal streams (not polling), persistent session state.

**Notable**: Production-ready terminal with picture-in-picture mode, drag-and-drop positioning. Real-world implementation showing process management patterns.

**Why Interesting**: Most complete production example. Shows how to handle session management, process cleanup, and persistent state. React + Next.js patterns for Tauri apps.

---

### 3. Kerminal - Tauri 2 + Vue 3 + SSH Manager
**Repository**: https://github.com/klpod221/kerminal
**Tauri Version**: Tauri 2
**Tech Stack**: Vue 3 (Composition API), Pinia stores, TypeScript, Rust + Tokio
**xterm.js**: WebGL-accelerated renderer with Unicode 11 support

**PTY Handling**: Native shell integration (bash, zsh, fish, PowerShell). Async/await with Tokio runtime.

**IPC Pattern**: Tauri v2's command-based IPC. Vue components communicate with Rust backend via typed commands leveraging async message passing.

**Architecture**:
- Security-first: AES-256-GCM + Argon2 encryption
- Multi-database support (SQLite, MySQL, PostgreSQL, MongoDB)
- Session recording in asciicast v2 format
- Pinia for centralized state management

**Notable**: Enterprise-grade features. Multi-device sync. Advanced SSH management. Shows how to build beyond basic terminal.

**Why Interesting**: Vue 3 patterns, security implementation, session recording. Shows production-grade architecture for terminal + SSH features.

---

### 4. Liquid Terminal - Tauri 2 with Visual Effects
**Repository**: https://github.com/terraphim/terraphim-liquid-glass-terminal
**Tauri Version**: Tauri 2
**Tech Stack**: TypeScript, Rust (portable-pty + tokio), CSS3, HTML5
**xterm.js**: Core terminal emulation

**PTY Handling**: Dedicated PTY Manager component in Rust backend. Architecture: PTY Manager → Process Spawner → I/O Handler → Shell Process.

**IPC Pattern**:
- Commands (frontend→backend)
- Events (backend→frontend)
- Central Tauri API layer
- Flow: XTerm.js → Tauri Commands → PTY Manager → Shell Process (output reverses via Events)

**Architecture**: Frameless transparent window with custom decorations. SVG-based displacement mapping + native CSS backdrop-filtering for liquid glass effects.

**Performance**: 70% memory reduction vs. Electron, 80% CPU reduction at idle, 87% smaller bundle (~15MB vs. ~120MB).

**Notable**: Advanced visual effects while maintaining performance. Complete Electron→Tauri migration case study.

**Why Interesting**: Shows Tauri 2's performance gains. Visual effects implementation. Architecture diagram shows clear PTY management patterns.

---

### 5. tauri-terminal - Minimal Reference Implementation
**Repository**: https://github.com/marc2332/tauri-terminal
**Tauri Version**: Not specified (likely Tauri 1.x)
**Tech Stack**: TypeScript (37.5%), Rust, HTML, CSS
**xterm.js**: Standard implementation with portable-pty

**PTY Handling**: Basic portable-pty integration. Referenced by multiple other projects as starting point.

**Architecture**: Simple `/src` (frontend) + `/src-tauri` (backend) structure. Demonstrates basic bridge between xterm.js and PTY management.

**Notable**: Minimal example showing core concepts. Requires JetBrains Mono font. Multiple projects reference this as their foundation.

**Why Interesting**: Clean, minimal example. Good for understanding basics before adding complexity.

---

### 6. Terminaux - Solid.js + Tauri
**Repository**: https://github.com/Sir-Thom/Terminaux
**Tauri Version**: Not specified
**Tech Stack**: Solid.js, TypeScript (53.9%), Rust (36.2%)
**xterm.js**: Likely (based on tauri-terminal)

**PTY Handling**: Based on tauri-terminal project.

**Architecture**: Solid.js frontend with Tauri backend. Shows alternative to React/Vue for Tauri apps.

**Why Interesting**: Solid.js pattern. Demonstrates framework flexibility for Tauri terminals.

---

## Common Architectural Patterns

### PTY Spawning Pattern
All projects use portable-pty on Rust backend:
```rust
// Backend initialization
tauri::Builder::default()
    .plugin(tauri_plugin_pty::init())
    .run(tauri::generate_context!())
```

### Async Handling with Tokio
PTY reads are blocking. Common pattern uses `spawn_blocking` or dedicated reader threads:
- Separate thread for PTY reading
- Tokio async runtime for backend operations
- Event-driven communication to avoid polling

### IPC Data Flow Pattern
Consistent bidirectional flow:
```
User Input → xterm.js → Tauri Command → PTY Process
Shell Output → PTY → Tauri Event → xterm.js → Display
```

### Frontend Integration
All use event-driven xterm.js integration:
```typescript
const term = new Terminal();
term.open(domElement);

// PTY → Terminal
pty.onData(data => term.write(data))

// Terminal → PTY
term.onData(data => pty.write(data))
```

### Process Lifecycle Management
Production apps (claude-code-gui, Kerminal) handle:
- Orphaned process cleanup
- Proper signal handling (SIGTERM, SIGKILL)
- Session persistence across app restarts

---

## Critical Gotchas

### Tokio Runtime in Tauri
- Tauri owns and initializes Tokio runtime by default (no `#[tokio::main]` needed)
- **Use `tauri::async_runtime::spawn()` NOT `tokio::spawn()`** (Tauri v2 panics with raw tokio::spawn)
- Commands use plain `async fn` for async handlers

### PTY Blocking Issue Solution
PTY reads block. Solutions found:
1. **spawn_blocking**: Wrap blocking PTY reads in `tauri::async_runtime::spawn_blocking()`
2. **Dedicated reader thread**: Separate thread handles PTY reads, communicates via channels
3. **tokio::mpsc channels**: Multi-producer single-consumer channels for async data flow

Reference: [Tauri + Async Rust Process](https://rfdonnelly.github.io/posts/tauri-async-rust-process/)

---

## float-pty Current Approach Validation

| Pattern | float-pty | Industry Standard | Status |
|---------|-----------|-------------------|--------|
| PTY reads | Reader thread → mpsc → Batcher | spawn_blocking or thread | ✓ Aligned |
| Batching | 60Hz batcher | Event-driven, not polling | ✓ Good |
| Encoding | Base64 | Common for terminal data | ✓ Standard |
| IPC | Tauri Channels | Channels for high-frequency | ✓ Correct |
| ctx:: parsing | Custom OSC 7337 | Novel (no standard) | ✓ Innovation |

---

## Features to Consider Stealing

### From tauri-plugin-pty
- Cleaner spawn API abstraction
- Built-in resize handling

### From Kerminal
- Session recording (asciicast v2 format)
- WebGL renderer addon for performance
- Pinia-style state management patterns

### From claude-code-gui
- Process lifecycle / orphan cleanup
- Signal handling (SIGTERM, SIGKILL)
- Session persistence

### From Liquid Terminal
- Performance metrics approach
- Architecture documentation style

---

## Additional Resources

### Tauri Shell API (Native)
Tauri provides built-in shell module for basic command execution (not full terminal):
- [Tauri v1 Shell API](https://v1.tauri.app/v1/api/js/shell/)
- [Tauri v2 Shell Plugin](https://v2.tauri.app/plugin/shell/)

### Other Terminal Projects (Not Tauri)
- **Wave Terminal**: Open-source, AI-native, inline rendering
- **Ghostty**: Written in Zig, GPU-accelerated
- **WezTerm**: Rust + GPU-acceleration + Lua scripting
- **Rio Terminal**: Rust + WebGPU + Tokio + Redux state machine

Reference: [Warp Terminal Alternatives](https://tmuxai.dev/warp-terminal-alternatives/)

---

## Sources

- [marc2332/tauri-terminal](https://github.com/marc2332/tauri-terminal)
- [terraphim/terraphim-liquid-glass-terminal](https://github.com/terraphim/terraphim-liquid-glass-terminal)
- [klpod221/kerminal](https://github.com/klpod221/kerminal)
- [5Gears0Chill/claude-code-gui](https://github.com/5Gears0Chill/claude-code-gui)
- [Sir-Thom/Terminaux](https://github.com/Sir-Thom/Terminaux)
- [Tnze/tauri-plugin-pty](https://github.com/Tnze/tauri-plugin-pty)
- [tauri-plugin-pty on crates.io](https://crates.io/crates/tauri-plugin-pty)
- [Tauri + Async Rust Process Pattern](https://rfdonnelly.github.io/posts/tauri-async-rust-process/)
- [Tauri Async Runtime Docs](https://docs.rs/tauri/latest/tauri/async_runtime/index.html)
- [How I Built Kerminal - DEV Community](https://dev.to/klpod221/how-i-built-kerminal-a-free-open-source-terminal-ssh-manager-with-multi-device-sync-1f3i)
