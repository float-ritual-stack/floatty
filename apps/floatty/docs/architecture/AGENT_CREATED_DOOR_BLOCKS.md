# Agent-created door blocks — auto-execute lifecycle

> Foundational. Read this before touching the auto-execute path or before
> building agent integrations that emit handler-prefixed blocks
> (`render::`, `daily::`, etc.).
>
> **Architecture lesson preserved here**: an earlier (2026-04-29) attempt
> to fix this added a parallel auto-execute path inside chirpWriteHandler.
> That was the wrong shape — the canonical primitive already existed in
> useBlockStore. The fix collapsed back to extending the existing
> primitive. See "What we tried that didn't fit" below.

## TL;DR

Three things had to land for agent-created render:: blocks to behave
like user-typed ones:

1. **Allowlist `render::`** in `isAutoExecutable` (`useBlockStore.ts`).
   Previously only `daily::` was permitted.
2. **Run auto-execute in the slim path** for steady-state remote adds
   (single-block API writes, not bulk-sync 13k-block reconnects).
   Previously the slim path skipped auto-execute entirely.
3. **Output-presence guard** so initial reconnect of already-executed
   blocks doesn't re-fire the handler.

The actual change is ~50 lines added to one file. Plus a one-line
allowlist addition.

## The asymmetry this fixes

Two ways a `render:: { json }` block gets created:

1. **User-typed**: user types `render:: …`, hits Enter.
   `useBlockInput.execute_block` → `executeHandler` → output written.
   (Frontend-only, in-process, never hits the slim path.)

2. **Agent-emitted via REST API** (or via render door's `createChild`
   action that ends up writing to the server): the agent does
   `POST /api/v1/blocks` with `content: "render:: {json}"`. Server
   writes to Y.Doc. WebSocket pushes the diff to the frontend with
   origin `'remote'`. The frontend's `_blocksObserver` fires.

Pre-fix path (2) terminated as raw text in the block: the slim path
in `useBlockStore` (FLO-320) explicitly skipped auto-execute to keep
startup fast. Until the user opened the block and pressed Enter, the
JSON sat there — and the search projection layer indexed the raw JSON
spec instead of the rendered output.

## The canonical primitive

`apps/floatty/src/hooks/useBlockStore.ts`:

```ts
let _autoExecuteHandler: AutoExecuteHandler | null = null;

export function setAutoExecuteHandler(handler) { _autoExecuteHandler = handler; }
export function isAutoExecutable(content): boolean { /* allowlist */ }
```

`apps/floatty/src/context/WorkspaceContext.tsx` registers the handler
on mount. The handler closes over `executeHandler` + `registry` +
the workspace's blockStore + a hook block store.

When a Y.Doc transaction adds a new block, the observer:

- **Normal path** (origin = User / Executor / Hook / Api):
  if `isAutoExecutable(content)` and `_autoExecuteHandler` is set,
  calls the handler. This catches user-create-with-content and
  in-process API writes that round-trip back through the local doc.

- **Slim path** (origin = Remote / ReconnectAuthority / BulkImport):
  this is the FLO-320 fast lane. As of the fix:
  - For `Remote` and `ReconnectAuthority` origins, the slim path now
    also runs auto-execute, gated by `isAutoExecutable(content)` AND
    no existing output envelope on the block (output guard).
  - For `BulkImport` origin (rare; used for batch local creates),
    auto-execute stays off — bulk imports come from intentional
    bulk operations.

## Why the output-presence guard is sufficient

Initial reconnect can replay thousands of blocks via Remote /
ReconnectAuthority origin. If `render::` blocks executed previously,
they carry their output envelope in Y.Doc. On reconnect, the block
arrives with `outputType: 'door'` and `output: {...}` already populated.
The guard short-circuits → no re-execute storm.

When a NEW render:: block is created via API (steady state), it has
no output yet. Guard passes → handler runs → output written → next
reconnect skips (output now present).

No event-count threshold needed. The guard does the work cleanly.

### Error-state handling (CodeRabbit P1.3 #292)

The guard treats `outputType: 'error'` (with or without an `output`
envelope) as "already executed" — it short-circuits, so a previously-
errored render block does NOT auto-retry on remote sync. This is the
intended semantics: don't loop on broken specs. The user can clear
the error envelope manually (Cmd+Backspace clears block output in
floatty) and re-run via Enter, or update the content and re-execute.

If a future need for "retry-on-reconnect" emerges, the guard would
become `(outputType === 'door' || (output && outputType !== 'error'))`
or similar — but the current behavior matches user expectation that
errors don't silently re-fire.

## Allowlist policy

`isAutoExecutable` permits *idempotent view-only* handlers only. A
locked-in test (`isAutoExecutable.test.ts`) enforces:

