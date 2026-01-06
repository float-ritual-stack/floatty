# Floatty Architecture

> Extracted from architecture sessions 2026-01-04. The roadmap for handler registry, hook system, and multi-client support.

## Documents

| Document | Purpose |
|----------|---------|
| [FORTY_YEAR_PATTERN.md](./FORTY_YEAR_PATTERN.md) | The lineage: BBS → mIRC → Redux → floatty |
| [FLOATTY_HANDLER_REGISTRY.md](./FLOATTY_HANDLER_REGISTRY.md) | Reduce 7-file ceremony to 2 files for new block types |
| [FLOATTY_HOOK_SYSTEM.md](./FLOATTY_HOOK_SYSTEM.md) | Block lifecycle hooks, AI context assembly |
| [FLOATTY_MULTI_CLIENT.md](./FLOATTY_MULTI_CLIENT.md) | Desktop as execution daemon, agent integration |
| [SHIMMER_TO_PATTERNS.md](./SHIMMER_TO_PATTERNS.md) | Translation from ritual vocabulary to standard patterns |

## The Incremental Path

```
╭─────────────────────────────────────────────────────────────────╮
│  DONE                                                            │
│  ├─ Y.Doc sync (floatty-server)                                 │
│  ├─ Auto-execute spike for external blocks                      │
│  └─ See: ../EXTERNAL_BLOCK_EXECUTION.md                         │
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│  NEXT                                                            │
│  ├─ Handler registry (FLOATTY_HANDLER_REGISTRY.md)              │
│  └─ Context assembly hook (FLOATTY_HOOK_SYSTEM.md)              │
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│  WHEN NEEDED                                                     │
│  ├─ Server-side execution (POST /execute)                       │
│  ├─ MCP tool exposure                                            │
│  └─ See: FLOATTY_MULTI_CLIENT.md                                │
╰─────────────────────────────────────────────────────────────────╯
```

## The Principle

> "Build interfaces that travel. Don't build the destination yet."

Shacks, not cathedrals. Walls that can move.

## Related

- [../EXTERNAL_BLOCK_EXECUTION.md](../EXTERNAL_BLOCK_EXECUTION.md) - Auto-execute spike (implemented)
- [../BLOCK_TYPE_PATTERNS.md](../BLOCK_TYPE_PATTERNS.md) - Child-output pattern
- [../RECON_BLOCK_SYSTEM.md](../RECON_BLOCK_SYSTEM.md) - Block system archaeology
