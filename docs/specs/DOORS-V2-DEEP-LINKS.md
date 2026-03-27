# Doors v2: Deep Links + Chirp Write + Session Threading

**Status**: Spec (informed by spike/json-render-door)
**Branch**: Start fresh from `main`
**Spike reference**: `spike/json-render-door` (PR #185) — lessons learned, don't copy code

## What This Builds

Three primitives that make doors a real navigation + automation substrate:

1. **Chirp write verbs** — rendered views can create/update blocks, not just navigate
2. **Deep link actions** — `floatty://` URIs that create, navigate, and execute blocks
3. **Agent session threading** — `--resume <id>` chains render:: agent calls across drill-downs

## Prior Art

- Obsidian Advanced URI (`obsidian://adv-uri`) — file-level CRUD + command execution via URI
- floatty artifact:: chirp protocol — postMessage bridge with ack pattern (exists)
- floatty render:: agent `--continue`/`--resume` — session persistence (exists in spike)
- Table blocks — raw ↔ rich toggle, content = source of truth (exists)

---

## Unit 1: Chirp Write Verbs

### What exists

`chirp('navigate', { target, sourceEvent })` — BlockItem listens, routes through `navigateWikilink`. One verb, read-only.

### What to add

| Verb | Params | Behavior |
|------|--------|----------|
| `navigate` | `{ target, sourceEvent }` | Go to page/block (exists) |
| `create-child` | `{ parentId, content, execute?, navigate? }` | Create child block under parentId |
| `upsert-child` | `{ parentId, content, match: { contentPrefix }, execute?, navigate? }` | Find existing child by prefix match, or create. Navigate to it. |
| `update` | `{ blockId, content }` | Update existing block content |

### Files to modify

| File | Change |
|------|--------|
| `src/components/BlockItem.tsx` | Extend chirp listener (onMount handler) to route new verbs to store operations |
| `src/hooks/useBlockStore.ts` | Add `findChildByPrefix(parentId, prefix)` — scans childIds for content match |

### Implementation

BlockItem chirp listener (already exists from spike):

```typescript
// In the chirp handler, add verb routing:
if (e.detail?.message === 'create-child') {
  const { content, execute, navigate } = e.detail;
  const childId = store.createBlockInside(props.id, content);
  if (navigate) props.onFocus(childId);
  if (execute) { /* trigger handler execution on the new block */ }
}

if (e.detail?.message === 'upsert-child') {
  const { content, match, execute, navigate } = e.detail;
  const existing = store.findChildByPrefix(props.id, match.contentPrefix);
  if (existing) {
    if (navigate) props.onFocus(existing);
  } else {
    const childId = store.createBlockInside(props.id, content);
    if (navigate) props.onFocus(childId);
    if (execute) { /* trigger handler */ }
  }
}
```

### Scoping constraint

Chirp writes are scoped: a door can only create children of its OWN block (the block that rendered the door). `parentId` in chirp is always the emitting block — no cross-tree writes.

### Tests

- Unit: `findChildByPrefix` with exact match, partial match, no match
- Unit: upsert idempotency — call twice with same prefix, verify single child
- Manual: render:: view with button that creates a child block on click

---

## Unit 2: Deep Link Actions

### What exists

`floatty://navigate/<page-name>?pane=<uuid>` — App.tsx handles, navigates to page.

### What to add

| URI | Behavior |
|-----|----------|
| `floatty://navigate/<page>` | Go to page (exists) |
| `floatty://block/<id>` | Navigate to block by ID or short-hash |
| `floatty://execute?content=<encoded>` | Create block with content, execute its handler |
| `floatty://upsert?parent=<id>&content=<encoded>&match=<prefix>` | Upsert child block |

### Files to modify

| File | Change |
|------|--------|
| `src/App.tsx` | Extend deep link handler with new action routing |
| `src-tauri/src/lib.rs` | Register `floatty://` scheme handler (if not already) |

### Security

- `floatty://execute` uses the same handler system as Enter-on-block — no raw shell passthrough
- Content is URL-decoded, then matched against registered `prefix::` handlers
- Unknown prefixes = no-op (block created but not executed)
- Handler validation happens in `doorLoader.ts` / `registry.ts`, not in the URI parser

### Tests

- Manual: open `floatty://block/abc123` from terminal → navigates to block
- Manual: open `floatty://execute?content=render::+demo` → creates and renders

---

## Unit 3: Agent Session Threading

### What exists (spike)

- `render:: agent <prompt>` shells to `claude -p` with system prompt
- `render:: agent --continue <prompt>` uses `--continue` flag (most recent session in CWD)
- `render:: agent --resume <id> <prompt>` uses `--resume` with session ID
- `agentSessionId` stored in `RenderViewData`, shown in footer

### What to change

1. **Default to `--resume` over `--continue`**: Store session ID in block metadata (`[session::abc123]`). Drill-down children use `--resume <parent-session-id>`.

2. **Session ID in block metadata**: When agent route completes, write `[session::abc123]` marker to block content (after the prompt). This makes sessions searchable via Tantivy.

3. **CLAUDE.md as canonical schema**: Already updated (24 components). AGENT_SYSTEM_PROMPT becomes minimal — just context injection, not schema.

4. **`--json-schema` enforcement**: Pass the json-render spec schema to claude CLI for structural validation.

5. **`--fork-session`** for "explore alternative": When creating a branch drill-down (not continuing the main path), use `--resume <id> --fork-session`.

### Files to modify

| File | Change |
|------|--------|
| `doors/render/render.tsx` | Agent route: default `--resume`, `--json-schema`, minimal system prompt |
| `doors/render/door.json` | No change |
| `~/.floatty/doors/render/agent/CLAUDE.md` | Already updated (done in spike) |

### Drill-down flow

```
render:: agent summarize daily notes
  [session::abc12345]
  → renders summary, footer shows "session: abc12345"
  → user clicks "March 24" in rendered view
  → chirp('upsert-child', {
      content: 'render:: agent --resume abc12345 show March 24 detail',
      match: { contentPrefix: 'render:: agent --resume abc12345 show March 24' },
      execute: true, navigate: true
    })
  → child block created, auto-executes, agent has full context from parent session
```

### Tests

- Manual: `render:: agent test` → check `agentSessionId` in output
- Manual: `render:: agent --resume <id> follow up` → verify session continuity
- Manual: delete parent block, try `--resume` → verify graceful fallback

---

## Unit 4: Spec-as-Content (render:: stores JSON in block content)

### What exists (spike)

render:: is selfRender — output goes on the block via `setBlockOutput`. Content stays as the command text (`render:: agent foo`). The JSON spec lives in `block.output.data.spec`, NOT in `block.content`.

### What to change

After execution, append the JSON spec to block content (or store as a child block). This makes specs searchable via Tantivy.

**Option A**: Append spec to block content
```
render:: agent show daily summary
{"root":"layout","elements":{...}}
```
Content = command + spec. Tantivy indexes both. Raw/rich toggle shows either the JSON or the render.

**Option B**: Create child block with spec
```
render:: agent show daily summary
  └─ {"root":"layout","elements":{...}}   ← child block, content = spec JSON
```
Parent = command. Child = spec. Each independently searchable.

**Recommendation**: Option A (like tables — content IS the spec). Simpler, no extra blocks.

### Files to modify

| File | Change |
|------|--------|
| `doors/render/render.tsx` | After execute, update block content with command + spec JSON |
| `src/components/BlockItem.tsx` | Detect JSON spec in content, render via DoorHost below contentEditable |
| `src/lib/blockTypes.ts` | Add `render` block type detection (content starts with `render::` + has JSON) |

---

## Implementation Order

| # | Unit | Depends on | Estimate |
|---|------|-----------|----------|
| 1 | Chirp write verbs | nothing | Small — extend existing listener |
| 2 | Agent session threading | nothing | Small — mostly render.tsx changes |
| 3 | Deep link actions | Unit 1 (shared upsert logic) | Medium — App.tsx + Tauri scheme |
| 4 | Spec-as-content | nothing | Medium — content format + detection |

Units 1 and 2 can be done in parallel. Unit 3 depends on 1. Unit 4 is independent.

## Edge Cases (from adversarial review)

1. **Upsert race**: Two rapid clicks → atomic Y.Doc transaction with indexOf check
2. **Orphaned sessions**: `--resume` on dead session → fall back to new session
3. **Content-prefix fragility**: User edits block → match breaks. Use block ID when available
4. **Infinite drill-down**: Cap at 10 levels or require explicit Enter (not auto-execute)
5. **Chirp write scope**: Door can only create children of its own block
6. **Deep link injection**: `floatty://execute` routes through handler validation, not raw shell
7. **Stale renders**: Show "stale" indicator when outline data changed since last render
8. **Session bloat**: `--max-budget-usd` cap per agent call

## Spike Lessons (don't repeat these mistakes)

- **Tilde in double quotes doesn't expand** — use `$HOME` in shell commands
- **DOMPurify required on all innerHTML** — door components use innerHTML for markdown
- **ErrorBoundary on every DoorHost** — inline doors crash the entire reactive graph
- **CLAUDE.md must match AGENT_SYSTEM_PROMPT** — stale CLAUDE.md = agent loses components on `--resume`
- **corvu sizes are fractions (0-1)** — convert to px before persisting
- **viewRef can't be removed if still referenced** — grep before deleting declarations
- **Multi-line JSON needs `jq -c`** — digest door's line-split parser breaks on pretty-printed JSON
