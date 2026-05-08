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

## Live re-render: child blocks as config

A render block's child blocks can be `prefix:: value` configurations
that the door reads at execute time and merges into `spec.state`. The
door subscribes to block changes (`subscribeBlockChanges`) so that
adding, removing, or PATCH-editing a child block triggers an automatic
re-projection.

```text
- render:: {"root":"r","state":{"bpm":120},"elements":{
    "r":{"type":"AcidBass","props":{
      "bpm":{"$state":"/bpm"},
      "cutoff":{"$state":"/cutoff"}
    }}}}
  ↳ bpm:: 130        ← override default
  ↳ cutoff:: 850     ← override default
```

Result: `spec.state` becomes `{ bpm: 130, cutoff: 850 }`. Edit any
child's content (PATCH `/blocks/<childId>`) → parent re-projects.

The full chain (verified end-to-end via Tauri MCP 2026-04-29 ~04:13):

1. Server applies the child write/update with origin `'remote'`
2. Local Y.Doc observer fires (slim path, FLO-320)
3. Slim path tracks the change (parent's `childIds` for adds, child's
   `content` for updates) — see `useBlockStore.ts` for both event
   shapes (path-1 YMapEvent vs path-deeper)
4. Slim path emits a `block:create` or `block:update` envelope to
   `blockEventBus` (gated by a small-batch threshold so initial-sync
   bulk reconnects keep skipping)
5. Door's `subscribeBlockChanges({ fields: ['childIds', 'content',
   'parentId'] })` callback fires
6. `buildAndSetOutput` re-reads children, parses `key:: value`,
   merges via `applyChildConfig`, writes new output envelope

Same `subscribeBlockChanges` primitive `kanban`/`expand` already use —
no new mechanism. This is the pattern the user pointed at when they
said "use the fucking architecture": three small fixes (consumer in
the door, producer in the slim path, field-tracking for the YMapEvent
shape) connecting an existing primitive end-to-end.

Reserved prefixes (render::, ctx::, sh::, ai::, chat::, dispatch::,
daily::, echocopy::, sync::, pages::) are skipped by the child-config
reader so they retain their own outline meaning.

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

---

# Follow-up — 2026-05-08: Projection contract + steady-state degradation

> Read after the body above. The 2026-04-29 fix above made
> agent-created `render:: {json}` blocks **render** correctly on
> arrival. This follow-up makes them **stay rendered** under load
> and gives agents a cleaner write shape that doesn't conflate
> semantic source with materialised projection.

## The symptom this fixes

Agent-created render:: blocks rendered fine when first written, then
**randomly fell back to showing raw JSON** during normal app use —
specifically after reconnects, sleep/wake, tab refocus, or any
Y.Doc state-vector sync. The selfRender contract leaves the
contentEditable visible underneath the door view, so when the door
view briefly remounts, the user sees a wall of raw JSON bleed through.

## Five root causes (all fixed in this PR)

### 1. Fat-path auto-execute had no output-presence guard

The slim path at `useBlockStore.ts:551-556` got the output guard in
the 2026-04-29 fix above. The **fat-path observer** (the inline
`if (_autoExecuteHandler) { ... }` block at lines 664-677, in the
top-level YMapEvent branch) did NOT have the same guard. Reconnect /
state-vector sync / gap-fill produces `'add'` events for already-
projected blocks; without the guard, every sync re-fired
`door.execute()` which wrote output twice (sync + async title-gen)
and remounted the rendered view. **Mirror of the slim-path guard
added.**

### 2. `setBlockOutput` had no idempotency check

`useBlockStore.ts::setBlockOutput` wrote `output + outputType +
outputStatus + updatedAt` in every transaction unconditionally.
Same-data writes still produced new envelope object references,
which caused Solid's `<Dynamic>` in `DoorHost.tsx:65` to
unmount/remount the door view. Combined with `setOutputWithTitle`
writing twice per execute (sync without title, then async with
LLM-generated title ~1s later), this produced visible flicker
even on legitimate single auto-executes.

**Fix**: deep-equality skip via `JSON.stringify` before the
transaction. yjs empty-transactions emit no events
(`ydoc-patterns.md` rule 14), so the skip is clean. Door envelopes
are JSON-serialisable by construction — no Dates, no Maps, no
cycles — `JSON.stringify` deep-equal is appropriate.

### 3. API didn't accept `output` on POST/PATCH

`CreateBlockRequest` and `UpdateBlockRequest` were
`deny_unknown_fields` and accepted ONLY content / parentId / etc.
Agents had **no way** to write the projection envelope directly —
their only lever was `content`. Combined with `isAutoExecutable
('render::')`, the only path agents could take was
`content: "render:: {full JSON}"` which lands the spec inside
contentEditable.

**Fix**: add `output: Option<serde_json::Value>` + `output_type:
Option<String>` + `output_status: Option<String>` to both request
structs. Pre-flight validates `output requires outputType` (with
PATCH allowing existing block's outputType to satisfy). New
`json_value_to_yrs_any` helper in `api/mod.rs` converts the
serde value to the yrs storage format the existing
`yrs_out_to_json` read path already handles.

### 4. MCP `add_block` / `patch_block` didn't forward output

Even with the API extended, the MCP tool layer
(`apps/outline-explorer/src/mcp/tools.ts`) only forwarded content /
parentId / afterId. **Fix**: add `output` / `outputType` /
`outputStatus` parameters to both tools, with cross-check
validation (outputType required when output set) at the MCP
boundary so agents get a clear error instead of opaque server
rejection.

### 5. Render-door agent system prompt had no projection guidance

`render::agent` runs `claude -p --dangerously-skip-permissions`,
which means the spawned agent has FULL tool access (MCP, shell,
filesystem). When asked "make a few logical blocks for each
section" the agent reasonably reached for `add_block` (or curl)
and naturally wrote `render:: {full JSON}` because that's the
simplest content prefix that auto-executes. The system prompt
gave no guidance about the projection contract.

**Fix**: extend `buildAgentSystemPrompt` in
`packages/render-door/src/agent-schema.ts` with explicit guidance:
default to ONE composed spec via Stack/Group/Tabs containers; if
the user explicitly asks for separate blocks, use the
projection-contract POST shape (content=title, output=envelope,
outputType="door"); never write `content: "render:: {json}"`.

## The projection contract

**`content` is semantic source.** What the user (or agent) MEANT,
in human-readable form. It's what the contentEditable shows when
the door view is gone (briefly during remount, or permanently if
the user toggles "view raw" / hits an error).

**`output.data` is the materialized projection.** Computed from
content (or supplied by the agent), renderable, regenerable,
non-destructive. It's what the door view shows.

For user-typed `render:: agent <prompt>`:
- `content` = the prompt text (semantic, ≤80 chars, scannable)
- `output.data.spec` = the generated spec
- ContentEditable shows the prompt, door view shows the rendered spec

For agent-written render blocks (the multi-block split case):
- `content` = a semantic section title
- `output.data.spec` = that section's spec
- Same shape as user-typed; same clean visual layering

**Anti-pattern**: writing `content: "render:: {full JSON}"`. Both
layers carry the same information; toggling "show raw" or hitting
a remount window dumps JSON-on-JSON onto the user.

## Wire format

POST `/api/v1/blocks` with projection-contract shape:

```json
{
  "content": "Real Bugs Quartet — Test-First Territory",
  "outputType": "door",
  "output": {
    "kind": "view",
    "doorId": "render",
    "schema": 1,
    "data": {
      "spec": { "root": "...", "elements": {...} },
      "title": "Real Bugs Quartet — Test-First Territory",
      "generatedVia": "agent"
    }
  },
  "outputStatus": "complete",
  "afterId": "<previous sibling block id>"
}
```

PATCH `/api/v1/blocks/<id>` accepts the same fields. Per-field PATCH
is allowed: e.g. `{"output": <new envelope>}` to refresh the
projection without touching content. Pre-flight requires
`outputType` whenever `output` is set, except on PATCH when the
block already has an `outputType` (avoids forcing callers to
re-state what hasn't changed).

## Verification

```bash
KEY=$(grep '^api_key' ~/.floatty-dev/config.toml | cut -d'"' -f2)
PORT=$(grep '^server_port' ~/.floatty-dev/config.toml | cut -d= -f2 | tr -d ' ')

