# Agent-created door blocks — auto-execute lifecycle

> Foundational. Read this before touching the chirp `create-child` /
> `upsert-child` path, or before building agent integrations that emit
> handler-prefixed blocks (`render::`, `sh::`, `ai::`, `daily::`, etc.).

## The asymmetry this fixes

Two ways a `render:: { json }` block gets created:

1. **User-typed**: user types `render:: …` into a block, hits Enter.
   `useBlockInput.execute_block` flushes content, looks up the handler in
   `registry.findHandler`, calls `executeHandler(handler, blockId, content,
   actions, hookStore)`. The handler runs, writes a structured envelope to
   `block.output` (with `outputType: 'door'`), the door view renders, and
   the search-projection layer indexes the rendered output (not the raw
   JSON spec) — see `metadata.renderedMarkdown` in the
   `block_service::compute_ancestor_context` projection chain.

2. **Agent-emitted via chirp** (the `createChild` / `upsertChild` action in
   `bbsCatalog`): an active `render::` block's spec calls
   `actions.createChild({ content: "render:: {json}" })`. The chirp event
   bubbles up to `BlockOutputView` / `DoorPaneView`, which call
   `handleChirpWrite('create-child', ...)`. The chirp handler creates the
   block and sets its content. **Until 2026-04-29 it stopped there.**