- ✅ `daily::` — historical
- ✅ `render::` — added 2026-04-29
- ❌ `sh::` — runs shell
- ❌ `ai::` — costs API tokens
- ❌ `term::` / `chat::` / `dispatch::` — side effects

`render::`'s sub-routes (`agent`, `ai`, `kanban`, `expand`, `prompt`,
raw-JSON, `demo`, `stats`) are gated *inside* the door's `execute()`
function. The auto-execute path only triggers door.execute(); the
door is responsible for refusing destructive sub-routes (e.g. `agent`
requires `--dangerously-skip-permissions` which is gated by user
intent / settings).

## What we tried that didn't fit

A first-pass fix added an `executeBlockIfHandler` callback to
`ChirpWriteStore` and a new `useBlockExecution` hook. It made chirp
`create-child` and `upsert-child` invoke `executeHandler` after the
block was created.

**Why it was wrong**:

- Parallel path. The `_autoExecuteHandler` primitive was already
  wired in `WorkspaceContext.tsx` for exactly this purpose, just
  missing the `render::` allowlist entry.
- It only covered chirp. Blocks created via REST API (the actual case
  in the user's screenshot) bypass chirp entirely. Adding chirp logic
  didn't unblock them.
- The auto-execute primitive's slim-path skip was the actual blocker
  for API-created blocks. That's the one place to fix it; doing so
  makes both API and chirp paths correct without parallel paths.

The lesson: when adding a new mechanism, grep for the existing
primitive first. If the primitive exists but doesn't cover your case,
extend the primitive. Don't add a sibling.

(Reference: `~/.claude/rules/symmetry-check.md` and the user's
direction `"if it already exists, leverage it -> if we need to refactor it,
thats fine ... we have lots of 'well intentioned, well designed
architecture' that keeps going under leveraged"`.)

## Verbs that do and don't auto-execute

This applies *within* the chirp protocol too — chirp create-child /
upsert-child WRITE to Y.Doc, then the observer's auto-execute path
fires for any handler-prefixed content with no existing output.

| Verb           | Triggers auto-execute? | Why |
|----------------|------------------------|-----|
| `create-child` (chirp) | YES | Single-block addition. |
| `upsert-child` (chirp) | YES if it created a new child | Existing-match upserts don't fire add events. |
| `update-block` (chirp) | NO  | Fires on every keystroke during kanban-card editing (FLO-587). Only block:add triggers auto-execute, not block:update. |
| `move-block` (chirp)   | NO  | Structural; content unchanged. |
| `POST /api/v1/blocks`  | YES | Slim-path Remote origin auto-execute (added 2026-04-29). |

## Verification recipe

Live verification against running floatty (port 8765 release / 33333 dev):

```javascript
// In Tauri webview console:
const apiKey = window.__FLOATTY_API_KEY__;
const headers = { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' };

// Create a render:: block via API
const spec = { root: 'm', elements: { m: { type: 'Stack', children: ['t'] }, t: { type: 'Text', props: { content: 'auto-execute test' } } } };
const r = await fetch('http://127.0.0.1:8765/api/v1/blocks', {
  method: 'POST', headers,
  body: JSON.stringify({ content: `render:: ${JSON.stringify(spec)}`, parentId: '<some-existing-block-id>' }),
});
const { id } = await r.json();
await new Promise(r => setTimeout(r, 1500));

// Check output landed
const block = await (await fetch(`http://127.0.0.1:8765/api/v1/blocks/${id}`, { headers })).json();
console.log({ outputType: block.outputType, hasOutput: !!block.output });
// Expected: outputType: 'door', hasOutput: true
```

Pre-fix: `outputType: undefined, hasOutput: false`.
Post-fix: `outputType: 'door', hasOutput: true`.

## Files involved

| File | What |
|------|------|
| `apps/floatty/src/hooks/useBlockStore.ts` | Allowlist + slim-path auto-execute |
| `apps/floatty/src/context/WorkspaceContext.tsx` | Handler registration (pre-existing) |
| `apps/floatty/src/lib/handlers/executor.ts` | `executeHandler` (pre-existing) |
| `apps/floatty/src/hooks/isAutoExecutable.test.ts` | Allowlist contract tests |

## Provenance

- Diagnosis: chirp-path attempt failed live-verification. Tauri MCP
  + a programmatic `POST /api/v1/blocks` showed the slim path was
  the actual blocker (block had `hasOutput: false` after the chirp
  fix shipped).
- Fix: revert the chirp-path attempt; allowlist `render::`; extend
  slim path to invoke auto-execute on Remote / ReconnectAuthority
  adds with output-presence guard.
- User direction (preserved verbatim because it shaped the fix):
  > *"if it already exists, leverage it -> if we need to refactor it,
  > thats fine ... we have lots of 'well intentioned, well designed
  > architecture' that keeps going under leveraged because agents reach
  > for solving local instea of reading 5 lines above them"*
