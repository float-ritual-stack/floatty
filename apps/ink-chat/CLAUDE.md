# ink-chat

Terminal-based AI chat with json-render component rendering via Ink (React for the terminal).

## Stack

Ink 6 + React 19 + AI SDK 6 + json-render (core + ink renderer) + TypeScript.

## Commands

```bash
pnpm dev        # Run with tsx (needs .env with API keys)
pnpm build      # Compile TypeScript
pnpm start      # Run compiled output
```

## Environment Variables

Requires `.env` file (see `.env.example`):

```
FLOATTY_URL=http://127.0.0.1:8765
FLOATTY_API_KEY=your-api-key-here
AI_GATEWAY_API_KEY=your-gateway-key-here
```

## Architecture

5 source files:
- `src/index.tsx` — Ink app entry, terminal setup
- `src/app.tsx` — main chat component
- `src/catalog.ts` — json-render component catalog for Ink rendering
- `src/block-to-spec.ts` — converts floatty blocks to json-render specs
- `src/tools.ts` — AI SDK tool definitions

## json-render

Uses `@json-render/core` and `@json-render/ink` from npm (currently `^0.17.0`). Future: these may move to workspace packages in `packages/` for shared development with outline-explorer and floatty doors.
