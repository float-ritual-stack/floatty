# Floatty AI Outline Explorer

A Next.js app for exploring and analyzing a [floatty](https://github.com/anthropics/floatty) knowledge graph with an AI-powered assistant. Browse pages, search blocks, view timelines, and have multi-turn conversations with Claude about your outline's structure and content.

## Quick Start

```bash
cp .env.example .env.local
# Fill in FLOATTY_URL, FLOATTY_API_KEY, AI_GATEWAY_API_KEY

pnpm install
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000).

## What This Does

The explorer connects to a running floatty-server and provides:

- **Pages browser** -- all pages sorted by block count, filterable
- **Full-text search** -- query blocks with type/marker/date filters
- **Timeline view** -- `ctx::` timestamped events across the graph
- **Block focus** -- drill into any block with breadcrumb, ancestors, children, outlinks
- **AI panel** -- multi-turn chat with Claude (Sonnet 4) that can walk the graph using 6 tools

The AI panel uses [json-render](https://github.com/anthropics/json-render) to emit structured components (pattern cards, stat pills, gap analysis, heatmaps) alongside prose.

## Architecture

```
src/
├── app/
│   ├── api/                    # Server routes proxying to floatty
│   │   ├── blocks/             # GET block(s) by ID
│   │   ├── chat/               # POST — AI streaming endpoint
│   │   ├── pages/              # GET pages by prefix
│   │   ├── search/             # GET full-text search
│   │   ├── stats/              # GET graph statistics
│   │   └── topology/           # GET graph topology
│   ├── layout.tsx
│   └── page.tsx
├── components/
│   ├── explorer.tsx            # Main shell — view switching, navigation, AI panel
│   ├── ai-panel.tsx            # Chat interface with predefined actions
│   ├── block-focus.tsx         # Block detail view
│   ├── pages-view.tsx          # Page list
│   ├── search-view.tsx         # Search UI
│   ├── timeline-view.tsx       # ctx:: timeline
│   ├── message-bubble.tsx      # AI message renderer (text + structured specs)
│   └── ...                     # block-row, step-card, walk-chip, etc.
├── hooks/
│   ├── use-block.ts            # Fetch block with context
│   ├── use-pages.ts            # Topology + page list
│   └── use-search.ts           # Debounced search
└── lib/
    ├── agents/
    │   └── explorer-agent.ts   # System prompt + 6 tool definitions
    ├── catalog/
    │   ├── explorer-catalog.ts # 35+ json-render component schemas
    │   ├── explorer-renderer.tsx # React renderer for specs
    │   └── block-to-spec.ts    # Block → json-render spec conversion
    ├── tools/                  # Individual tool implementations
    ├── floatty-client.ts       # Server-only floatty API wrapper
    ├── types.ts                # Shared TypeScript types
    └── constants.ts            # Colors, utilities
```

## AI Tools

The agent has 6 tools for walking the knowledge graph:

| Tool | What it does |
|------|-------------|
| `get_block` | Fetch a block by UUID with subtree and breadcrumb |
| `expand_page` | Fetch a page's full subtree by title (fuzzy match) |
| `search_blocks` | Full-text search with type/marker/date filters |
| `get_inbound` | Find blocks that link to a target via wikilinks |
| `suggest_walks` | Recommend pages to explore next |
| `qmd_search` | Search external knowledge base (4900+ docs) |

## Structured Output

The AI emits `` ```spec `` fenced blocks containing [RFC 6902 JSON Patch](https://datatracker.ietf.org/doc/html/rfc6902) operations that build a component tree:

```json
{"op":"add","path":"/root","value":"main"}
{"op":"add","path":"/elements/main","value":{"type":"Section","props":{"title":"Findings"}}}
```

These are piped through `pipeJsonRender()` on the server, extracted via `useJsonRenderMessage()` on the client, and rendered by `ExplorerRenderer` using a catalog of 35+ components -- pattern cards, stat pills, observation cards, heatmaps, link graphs, and more.

## Predefined Actions

The AI panel offers one-click analysis:

- **Summarize** -- what is this page about?
- **Patterns** -- recurring themes and structures
- **Bridge Walk** -- connections to other parts of the graph
- **Cold-Start** -- orientation for someone new to this content
- **Gaps** -- what's missing or underdeveloped?

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `FLOATTY_URL` | Yes | URL of the floatty-server instance |
| `FLOATTY_API_KEY` | Yes | API key for floatty-server auth |
| `AI_GATEWAY_API_KEY` | Yes | API key for AI gateway (Claude access) |

## Tech Stack

- **Next.js 16** (App Router, Turbopack)
- **React 19**
- **AI SDK 6** (Vercel) -- streaming, tools, multi-step agents
- **json-render** -- structured component specs from AI output
- **Streamdown** -- markdown rendering in chat
- **Tailwind CSS 4**
- **Zod 4** -- runtime validation
- **Lucide** -- icons

## Development

```bash
pnpm dev        # Start dev server
pnpm build      # Production build
pnpm lint       # ESLint
```

Requires a running floatty-server and valid API credentials. The app is server-side authenticated -- API keys never reach the client.
