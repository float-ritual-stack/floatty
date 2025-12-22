# Floatty (float-pty) Project Context

## Project Overview

**Floatty** is a high-performance terminal emulator built with **Tauri v2** (Rust) and **SolidJS** (TypeScript). It features a unique "consciousness siphon" system that captures structured context markers (`ctx::`) from terminal output and session logs, parsing them via local LLMs (Ollama) for display in a sidebar.

## Tech Stack

*   **Frontend:** SolidJS, TypeScript, Vite, xterm.js (with WebGL, Unicode11, Ligatures addons).
*   **Backend:** Rust (Tauri v2), SQLite (rusqlite), Tokio.
*   **AI/ML:** Ollama (integration for parsing context markers).
*   **PTY:** Custom vendored `tauri-plugin-pty` with optimized batching.

## Architecture

### 1. High-Performance PTY ("Greedy Slurp")
To handle high throughput (e.g., 4000+ redraws/sec from AI coding tools), the project uses a specific threading model:
*   **Reader Thread:** Blocks on PTY read, pushes raw bytes to a channel.
*   **Batcher Thread:** Blocks on first byte, then "slurps" all available data (up to 64KB) from the channel.
*   **IPC:** Batched data is encoded as **Base64** strings (faster than byte arrays) and sent via **Tauri Channels** (not `window.emit`).

### 2. Context Aggregation System
*   **Watcher:** Monitors `~/.claude/projects/*.jsonl` for lines containing `ctx::`.
*   **Storage:** Stores raw markers in a SQLite database (`~/.floatty/ctx_markers.db`).
*   **Parser:** Background worker sends pending markers to a local Ollama instance for structured parsing.
*   **UI:** Sidebar polls for parsed markers.

### 3. Frontend (SolidJS)
*   **TerminalManager:** Singleton managing xterm.js instances *outside* the SolidJS reactivity system to prevent unwanted re-initializations.
*   **Keybinds:** Platform-aware (`Cmd` on macOS, `Ctrl` on Windows/Linux).
*   **Layout:** Recursive split-pane system.

## Development Guidelines

### SolidJS Specifics (CRITICAL)
*   **Reactivity:** Do **NOT** destructure props. Use `props.value`.
*   **Lists:** Use `<Key>` from `@solid-primitives/keyed` for heavy components (terminals), **NOT** `<For>`. `<For>` uses object reference identity, which can cause unnecessary unmounts.
*   **Proxies:** Store values are proxies. Clone them before putting them into new data structures.
*   **Visibility:** Use `display: none` instead of `<Show>` for components that must preserve state (like terminals) when hidden.

### Rust/Tauri Specifics
*   **IPC:** Use `tauri::ipc::Channel` for high-frequency data.
*   **Batching:** Maintain the "Greedy Slurp" pattern in `src-tauri/plugins/tauri-plugin-pty`.

## Key Commands

| Command | Description |
| :--- | :--- |
| `npm install` | Install JavaScript dependencies. |
| `npm run tauri dev` | Start development server (hot reload frontend, rebuild Rust). |
| `npm run tauri build` | Build for production. |
| `npm run lint` | Run ESLint. |

## File Structure Highlights

*   `src/`: SolidJS Frontend.
    *   `lib/terminalManager.ts`: Singleton managing xterm instances.
    *   `components/Terminal.tsx`: Tab orchestration.
*   `src-tauri/`: Rust Backend.
    *   `plugins/tauri-plugin-pty/`: Custom PTY implementation.
    *   `src/ctx_watcher.rs`: Log file watcher.
    *   `src/ctx_parser.rs`: Ollama integration.
*   `CLAUDE.md`: Contains detailed architectural diagrams and mental models. **Read this before making complex changes.**