# Write a clean render block via projection contract
curl -s -X POST -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "content": "Test Section",
    "outputType": "door",
    "output": {
      "kind": "view", "doorId": "render", "schema": 1,
      "data": {
        "spec": { "root": "r", "elements": { "r": { "type": "Text", "props": { "content": "hello" } } } },
        "title": "Test Section"
      }
    }
  }' \
  "http://127.0.0.1:$PORT/api/v1/blocks" | jq '.id, .outputType'
```

Expected: returns the new block's id and `outputType: "door"`.
ContentEditable in the outline shows "Test Section". Door view
shows "hello". Toggling raw on the door shows the spec JSON.
ContentEditable stays clean throughout.

## Files involved (this follow-up)

| File | What |
|------|------|
| `apps/floatty/src/hooks/useBlockStore.ts` | Fat-path auto-execute guard + setBlockOutput idempotency |
| `apps/floatty/src-tauri/floatty-server/src/api/blocks.rs` | output / outputType / outputStatus on Create + Update |
| `apps/floatty/src-tauri/floatty-server/src/block_service.rs` | Write output to Y.Doc; pre-flight validation; authoritative DTO returns |
| `apps/floatty/src-tauri/floatty-server/src/api/mod.rs` | `json_value_to_yrs_any` converter; 4 new contract tests |
| `apps/outline-explorer/src/mcp/tools.ts` | `add_block` / `patch_block` forward output fields |
| `packages/render-door/src/agent-schema.ts` | System prompt projection-contract guidance |

## What's deliberately NOT in this PR

- **Source-hash gate on output writes** — would let `setBlockOutput`
  also skip when the *content+children* hash matches a stored
  `output.sourceHash`. Catches re-execute on stale closures
  (`useContentSync` blur/remote race). Defer until we see the
  symptom post-this-PR.
- **Scoped `subscribeBlockChanges`** — the door subscribe currently
  fans out to every block's content change. Add `scope: { blockId,
  includeDescendants }` option so a render block only re-fires for
  its own subtree. Defer; the idempotency gate above defangs the
  fan-out's worst symptom.
- **Decoupling LLM title-gen from the output write** — title-gen
  could be a separate hook on `output.data.spec` arrival. Defer;
  the idempotency gate makes the second write a no-op when the
  title turns out to be similar.
- **Selfrender contentEditable+door visual layering** — the
  cohabitation pattern ("contentEditable above, door view below")
  is what made the fall-back-to-JSON visible. Eliminating it (e.g.,
  contentEditable only when in "edit source" mode) is a UX call,
  not an architecture fix. Defer to a UX review.

These are all real follow-ups; file as Linear tickets if/when the
symptoms persist post-this-PR.
