# Doors — Plugin System

Doors are SolidJS components loaded from `.js` files at runtime. They extend floatty with new prefix handlers, sidebar panels, and custom views — without modifying the app.

## Where Doors Live

```text
~/.floatty-dev/doors/     (dev builds)
~/.floatty/doors/         (release builds)
```

Each door is a directory with at least:
```text
my-door/
  door.json     ← metadata (id, prefixes, name, sidebarEligible)
  index.js      ← compiled SolidJS component
```

## door.json

```json
{
  "id": "my-door",
  "prefixes": ["my::"],
  "name": "My Door",
  "version": "0.1.0",
  "sidebarEligible": true
}
```

- `id` — unique identifier
- `prefixes` — which `prefix::` triggers this door
- `name` — display name (shown in sidebar tab)
- `sidebarEligible` — if true, appears as a sidebar tab

## index.js Exports

```js
export const door = {
  kind: "view",           // "view" = has UI component, "exec" = headless
  prefixes: ["my::"],

  // Called when prefix:: block is executed
  async execute(blockId, content, ctx) {
    return { data: { /* passed to view */ } };
  },

  // SolidJS component (only for kind: "view")
  view: MyViewComponent,
};

export const meta = {
  id: "my-door",
  name: "My Door",
  version: "0.1.0",
  sidebarEligible: true,
  advanceCursorOnExecute: true,
};
```

## Door Kinds

### View Doors
Have both `execute` and `view`. The view component receives:
- `data` — return value from execute
- `settings` — from `[plugins.settings.my-door]` in config.toml
- `server` — server access (API URL, API key)

### Exec Doors
Headless — `execute` only, no UI component. Like `extractTo::` which runs and creates blocks.

## Config Integration

Door settings come from `config.toml`:
```toml
[plugins.settings.my-door]
url = "http://localhost:8080"
api_key = "..."
```

Accessible in execute as `ctx.settings` and in view as `props.settings`.

## Sidebar Doors

Doors with `sidebarEligible: true` appear as tabs in the sidebar (next to the ctx:: tab). The sidebar renders the door's view component directly — no prefix trigger needed.

## Hot Reload

Doors auto-reload when their files change on disk. The file watcher detects modifications and re-imports without restarting floatty.

## Standard Library

Doors have access to shared utilities through the stdlib shim:
```js
import { createFocusedChild, advanceToNextInput } from '@floatty/stdlib';
```

For long-running doors, prefer the declarative metadata flag when the desired behavior is simply "let the user keep typing in the next block while this executes":

```js
export const meta = {
  id: "my-door",
  name: "My Door",
  advanceCursorOnExecute: true,
};
```

For doors that need a custom continuation shape, use the stdlib helpers inside `execute` before awaiting slow work:

```js
async execute(blockId, content, ctx) {
  const draftId = createFocusedChild(ctx.actions, blockId, "");
  // user can type into draftId while async work continues
  const result = await ctx.server.fetch("/api/v1/example");
  return { data: await result.json() };
}
```

`advanceToNextInput(ctx.actions, blockId, { nextId })` focuses an existing next block when the caller has already resolved one, or creates a sibling after `blockId` when none is provided. These helpers are block/focus primitives only; AI workflows belong in user-land doors such as `render:: ai` or future agent doors, not in Floatty core.

## SolidJS Sharing

Doors share the host app's SolidJS runtime (signals, reactivity, rendering). The blob import pipeline rewrites bare `solid-js` imports to point at the host's modules. This means:
- Door signals integrate with the app's reactive graph
- No duplicate SolidJS instances (which would break reactivity)
- Doors can use `createSignal`, `Show`, `For`, etc. normally

## Existing Doors

| Door | Prefix | What it does |
|---|---|---|
| `daily` | `daily::` | Structured daily notes |
| `timestamp` | `timestamp::` | Render timestamps in multiple formats |
| `extractTo` | `extractTo::` | Extract block subtree to new location |

## Creating a New Door

1. Create directory: `~/.floatty-dev/doors/my-door/`
2. Write `door.json` with id, prefixes, name
3. Write `index.js` — compiled SolidJS (use the float-substrate toolchain or hand-write)
4. Door auto-loads on next floatty start (or hot-reloads if already running)

See `help:: handlers` for the handler registration system that doors plug into.
