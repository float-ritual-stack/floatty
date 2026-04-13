# Floatty Architecture

> Start here: **[ARCHITECTURE_MAP.md](./ARCHITECTURE_MAP.md)** — the four-layer model, six invariants, and full document index.

## Quick Navigation

| What You Need | Read This |
|---------------|-----------|
| **Big picture** | [ARCHITECTURE_MAP.md](./ARCHITECTURE_MAP.md) — layers, invariants, status |
| **Add a handler** | [RICH_OUTPUT_HANDLER_GUIDE.md](./RICH_OUTPUT_HANDLER_GUIDE.md) |
| **Keyboard patterns** | [KEYBOARD_CONTROL_PATTERNS.md](./KEYBOARD_CONTROL_PATTERNS.md) |
| **Y.Doc rules** | [ydoc-patterns.md](../../.claude/rules/ydoc-patterns.md) |
| **SolidJS traps** | [solidjs-patterns.md](../../.claude/rules/solidjs-patterns.md) |
| **What NOT to do** | [do-not.md](../../.claude/rules/do-not.md) |
| **Decision records** | [../adrs/](../adrs/) — ADR-001 through ADR-005 |

## All Documents

### Architecture (How It Works)

| Document | Purpose |
|----------|---------|
| [ARCHITECTURE_MAP.md](./ARCHITECTURE_MAP.md) | **Start here** — four-layer model, document index |
| [HANDLER_REGISTRY_IMPLEMENTATION.md](./HANDLER_REGISTRY_IMPLEMENTATION.md) | Handler implementation details `[SHIPPED]` |
| [FLOATTY_HOOK_SYSTEM.md](./FLOATTY_HOOK_SYSTEM.md) | Hook lifecycle contracts `[SHIPPED — has known error, see doc]` |
| [EVENTBUS_HOOK_MIGRATION_REVIEW.md](./EVENTBUS_HOOK_MIGRATION_REVIEW.md) | Two-lane event system `[SHIPPED — status column stale]` |
| [KEYBOARD_CONTROL_PATTERNS.md](./KEYBOARD_CONTROL_PATTERNS.md) | Four keyboard patterns `[SHIPPED]` |
| [LOGGING_STRATEGY.md](./LOGGING_STRATEGY.md) | Structured logging guide `[SHIPPED — needs reorganization]` |
| [RUST_MODULARIZATION_GUIDE.md](./RUST_MODULARIZATION_GUIDE.md) | Rust backend structure `[ASPIRATIONAL]` |
| [archive/FLOATTY_HANDLER_REGISTRY_ORIGINAL_VISION.md](../archive/FLOATTY_HANDLER_REGISTRY_ORIGINAL_VISION.md) | Original Rust handler vision `[ARCHIVED — superseded]` |

### Guides (How To Build)

| Document | Purpose |
|----------|---------|
| [RICH_OUTPUT_HANDLER_GUIDE.md](./RICH_OUTPUT_HANDLER_GUIDE.md) | Adding new `prefix::` output handlers |
| [INLINE_EXPANSION_PATTERNS.md](./INLINE_EXPANSION_PATTERNS.md) | Per-item expandable state `[ASPIRATIONAL — not implemented]` |

### Vision (Where We're Going)

| Document | Purpose |
|----------|---------|
| [MDX_LITE_VISION.md](./MDX_LITE_VISION.md) | Children-as-config component blocks `[PARTIAL — filter:: shipped, kanban/grid/poll aspirational]` |
| [FLOATTY_MULTI_CLIENT.md](./FLOATTY_MULTI_CLIENT.md) | Multi-client protocol `[PARTIAL — Y.Doc sync shipped, coordination protocol aspirational]` |
| [INTENT_PRIMITIVES.md](./INTENT_PRIMITIVES.md) | Stable API vocabulary `[ASPIRATIONAL — not implemented]` |

### Agent Runtime (Execution Roles)

| Document | Purpose |
|----------|---------|
| [agentic-runtime/README.md](./agentic-runtime/README.md) | Alignment layer overview |
| [agentic-runtime/agent-roles.md](./agentic-runtime/agent-roles.md) | clerk / librarian / gardener / renderer |
| [agentic-runtime/clerk.md](./agentic-runtime/clerk.md) | Ingestion boundary |
| [agentic-runtime/state-model.md](./agentic-runtime/state-model.md) | raw → normalized → refined → projected |
| [agentic-runtime/work-log-model.md](./agentic-runtime/work-log-model.md) | Attribution layer |
| [agentic-runtime/provenance-and-links.md](./agentic-runtime/provenance-and-links.md) | Provenance discipline |
| [agentic-runtime/agent-types.md](./agentic-runtime/agent-types.md) | Outline-native vs external execution agents |
| [agentic-runtime/clerk-interface.md](./agentic-runtime/clerk-interface.md) | Clerk as fuzzy compiler / ingestion DSL |

### Lineage (Why It's This Shape)

| Document | Purpose |
|----------|---------|
| [FORTY_YEAR_PATTERN.md](./FORTY_YEAR_PATTERN.md) | BBS → mIRC → Redux → floatty |
| [BBS_OUTLINE_CONVERGENCE.md](./BBS_OUTLINE_CONVERGENCE.md) | Conceptual convergence |
| [SHIMMER_TO_PATTERNS.md](./SHIMMER_TO_PATTERNS.md) | Ritual vocabulary → standard patterns |
| [PHILOSOPHY.md](./PHILOSOPHY.md) | Design philosophy |
| [PATTERN_INTEGRATION_SKETCH.md](./PATTERN_INTEGRATION_SKETCH.md) | Pattern integration roadmap |
| [EDITOR_ARCHAEOLOGY.md](./EDITOR_ARCHAEOLOGY.md) | Editor iteration history |

## The Principle

> "Build interfaces that travel. Don't build the destination yet."

Shacks, not cathedrals. Walls that can move.

## Related

- [../EXTERNAL_BLOCK_EXECUTION.md](../EXTERNAL_BLOCK_EXECUTION.md) - Auto-execute spike (implemented)
- [../BLOCK_TYPE_PATTERNS.md](../BLOCK_TYPE_PATTERNS.md) - Child-output pattern
- [../KEYBOARD.md](../KEYBOARD.md) - Keyboard architecture & bindings