The pre-fix bug: agent-emitted blocks sat with raw `render:: {json}` text
in `block.content` indefinitely. No `outputStatus`, no `output`, no
`outputType: 'door'` envelope. The search-projection layer indexed the
RAW JSON SPEC text — exactly the failure mode the user flagged ("it should
work very similar to user-initiated ones, like auto-execute, not have the
flash of JSON"). The user could un-stick the block by opening it and
pressing Enter, which routed through path #1.

## The fix (foundational)

After a successful chirp `create-child` or `upsert-child`, the
chirpWriteHandler now invokes an optional `executeBlockIfHandler(blockId)`
callback on its store. Wired implementations build this callback via
`useBlockExecution(getPaneId)`, which closes over the workspace store +
handler registry + executor and mirrors `useBlockInput.execute_block`'s
dispatch shape. The callback no-ops cleanly when the new block's content
doesn't match any handler prefix, so chirps that create plain-text
children (Q&A, breadcrumbs, etc.) don't accidentally re-execute anything.

The wire path:

```text
agent in render-door spec:
  { type: '...', actions: { onPress: { type: 'createChild',
                              params: { content: 'render:: {...}' }}}}
       ↓ (json-render dispatch)
  ActionProvider handler in render.tsx →
    props.onChirp('create-child', { content: ... })
       ↓ (chirp CustomEvent bubbles to host)
  BlockOutputView onChirp / DoorPaneView onChirp →
    handleChirpWrite('create-child', data, parentBlockId, chirpStore)
       ↓ (inside chirpWriteHandler)
  store.createBlockInside(parentBlockId)        // returns newId
  store.updateBlockContent(newId, content)       // sets render:: ...
  store.executeBlockIfHandler?.(newId)           // ← THE FIX
       ↓ (inside useBlockExecution)
  registry.findHandler(content)                  // → render-door handler
  executeHandler(handler, newId, content,        // SAME path as
                 executorActions, hookStore)     // useBlockInput.execute_block
       ↓ (inside render door door.execute)
  setBlockStatus(newId, 'running')
  parse JSON / call agent / project state
  setBlockOutput(newId, { kind:'view', doorId:'render', data:{spec,...} },
                 'door')
  setBlockStatus(newId, 'complete')
       ↓
  outputType === 'door' is now set; door view replaces raw JSON text;
  metadata.renderedMarkdown projection picks up rendered output instead
  of the raw spec for indexing.
```

## Files involved

| Layer            | File                                                       |
|------------------|------------------------------------------------------------|
| Chirp dispatch   | `apps/floatty/src/lib/chirpWriteHandler.ts`                |
| Execution hook   | `apps/floatty/src/hooks/useBlockExecution.ts`              |
| Inline call site | `apps/floatty/src/components/BlockOutputView.tsx`          |
| Pane call site   | `apps/floatty/src/components/views/DoorPaneView.tsx`       |
| Tests            | `apps/floatty/src/lib/chirpWriteHandler.test.ts`           |
| Door semantics   | `packages/render-door/src/render.tsx` (`door.execute`)     |

## Opt-out: `data.execute = false`

The chirp data payload accepts `execute: false` to skip auto-execute. Use
it when an agent wants to emit a draft block as plain text for the user to
edit before running. By default, omit the field — auto-execute is the
desired behavior in 99% of cases.

```jsonc
// Default — auto-executes:
{ "message": "create-child",
  "data": { "content": "render:: {...spec...}" } }

// Opt-out — block lands as text, user runs it manually:
{ "message": "create-child",
  "data": { "content": "render:: agent draft for review",
            "execute": false } }
```

## Verbs that DO and DON'T auto-execute

| Verb           | Auto-execute? | Why |
|----------------|---------------|-----|
| `create-child` | YES (default) | Agent-emitted handler block needs to render. |
| `upsert-child` | YES (default) | Re-emit with same content = re-run with current state. |
| `update-block` | NO            | Fires on every keystroke during kanban-card editing (FLO-587). Re-running on every keystroke would be a runaway loop. |
| `move-block`   | NO            | Move is structural; the block's content is unchanged. |

These are codified in the test file — if a future change accidentally
flips one of these, tests fail loudly.

## Failure modes (designed-out)

- **Block-creation fails** (`createBlockInside` returns falsy): chirp
  returns `{ success: false }` and never invokes `executeBlockIfHandler`.
- **Upsert fails** (`upsertChildByPrefix` returns null): same — no
  execute call.
- **Content has no handler prefix**: `useBlockExecution.executeBlock`
  calls `registry.findHandler(content)`, gets undefined, silent no-op.
- **Block already running** (`outputStatus === 'running'`):
  `executeBlock` skips re-trigger to prevent recursive cascades when an
  agent emits N rapid `upsert-child` calls.
- **Store wiring missing**: `executeBlockIfHandler` is optional on
  `ChirpWriteStore`. Legacy callers that haven't migrated still work
  (chirpWriteHandler uses `?.` to invoke). Test in
  `chirpWriteHandler.test.ts` covers this.

## What still doesn't work / future considerations

1. **Side-by-side same-block** — if an agent emits TWO chirp
   `update-block` events for the same block in rapid succession (rare in
   practice — kanban update is the only update-block emitter today), the
   second one stomps the first. This is pre-existing behavior, not changed
   by the fix.

2. **Cross-pane execution** — `useBlockExecution` uses the host pane's
   `paneId` for zoom-scope. If a render block is open in pane A AND chirp
   create-children spawn while the user is editing in pane B, execution
   uses pane A's paneId (correct — the spawning block's pane). Verify when
   adding multi-pane chirps.

3. **No status feedback to agent** — the chirp ack returns
   `{ success: true, blockId }` synchronously after content is set, BEFORE
   execution finishes. If an agent needs to know the new block reached
   `complete` status (e.g. to read its output), it needs a separate poke
   round-trip. Out of scope for this fix; flag for future work.

## Why this is foundational, not polish

Doors are the integration surface where AI-generated UI meets the outline.
The whole "spec → render → action → spec" loop assumes that agent-created
secondary blocks behave like user-created ones. Without this fix:

- Recursive renders (a render block whose spec emits `createChild` to
  spawn related render blocks) require the user to manually run each
  child. That's a UX wall.
- Search indexing of agent-emitted JSON specs pollutes Tantivy with
  long, low-signal JSON text instead of the rendered markdown
  projection.
- The `[hash::content::matches]` invariant of "block content tells you
  what the block IS" breaks down: `block.content === "render:: {json}"`
  but the block looks like raw text, not a render output.

