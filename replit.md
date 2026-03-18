# float-pty

A terminal emulator + CRDT outliner + ctx:: aggregator built with SolidJS and Tauri v2.

## Architecture

- **Frontend**: SolidJS (fine-grained reactivity, no virtual DOM) + Vite
- **Backend**: Tauri v2 + Rust (IPC, subprocess management) — native desktop only
- **Server**: Axum (headless Y.Doc authority, SQLite) — runs standalone in Replit
- **CRDT**: Yjs (frontend) ↔ Yrs (backend) via base64-encoded updates

## Replit Setup

The project runs two services:

1. **Frontend** (port 5000): Vite + SolidJS dev server
2. **Backend** (port 8080): floatty-server (Rust/Axum REST API + WebSocket)

The Tauri native desktop shell (PTY, IPC) is not available in the browser. The terminal shows "Dev Mode: PTY unavailable. Echo mode active." — this is expected. The outliner, CRDT sync, and block store all work through the REST API.

### Building the Backend

The Rust server binary is pre-built at `src-tauri/target-server/debug/floatty-server`. If you need to rebuild:

```bash
cd src-tauri
CARGO_TARGET_DIR=target-server FLOATTY_DATA_DIR=$HOME/.floatty-replit cargo build -p floatty-server -j 2
```

Note: Uses system SQLite (`rusqlite` without `bundled` feature in `floatty-core/Cargo.toml`) to avoid slow C compilation.

### Configuration

Server config is at `~/.floatty-replit/config.toml`:
- Port: 8080
- Auth: disabled for development
- Backup: disabled
- Bind: 0.0.0.0

### Frontend ↔ Backend Connection

In browser mode (no Tauri), `src/lib/httpClient.ts` bypasses Tauri IPC and connects directly to the floatty-server REST API at port 8080.

## Key Files

- `src/` — SolidJS frontend source
- `src-tauri/` — Rust/Tauri backend
- `src-tauri/floatty-server/` — Standalone REST API server
- `src-tauri/floatty-core/` — Core block store, persistence, hooks
- `vite.config.ts` — Vite configuration (port 5000, host 0.0.0.0)
- `package.json` — JS dependencies and scripts

## Commands

```bash
npm install         # Install JS dependencies
npm run dev         # Start Vite dev server (port 5000)
npm run build       # Build for production
npm run lint        # ESLint
npm run test        # Run vitest tests
```

## Deployment

Configured as a static site deployment:
- Build command: `npm run build`
- Public directory: `dist`
