# floatty

Terminal emulator + CRDT outliner + ctx:: aggregator. Native desktop app built with Tauri v2.

## Apps

| App | Stack | Run | Description |
|-----|-------|-----|-------------|
| `apps/floatty` | SolidJS + Tauri v2 + Rust | `pnpm -F float-pty tauri dev` | Main app — terminal, outliner, doors, search |
| `apps/outline-explorer` | Next.js 16 + React 19 + AI SDK | `pnpm -F outline-explorer dev` | AI-powered knowledge graph explorer |
| `apps/ink-chat` | Ink + React 19 + AI SDK | `pnpm -F ink-chat dev` | Terminal-based AI chat with json-render |

## Packages

| Package | Description |
|---------|-------------|
| `packages/` | Shared packages (planned — json-render catalog extraction) |

## Setup

```bash
pnpm install        # Install all workspace deps
```

## Development

```bash
# Run a specific app
pnpm -F float-pty tauri dev       # floatty (terminal + outliner)
pnpm -F outline-explorer dev      # outline explorer (https://outline-explorer.localhost)
pnpm -F ink-chat dev              # ink-chat (terminal UI)

# Build all
turbo run build

# Test
pnpm -F float-pty test            # floatty vitest (1120+ tests)
cd apps/floatty/src-tauri && cargo test -p float-pty    # Rust tests
cd apps/floatty/src-tauri && cargo test -p floatty-core  # Core lib tests
cd apps/floatty/src-tauri && cargo test -p floatty-server # Server tests
```

## Monorepo Tooling

- **pnpm** workspaces (`pnpm-workspace.yaml`: `apps/*`, `packages/*`)
- **Turborepo** for task orchestration (`turbo.json`: dev, build, test, lint)
- **portless** for `.localhost` HTTPS dev URLs (outline-explorer)

## Architecture

floatty is the primary app. See `apps/floatty/CLAUDE.md` for the full architecture reference.

```
SolidJS (local Y.Doc) → Tauri IPC → Rust (floatty-server) → Axum (Y.Doc authority, SQLite)
```

Core concepts:
- **Blocks** — everything is a block, blocks nest via indentation
- **Magic triggers** — `sh::`, `ai::`, `ctx::`, `render::` prefixes determine behavior
- **CRDT-native** — yrs/yjs enables concurrent writes from AI agents and terminal output
- **Doors** — specialized views into the block tree (render, daily, manifest, etc.)
- **json-render** — AI-driven component rendering via catalog + spec pattern

## Related

- [floatty CLAUDE.md](apps/floatty/CLAUDE.md) — detailed architecture, commands, patterns
- [outline-explorer CLAUDE.md](apps/outline-explorer/CLAUDE.md) — explorer setup + env vars
- [ink-chat CLAUDE.md](apps/ink-chat/CLAUDE.md) — terminal chat setup
