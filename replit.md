# float-pty

A terminal emulator + CRDT outliner + ctx:: aggregator built with SolidJS and Tauri v2.

## Architecture

- **Frontend**: SolidJS (fine-grained reactivity, no virtual DOM) + Vite
- **Backend**: Tauri v2 + Rust (IPC, subprocess management) — native desktop only
- **Server**: Axum (headless Y.Doc authority, SQLite)
- **CRDT**: Yjs (frontend) ↔ Yrs (backend) via base64-encoded updates

## Replit Setup

This is a **Tauri desktop application**. In Replit, only the Vite frontend runs (port 5000). The Tauri/Rust backend (PTY, IPC, floatty-server) requires a native desktop environment and is not available in the browser.

The frontend will show a "Failed to connect to floatty-server" error in the browser since the Tauri backend is not running — this is expected behavior in the web environment.

## Dev Server

- **Port**: 5000
- **Host**: 0.0.0.0
- **Command**: `npm run dev`

## Key Files

- `src/` — SolidJS frontend source
- `src-tauri/` — Rust/Tauri backend
- `vite.config.ts` — Vite configuration
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
