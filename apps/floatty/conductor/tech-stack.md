# Tech Stack - Floatty

## Frontend
- **Framework:** SolidJS (Reactive UI library)
- **Language:** TypeScript
- **Build Tool:** Vite
- **Terminal Component:** xterm.js (with WebGL, Unicode11, and Ligatures addons for high-performance rendering)

## Backend
- **Framework:** Tauri v2 (Desktop application framework)
- **Language:** Rust
- **Database:** SQLite (using `rusqlite` for local data persistence)
- **Runtime:** Tokio (Asynchronous runtime for Rust)

## AI/ML
- **Local LLM:** Ollama (integration for parsing context markers)

## PTY
- **Implementation:** Custom vendored `tauri-plugin-pty` with optimized "Greedy Slurp" batching for high throughput.
