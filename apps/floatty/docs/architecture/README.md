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

## All Documents

### Architecture (How It Works)

| Document | Purpose |
|----------|---------|
| [ARCHITECTURE_MAP.md](./ARCHITECTURE_MAP.md) | **Start here** — four-layer model, document index |
| [FLOATTY_HANDLER_REGISTRY.md](./FLOATTY_HANDLER_REGISTRY.md) | Handler registry design |
| [HANDLER_REGISTRY_IMPLEMENTATION.md](./HANDLER_REGISTRY_IMPLEMENTATION.md) | Handler implementation details |
| [FLOATTY_HOOK_SYSTEM.md](./FLOATTY_HOOK_SYSTEM.md) | Hook lifecycle contracts |
| [EVENTBUS_HOOK_MIGRATION_REVIEW.md](./EVENTBUS_HOOK_MIGRATION_REVIEW.md) | Two-lane event system |
| [KEYBOARD_CONTROL_PATTERNS.md](./KEYBOARD_CONTROL_PATTERNS.md) | Four keyboard patterns |
| [LOGGING_STRATEGY.md](./LOGGING_STRATEGY.md) | Structured logging guide |
| [RUST_MODULARIZATION_GUIDE.md](./RUST_MODULARIZATION_GUIDE.md) | Rust backend structure |

### Guides (How To Build)

| Document | Purpose |
|----------|---------|
| [RICH_OUTPUT_HANDLER_GUIDE.md](./RICH_OUTPUT_HANDLER_GUIDE.md) | Adding new `prefix::` output handlers |
| [INLINE_EXPANSION_PATTERNS.md](./INLINE_EXPANSION_PATTERNS.md) | Per-item expandable state |

### Vision (Where We're Going)

| Document | Purpose |
|----------|---------|
| [MDX_LITE_VISION.md](./MDX_LITE_VISION.md) | Children-as-config component blocks |
| [FLOATTY_MULTI_CLIENT.md](./FLOATTY_MULTI_CLIENT.md) | Multi-client protocol |
| [INTENT_PRIMITIVES.md](./INTENT_PRIMITIVES.md) | Stable API vocabulary |

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
