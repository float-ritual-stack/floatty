# Doors v2: Deep Links + Chirp Write + Session Threading

**Created**: 2026-03-27
**Status**: Spec (informed by spike/json-render-door, dependency-flipped from spike version)
**Spike reference**: `spike/json-render-door` (PR #185) — lessons learned, don't copy code

## Design Principle

Deep links are the primitive. Chirp is a convenience wrapper.

```
floatty://verb?params    ← the implementation (URI handler in App.tsx)
chirp('verb', params)    ← thin dispatch (constructs URI, fires it)
```

All write operations — from terminal, scripts, webhooks, and rendered door views —
hit the same URI handler. One code path, one set of tests.

The spike had chirp as the primitive with deep links reimplementing the same verbs.
This spec flips the arrow: deep links define verbs, chirp constructs URIs and dispatches.

## Prior Art

- Obsidian Advanced URI (`obsidian://adv-uri`) — file-level CRUD + command execution via URI
- floatty artifact:: chirp protocol — postMessage bridge with ack pattern (exists)
- floatty render:: agent `--continue`/`--resume` — session persistence (exists in spike)
- Table blocks — raw ↔ rich toggle, content = source of truth (exists)
- floatty deep links — `floatty://navigate/<page>?pane=<uuid>` (exists in `src/App.tsx:141-173`)

---

## Unit 1.0: Deep Link Write Verbs (the primitive)

### What exists

`floatty://navigate/<page>?pane=<uuid>` — App.tsx:141-173 handles, navigates to page.
Single hostname check (`navigate`). No block-level operations.

### URI Scheme

| URI | Behavior |
|-----|----------|
| `floatty://navigate/<page>?pane=<uuid>` | Go to page (exists) |
| `floatty://block/<id>?pane=<uuid>` | Navigate to block by ID or short-hash |
| `floatty://execute?content=<encoded>&parent=<id>&after=<id>` | Create block, execute handler |
| `floatty://upsert?parent=<id>&content=<encoded>&match=<prefix>` | Find-or-create child block |

### Execute params

| Param | Required | Description |
|-------|----------|-------------|
| `content` | yes | URL-encoded block content |
| `parent` | no | Parent block ID (default: active root) |
| `after` | no | Insert after this sibling |
| `pane` | no | Target pane for navigation after creation |

**Security** (FM #2): Content routes through the existing handler system (`src/lib/handlers/`).
`floatty://execute?content=sh::+rm+-rf+/` goes through `sh::` handler validation, not raw shell.

### Upsert params

| Param | Required | Description |
|-------|----------|-------------|
| `parent` | yes | Parent block ID |
| `content` | yes | URL-encoded content for new block |
| `match` | yes | Content prefix to match existing children |
| `navigate` | no | Navigate to result (default: true) |
| `execute` | no | Execute handler after creation (default: false) |

**Atomicity**: Find + create happens in a single Y.Doc transaction via
`findChildByPrefix()` in useBlockStore.ts. No race between read and write.

**Idempotency**: Calling upsert twice with the same match prefix → navigates to
existing block, doesn't create duplicate. FM #6 guard: use stable prefix strings.

### findChildByPrefix

```typescript
// In useBlockStore.ts — reads from Y.Doc, not reactive state (FM #4)
findChildByPrefix(parentId: string, prefix: string): string | null
```

Must read from Y.Doc inside a transaction (ydoc-patterns Rule #14).

### Files to modify

| File | Change |
|------|--------|
| `src/App.tsx` | Extend deep link handler — multi-hostname dispatcher |
| `src/hooks/useBlockStore.ts` | Add `findChildByPrefix()` |

### Failure Semantics

| Scenario | Outcome |
|----------|---------|
| `floatty://block/<id>` — block not found | Log warning, no-op |
| `floatty://block/<id>` — ambiguous short hash | Log warning with matches, no-op |
| `floatty://execute` — parent missing | No-op + console error |
| `floatty://execute` — unknown handler prefix | Create plain block, no handler fires, navigate |
| `floatty://execute` — handler throws | Block remains, output status='error', navigate |
| `floatty://execute` — content empty | No-op + console error |
| `floatty://execute` — duplicate replay | Idempotent if upsert; creates duplicate if plain execute |
| `floatty://upsert` — parent missing | No-op + console error, don't create orphans |
| `floatty://upsert` — match finds existing | Navigate to existing, no creation |
| `floatty://upsert` — match finds nothing | Create child, optionally execute, navigate |

### Tests

- Unit: `findChildByPrefix` with exact match, partial match, no match
- Unit: upsert idempotency — call twice with same prefix, verify single child
- Manual: `floatty://block/abc123` from terminal → navigates
- Manual: `floatty://execute?content=render::+demo` → creates and renders

---

## Unit 1.1: Chirp Write Dispatch (thin wrapper)

### What exists

`chirp('navigate', { target, sourceEvent })` — BlockItem listens on wrapper,
routes through `handleChirpNavigate()`. One verb, read-only.

### What to add

| Verb | Params | Maps to |
|------|--------|---------|
| `create-child` | `{ content, execute?, navigate? }` | `floatty://execute?parent=<blockId>&content=...` |
| `upsert-child` | `{ content, match, execute?, navigate? }` | `floatty://upsert?parent=<blockId>&content=...&match=...` |

### Implementation

Extend BlockItem chirp listener. Each write verb constructs a `floatty://` URI
and dispatches to the deep link handler. No business logic in chirp — just URI construction.

```typescript
case 'create-child':
  // → floatty://execute?content=<encoded>&parent=<props.id>
case 'upsert-child':
  // → floatty://upsert?parent=<props.id>&content=<encoded>&match=<prefix>
```

### Scoping constraint

Chirp writes are scoped: a door can only create children of its OWN block.
`parent` is always the emitting block's ID (`props.id`). No cross-tree writes.

---

## Unit 1.2: Agent Session Threading (independent)

### What exists (current codebase)

- `doors/render/render.tsx` agent route shells to `claude -p`
- `--continue` flag (most recent session in CWD — non-deterministic)
- `--resume <id>` support exists but defaults to `--continue`
- Session ID parsed from output via regex

### What to change

1. **Default to `--resume`**: Store session ID in block metadata `[session::abc123]`
2. **Session ID searchable**: `[session::abc123]` marker in content → Tantivy indexes it
3. **`--fork-session`** for branch drill-downs (explore alternative without polluting main session)
4. **Expired session fallback**: `--resume` on dead session → error message, not silent fork

### Session lineage (block-level trace)

When a resumed session generates a follow-up child block:
- **Child gets its OWN session marker**: `[session::new456]` (new session from the agent run)
- **Child also gets parent reference**: `[parent-session::abc123]` (the session it resumed from)
- **Fork gets branch marker**: `[forked-from::abc123]` when using `--fork-session`
- This gives searchable lineage: find all blocks in a session chain via marker queries

### Drill-down flow (uses chirp upsert from Unit 1.1)

```
render:: agent summarize daily notes
  [session::abc12345]
  → renders summary, user clicks "March 24"
  → chirp('upsert-child', {
      content: 'render:: agent --resume abc12345 show March 24 detail',
      match: 'render:: agent --resume abc12345 show March 24',
      execute: true, navigate: true
    })
  → child block created, auto-executes with parent session context
```

---

## Unit 1.3: Spec-as-Content (independent)

After execution, block content = command + JSON spec. Makes specs searchable via Tantivy.

```
render:: agent show daily summary
{"root":"layout","elements":{...}}
```

Raw/rich toggle (like table blocks): default rich (rendered), toggle shows raw JSON
in contentEditable.

---

## Edge Cases (from adversarial review)

1. **Upsert race**: Two rapid clicks → atomic Y.Doc transaction
2. **Orphaned sessions**: `--resume` on dead session → fall back to new session with warning
3. **Content-prefix fragility**: User edits block → match breaks. Use block ID when available
4. **Infinite drill-down**: Cap at 10 levels or require explicit Enter
5. **Chirp write scope**: Door can only create children of its own block
6. **Deep link injection**: `floatty://execute` routes through handler validation, not raw shell
7. **Short hash collision**: `floatty://block/abc123` → if ambiguous, log warning and skip
8. **Parent doesn't exist**: `floatty://upsert?parent=nonexistent` → no-op, don't create orphans
9. **Handler not registered**: `floatty://execute?content=unknown::+test` → create block, no handler fires
10. **Session bloat**: `--max-budget-usd` cap per agent call

## Implementation Order

| # | Unit | Depends On | Delivers |
|---|------|-----------|----------|
| 1.0 | Deep link write verbs | Phase 0 | URI handler, findChildByPrefix |
| 1.1 | Chirp write dispatch | 1.0 | Thin wrapper constructing URIs |
| 1.2 | Agent session threading | Phase 0 | --resume default, session markers |
| 1.3 | Spec-as-content | Phase 0 | JSON in content, raw/rich toggle |

Units 1.0 and 1.2 can start in parallel (independent). Unit 1.1 depends on 1.0.
Unit 1.3 is independent.
