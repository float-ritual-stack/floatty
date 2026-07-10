# Floatty Documentation

> Terminal emulator + outliner + consciousness siphon

## Quick Start

| Guide | What You'll Learn |
|-------|-------------------|
| [Adding Handlers](guides/ADDING_HANDLERS.md) | Build executable block handlers (`sh::`, doors, custom) |
| [Doors](guides/DOORS.md) | Build user-land prefix handlers and views |
| [Event System](guides/EVENT_SYSTEM.md) | EventBus (sync) + ProjectionScheduler (async batched) |
| [Hook Patterns](guides/HOOK_PATTERNS.md) | Context assembly, validation, transformation |

## Tutorials

Retired `/send` tutorials have been removed from active docs. AI workflows now live in user-land doors such as `render:: ai` or future agent doors.

## Architecture

| Document | Status | Description |
|----------|--------|-------------|
| [Handler Registry](architecture/FLOATTY_HANDLER_REGISTRY.md) | Implemented | TypeScript handler system |
| [Hook System](architecture/FLOATTY_HOOK_SYSTEM.md) | Implemented | Execution lifecycle hooks |
| [Multi-Client](architecture/FLOATTY_MULTI_CLIENT.md) | Partial | Coordination protocol (desktop-only today) |
| [EventBus Migration Review](architecture/EVENTBUS_HOOK_MIGRATION_REVIEW.md) | Planning | What to migrate to EventBus |
| [Pattern Integration Sketch](architecture/PATTERN_INTEGRATION_SKETCH.md) | Exploration | `filter::`, `:::Component`, routing |

## Explorations (Not Yet Implemented)

These documents capture design thinking for future features:

| Document | Explores |
|----------|----------|
| [Backlinks & TTL](explorations/BACKLINKS_AND_TTL_EXPLORATION.md) | TTL context directives, backlink injection |
| [Pattern Integration](architecture/PATTERN_INTEGRATION_SKETCH.md) | Query system, component registry, routing |

## Archive

Completed work units and historical handoffs: [docs/archive/](archive/)

## CLAUDE.md

Root-level [CLAUDE.md](../CLAUDE.md) contains:
- Commands (`npm run tauri dev`, etc.)
- Architecture overview
- Testing patterns
- Key data flows
- Keyboard shortcuts

## Known doc gaps (2026-07-10 sweep)

Features in code with no current doc — write when touched:
- Pin shelf / navigation floor (shipped v0.18.0; FLO-137 spec describes a different, unbuilt model)
- Tantivy search implementation (`floatty-core/src/search/`) — ADR-005 + the refreshed layers doc cover architecture; the module-level internals (service/writer/schema/index_manager) have no doc
- Rust index hooks (`page_name_index.rs`, `inheritance_index.rs`)
- `img::` attachments (Phase 1 caching shipped; only the design spec exists)

Archive policy: point-in-time snapshots/audits/handoffs live under `archive/`
(`audits-reviews/`, `snapshots/`, `spikes-migrations/`, `handoffs/`). Aspirational
design docs stay in place with a `STATUS: ASPIRATIONAL` banner.
