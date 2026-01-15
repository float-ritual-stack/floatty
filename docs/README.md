# Floatty Documentation

> Terminal emulator + outliner + consciousness siphon

## Quick Start

| Guide | What You'll Learn |
|-------|-------------------|
| [Adding Handlers](guides/ADDING_HANDLERS.md) | Build executable block handlers (`sh::`, `ai::`, custom) |
| [Event System](guides/EVENT_SYSTEM.md) | EventBus (sync) + ProjectionScheduler (async batched) |
| [Hook Patterns](guides/HOOK_PATTERNS.md) | Context assembly, validation, transformation |

## Tutorials

| Tutorial | Description |
|----------|-------------|
| [Building Chat with Hooks](tutorials/BUILDING_CHAT_WITH_HOOKS.md) | Deep-dive into `/send` command and multi-turn conversations |
| [Chat With vs Without Hooks](tutorials/CHAT_WITH_VS_WITHOUT_HOOKS.md) | Before/after comparison showing hook benefits |

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
