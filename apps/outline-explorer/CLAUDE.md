# Outline Explorer

Floatty knowledge graph explorer — AI-driven navigation of the floatty outline via structured component rendering.

## Stack

Next.js 16 (App Router) + React 19 + Vercel AI SDK 6 + json-render (catalog-driven component emission) + Tailwind 4.

## Commands

```bash
pnpm dev        # Next.js dev server (needs env vars below)
pnpm build      # Production build
pnpm lint       # ESLint
pnpm mcp:dev    # Build + start standalone MCP server
```

## Environment Variables

Required in `.env.local` (or injected via shell):

```
FLOATTY_URL=http://127.0.0.1:8765    # floatty-server API
FLOATTY_API_KEY=floatty-...           # from ~/.floatty/config.toml or ~/.floatty-dev/config.toml
ANTHROPIC_API_KEY=sk-ant-...          # for AI chat features
```

## Architecture

- `src/app/` — Next.js App Router pages + API routes (blocks, chat, pages, search, stats, topology)
- `src/components/` — UI shell, AI panel, block views, message rendering
- `src/lib/agents/` — explorer agent with 6 tools (floatty API wrappers)
- `src/lib/catalog/` — 35+ json-render component schemas for AI-driven rendering
- `src/lib/tools/` — tool implementations for the AI agent
- `src/lib/floatty-client.ts` — server-side API wrapper (keys never reach browser)
- `src/mcp/` — standalone MCP server build (Vite + tsx)

## json-render

Uses `@json-render/core`, `@json-render/react`, `@json-render/mcp` from npm (currently `^0.19.0`). The 0.19 bump added the `@json-render/directives` package — outline-explorer's `ExplorerRenderer` wraps `createRenderer()` to default-inject `floattyDirectives` from `@float/render-catalog` so `$projectColor` / `$ctxColor` / `$wikilink` (plus the bundled standardDirectives — `$format`/`$math`/`$concat`/etc.) resolve symmetrically with render-door.

**Cross-package precedent (PR #262)**: `packages/render-door/` extracted from `apps/floatty/doors/render/` after `apps/render-reference` (the contract harness) became a regular consumer of the door's catalog + components. The same pattern applies here whenever outline-explorer's catalog grows a peer-app consumer — the playbook is in `~/.claude/projects/-Users-evan-projects--float-float-substrate-floatty/memory/feedback_door_extraction_pattern.md` and `.claude/rules/door-development.md` "Monorepo paths" section.

@AGENTS.md
