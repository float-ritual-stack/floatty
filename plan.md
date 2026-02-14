# ACP Integration Plan for floatty

## Classification
Handler + Projection composite. Agent subprocess lifecycle (Handler) + pane rendering of agent state (Projection).

## Architecture

```
Frontend (SolidJS AcpPane)
  ↕ invoke() + Channel<AcpUpdate>
Tauri Backend (Rust AcpManager)
  ↕ stdin/stdout (newline-delimited JSON-RPC)
Agent Subprocess (Claude Code, Gemini CLI, etc.)
```

## Phase 1: Rust Foundation
1. Add agent-client-protocol crate (or manual JSON-RPC types)
2. Create services/acp.rs — AcpManager (spawn, session, IO)
3. Create commands/acp.rs — Tauri command wrappers
4. Register in lib.rs
5. Handle agent→client requests (fs read/write, terminal ops, permissions)

## Phase 2: Frontend
6. Add 'acp' to leafType union in layoutTypes.ts
7. Update Terminal.tsx pane rendering (Switch instead of Show)
8. Create AcpPane.tsx component
9. Create useAcpStore.ts hook
10. Add keybind for ACP pane

## Phase 3: Agent Capabilities
11. fs/read_text_file + fs/write_text_file handlers
12. terminal/* handlers (reuse PTY infrastructure)
13. Permission request flow (bidirectional)

## Phase 4: Polish
14. Config in config.toml
15. Connection status
16. Error recovery
17. Message history

## Key Files
- NEW: src-tauri/src/services/acp.rs
- NEW: src-tauri/src/commands/acp.rs
- NEW: src/components/AcpPane.tsx
- NEW: src/hooks/useAcpStore.ts
- NEW: src/lib/acpTypes.ts
- MOD: src/lib/layoutTypes.ts (add 'acp' leafType)
- MOD: src/hooks/useLayoutStore.ts (accept 'acp')
- MOD: src/components/Terminal.tsx (3-way pane rendering)
- MOD: src-tauri/src/lib.rs (register commands)
- MOD: src-tauri/Cargo.toml (add crate)

## Risk: Medium
Subprocess lifecycle is proven pattern. Bidirectional JSON-RPC is new but contained.