The fix restores the invariant: every handler-prefixed block, regardless
of who created it, ends up as `outputType === 'door'` with a rendered
view, and the markdown projection pipes structured output to the search
index — not the raw JSON.

## Test fixture — paste-and-verify

This is a self-contained `render::` block that creates a button which
emits a `createChild` action carrying a child render:: spec. Paste the
content (one line) into a fresh outline block, hit Enter, click the button.

**Expected behavior** (post-fix):

1. The parent block renders a green "Spawn child render" button.
2. Click → a child block is created beneath the parent.
3. The child block's content reads `render:: {...}`.
4. The child block AUTO-EXECUTES — within milliseconds the JSON text
   disappears and the child renders the spec (a simple Card with text).
   No JSON flash. No manual Enter required.

**Pre-fix behavior** (for contrast):

1. Same button, same click.
2. Child block created with `render:: {...}` content.
3. JSON text stays visible. Child does NOT execute. User must open the
   child and press Enter manually.
4. Tantivy indexes the raw JSON text (until the user runs it).

### The fixture

Copy this whole line as the content of a `render::` block in floatty:

```text
render:: {"root":"main","elements":{"main":{"type":"Stack","props":{"direction":"vertical","gap":12},"children":["title","desc","button"]},"title":{"type":"Text","props":{"content":"Auto-execute test (FLO render::)","size":"lg","weight":"bold","color":"#00e5ff"}},"desc":{"type":"Text","props":{"content":"Click below — the child render block should auto-execute, no JSON flash."}},"button":{"type":"Button","props":{"label":"Spawn child render","variant":"primary"},"actions":{"onPress":{"type":"createChild","params":{"content":"render:: {\"root\":\"x\",\"elements\":{\"x\":{\"type\":\"Card\",\"props\":{\"title\":\"Child rendered ✓\",\"subtitle\":\"auto-executed via chirp\"},\"children\":[\"y\"]},\"y\":{\"type\":\"Text\",\"props\":{\"content\":\"This card was created by the parent's createChild action and auto-executed without a manual Enter.\"}}}}"}}}}}}
```

### Manual verification recipe

1. Build floatty (the fix is in the host, not the door bundle):
   `cd apps/floatty && bash scripts/rebuild.sh` — or hot-reload via
   `pnpm --filter float-pty tauri:dev`.
2. Open floatty (port 8765 release / 33333 dev).
3. New block, paste the fixture content above, hit Enter.
4. Parent renders the button.
5. Click the button.
6. **Pass condition**: the child block immediately shows a card with
   "Child rendered ✓". No raw JSON text visible.
7. **Fail condition** (regression): child block stays as raw `render:: …`
   text until you click it and press Enter.

### What it exercises

- ActionProvider in render.tsx routing `createChild` → `props.onChirp('create-child', ...)`.
- BlockOutputView's chirp listener catching it.
- handleChirpWrite create-child path running.
- ChirpWriteStore.executeBlockIfHandler invoked (if present).
- useBlockExecution.executeBlock → registry.findHandler('render::') →
  executeHandler → render-door door.execute → setBlockOutput.
- Door view replacing the JSON text.

If any link breaks, the test fails visibly.

## Provenance

- 2026-04-29 02:17 AM — user reports asymmetry with screenshots.
- 2026-04-29 — landed: `useBlockExecution`, chirp store extension,
  call-site plumbing, test coverage. This doc.
- See branch `feat/techno-fidget-magic` commit log for the diff.

User direction (preserved verbatim):

> *"when agents crete a block with `render:: { json }` that isnt the block
> i initiated from, the json appears at first until i hit enter, and then
> i think that json spec also gets index by tanvity or something - we had
> issues with it before"*

> *"when agents create secondary render blocks --- it should work very
> similar to user intiated ones, like auto-execute, not have the flash of
> JSON, etc"*

> *"this is a feature of doors/render doors that i have been wanting for
> awhile outside of this, and i thhink its a crucial piece t really
> unlocking their power and potential and would rate it as a high
> priority, foundational architecture, not nice to have optional polish"*
