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

Example: the claude-mem door shows a viewer iframe in the sidebar.

## Hot Reload

Doors auto-reload when their files change on disk. The file watcher detects modifications and re-imports without restarting floatty.

## Standard Library

Doors import shared utilities from `@floatty/stdlib` (the loader rewrites this to the host shim at runtime):
```js
import { exec, execJSON, addNewChildren, parseMarkdownToOps } from '@floatty/stdlib';
```

Key utilities:
- `exec(cmd)` / `execJSON(cmd)` — shell execution via Tauri
- `addNewChildren(parentId, ops, actions)` — create child blocks (deduplicates)
- `parseMarkdownToOps(md)` — markdown → block ops array
- `extractAllWikilinkTargets(str)` — parse `[[wikilinks]]` from content
- `findPagesContainer()` / `findPageBlock(name)` — outline navigation
- `pipe`, `sortByDesc`, `filterBy`, `take`, `groupBy` — FP utilities

## SolidJS Sharing

Doors share the host app's SolidJS runtime (signals, reactivity, rendering). The blob import pipeline rewrites bare `solid-js` imports to point at the host's modules. This means:
- Door signals integrate with the app's reactive graph
- No duplicate SolidJS instances (which would break reactivity)
- Doors can use `createSignal`, `Show`, `For`, etc. normally

## Existing Doors

### View Doors (prefix trigger + persistent UI)

| Door | Prefix | What it does |
|---|---|---|
| `daily` | `daily::` | Daily notes viewer/navigator with date picker |
| `dailylog` | `dailylog::` | Structured daily log with timelog entries |
| `digest` | `digest::` | Browse session digests from `~/.float/digests/` |
| `manifest` | `mem::` | Claude memory viewer (sidebar iframe) |
| `portless` | `portless::` | Resolve `.localhost` subdomains to direct IP:PORT |
| `rangle-dash` | `rd::` | Live rangle-weekly context, PRs, meeting summaries |
| `reader` | `read::` | Render pages by name (wikilink resolver) |
| `render` | `render::` | JSON Render — browse BBS entries, render specs inline |
| `session-garden` | `garden::` | Session/project tree visualization |
| `stub` | `stub::` | Minimal test door for pipeline verification |
| `timestamp` | `ts::`, `timestamp::` | Format timestamps (ISO, Unix, date, time) |

### Exec Doors (headless — mutate blocks, no persistent view)

| Door | Prefix | What it does |
|---|---|---|
| `extractTo` | `extractto::`, `extract::` | Extract block subtree to a new page |
| `floatctl` | `floatctl::` | CLI-in-outline — BBS board ops, schema introspection |

## Creating a New Door

1. Write source as `.tsx` in `doors/<id>/<id>.tsx`
2. Write `door.json` with id, prefixes, name
3. Compile: `node scripts/compile-door.mjs doors/<id>/<id>.tsx ~/.floatty-dev/doors/<id>/index.js`
4. Copy `door.json` to `~/.floatty-dev/doors/<id>/`
5. Door hot-reloads automatically (~1s)

The compile pipeline: esbuild (TypeScript → JS, preserves JSX) → babel-preset-solid (JSX → DOM template calls). Bare specifiers (`solid-js`, `@floatty/stdlib`) are rewritten by the loader at runtime.

To deploy to release: copy both `door.json` and `index.js` to `~/.floatty/doors/<id>/`.

See `help:: handlers` for the handler registration system that doors plug into.
