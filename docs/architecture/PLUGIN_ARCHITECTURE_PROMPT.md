# BBS Doors for Floatty — Agent Prompt

> If a door can't handle a daily note, the door system has failed.

---

## Role

System Architect & Senior Tauri v2 Engineer. You specialize in the "Forty Year Pattern" (Event → Handler → Transform → Project) and secure plugin runtimes within a Rust/SolidJS stack. You know what a BBS door is — a self-contained program that gets a terminal and paints on it.

## Objective

Extend floatty's existing `HandlerRegistry` to support **doors**: `.tsx` files that users drop into `{FLOATTY_DATA_DIR}/plugins/doors/`. A door exports an `execute()` function (logic) and a SolidJS **component** (view). The host mounts door views via a component registry and `<Dynamic>` — the SolidJS equivalent of Vue's `<component :is>`. The daily note is the first door.

---

## 1. What a Door Is

A BBS door gets three things from the host:
1. **A trigger** — prefix match routes execution to this door
2. **A context** — sandboxed API for block CRUD, file I/O, fetch, invoke
3. **A view** — SolidJS component mounted via `<Dynamic>` into the output block

A door IS a SolidJS component. It writes JSX. The Rust side compiles `.tsx` → `.js` via `swc` with `swc-plugin-jsx-dom-expressions` (the same transform `vite-plugin-solid` uses). The compiled output is Blob-imported and mounted via `<Dynamic>`. Doors get the full power of SolidJS reactivity — `createSignal`, `<For>`, `<Show>`, `createEffect` — because they're real compiled components.

### Door Interface

```typescript
import type { Component } from 'solid-js';

export interface Door<T = unknown> {
  /** Prefixes that trigger this door (e.g., ['daily::']). For routing only. */
  prefixes: string[];

  /** Execute logic: fetch data, read files, call APIs. Returns structured data for the view. */
  execute(
    blockId: string,
    content: string,
    ctx: DoorContext
  ): Promise<DoorResult<T>>;

  /** SolidJS component that renders the door's output */
  view: Component<DoorViewProps<T>>;
}

/** Door identity comes from meta.id — stable, independent of prefixes.
 *  prefixes are for routing only and may be reordered/aliased. */

export interface DoorResult<T = unknown> {
  /** Structured data passed to the view component */
  data: T;
  /** Optional error message */
  error?: string;
}

/** Canonical output envelope — what gets written to Y.Doc via setBlockOutput().
 *  Single shape for all doors. DoorHost reads this, not raw output. */
export type DoorOutput = {
  kind: 'door';        // Discriminant — distinguishes from legacy output types
  doorId: string;      // From meta.id (stable identity, not prefix)
  schema: 1;           // Version for forward compat
  data: JsonValue | null;
  error?: string;
};

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface DoorViewProps<T = unknown> {
  /** The data returned by execute() */
  data: T;
  /** Door-specific settings from config.toml */
  settings: Record<string, unknown>;
}

export interface DoorContext {
  /** Pre-authenticated localhost access to floatty-server REST API (Tier 1) */
  server: DoorServerAccess;
  /** Block CRUD convenience layer over REST (Tier 1) */
  actions: ScopedActions;
  /** Read/write files (scoped to declared directories) (Tier 2) */
  fs: ScopedFS;
  /** External HTTP fetch (scoped to declared domains) (Tier 2) */
  fetch: typeof fetch;
  /** Call Tauri commands (scoped to declared names) (Tier 2) */
  invoke: ScopedInvoke;
  /** Door-specific settings from config.toml (Tier 1) */
  settings: Record<string, unknown>;
  /** Current block ID and content (Tier 1) */
  blockId: string;
  content: string;
  doorId: string;
  /** Prefixed logger (Tier 1) */
  log: (...args: unknown[]) => void;
}

export interface DoorServerAccess {
  /** Server base URL (e.g., http://127.0.0.1:8765) */
  url: string;
  /** WebSocket URL (e.g., ws://127.0.0.1:8765/ws) */
  wsUrl: string;
  /** Pre-authenticated fetch — Bearer token injected automatically */
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
}
```

### Door Metadata (Required)

`meta.id` is the stable door identity. It's separate from prefixes (which are for routing
and may be aliased/reordered). The host uses `meta.id` to key the component registry,
output envelope, and config settings.

```typescript
export const meta = {
  /** Stable identifier — used as doorId in output, registry key, settings key.
   *  Convention: lowercase, no colons. Derived from filename if omitted. */
  id: 'daily',
  name: 'Daily Notes',
  description: 'Extract daily note data, render as timeline',
  version: '0.1.0',
  author: 'user',
  capabilities: {
    fs: ['~/Documents/Notes/Daily'],
    invoke: ['execute_daily_command'],
    fetch: ['wttr.in'],
  },
};
```

### Headless-First Principle

> Doors are headless-first. If a door needs a capability the REST API doesn't have, fix the API — don't add door-specific wrappers.

`ctx.server.fetch()` gives doors pre-authenticated access to the same REST API that CLI agents and Claude Code already use. `ScopedActions` is a convenience layer over REST, not the only data channel. A door that needs something the wrapper doesn't support just hits the API directly.

The door system becomes a forcing function for API completeness. Every gap a door finds is a gap CLI agents also have.

---

## 2. The Daily Door (First Implementation)

This is the validation target. If this works, the system works.

```tsx
// {FLOATTY_DATA_DIR}/plugins/doors/daily.tsx

import { For, Show } from 'solid-js';
import type { Door, DoorViewProps } from 'floatty/doors';

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

interface TimelogEntry {
  time: string;
  summary: string;
  project?: string;
  mode?: string;
  issue?: string;
  meeting?: string;
  details: string[];
  phases: string[];
  prs: Array<{ num: number; status: string }>;
}

// NOTE: When the door builds DailyData itself (headless-first via REST),
// it owns the shape. The old DailyNoteData from Rust used snake_case
// (day_of_week, timelogs, scattered_thoughts). Doors define their own types.
interface DailyData {
  date: string;
  dayOfWeek: string;
  entries: TimelogEntry[];
  notes: Array<{ title: string; content: string }>;
  stats: { sessions: number; hours: string; prs: number };
}

// ═══════════════════════════════════════════════════════════════
// EXECUTE
// ═══════════════════════════════════════════════════════════════

function resolveDate(arg: string): string {
  if (!arg || arg === 'today') return new Date().toISOString().slice(0, 10);
  if (arg === 'yesterday') {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
  }
  return arg;
}

// ═══════════════════════════════════════════════════════════════
// VIEW COMPONENT (SolidJS — compiled by swc at load time)
// ═══════════════════════════════════════════════════════════════

function TimelineEntry(props: { entry: TimelogEntry }) {
  const type = () => {
    if (props.entry.meeting) return 'meeting';
    if (props.entry.mode === 'spike') return 'spike';
    if (props.entry.prs?.some(p => p.status === 'merged')) return 'shipped';
    return '';
  };

  return (
    <div class={`door-daily-entry ${type()}`}>
      <div class="door-entry-head">
        <span class="door-time">{props.entry.time}</span>
        <div class="door-tags">
          <Show when={props.entry.project}>
            <span class="door-tag project">{props.entry.project}</span>
          </Show>
          <Show when={props.entry.mode}>
            <span class="door-tag mode">{props.entry.mode}</span>
          </Show>
          <Show when={props.entry.issue}>
            <span class="door-tag issue">{props.entry.issue}</span>
          </Show>
        </div>
      </div>
      <div class="door-summary">{props.entry.summary}</div>
      <Show when={props.entry.details?.length > 0}>
        <details open>
          <summary>Details ({props.entry.details.length})</summary>
          <ul class="door-list">
            <For each={props.entry.details}>
              {(detail) => <li>{detail}</li>}
            </For>
          </ul>
        </details>
      </Show>
      <Show when={props.entry.prs?.length > 0}>
        <div class="door-chips">
          <For each={props.entry.prs}>
            {(pr) => <span class={`door-chip pr ${pr.status}`}>#{pr.num}</span>}
          </For>
        </div>
      </Show>
    </div>
  );
}

function DailyView(props: DoorViewProps<DailyData>) {
  const stats = () => props.data.stats || { sessions: 0, hours: '—', prs: 0 };

  return (
    <div class="door-daily">
      <div class="door-daily-header">
        <div class="door-daily-date">{props.data.date}</div>
        <div class="door-daily-meta">
          <Show when={props.data.dayOfWeek}>
            <span class="door-pill">{props.data.dayOfWeek}</span>
          </Show>
          <span class="door-pill">{props.data.entries.length} entries</span>
        </div>
        <div class="door-daily-stats">
          <div class="door-stat"><strong>{stats().sessions}</strong> sessions</div>
          <div class="door-stat"><strong>{stats().hours}</strong> time</div>
          <div class="door-stat"><strong>{stats().prs}</strong> PRs</div>
        </div>
      </div>
      <Show when={props.data.entries.length > 0}>
        <div class="door-timeline">
          <For each={props.data.entries}>
            {(entry) => <TimelineEntry entry={entry} />}
          </For>
        </div>
      </Show>
      <Show when={props.data.notes?.length > 0}>
        <div class="door-notes">
          <h3>Notes</h3>
          <For each={props.data.notes}>
            {(note) => (
              <div class="door-note-card">
                <h4>{note.title}</h4>
                <p>{note.content}</p>
              </div>
            )}
          </For>
        </div>
      </Show>
      <Show when={!props.data.entries.length && !props.data.notes?.length}>
        <div class="door-empty">No entries for {props.data.date}</div>
      </Show>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// DOOR EXPORT
// ═══════════════════════════════════════════════════════════════

export const door: Door<DailyData> = {
  prefixes: ['daily::'],

  async execute(blockId, content, ctx) {
    const dateArg = content.replace(/^daily::\s*/i, '').trim();
    const date = resolveDate(dateArg);
    ctx.log('Executing for date:', date);
    try {
      // Headless-first: query the same REST API CLI agents use
      const resp = await ctx.server.fetch('/api/v1/blocks');
      const { blocks } = await resp.json() as { blocks: Record<string, any>; rootIds: string[] };

      // Filter blocks by date (client-side — no date query endpoint yet)
      const dayStart = new Date(date).getTime();
      const dayEnd = dayStart + 86400000;
      const dayBlocks = Object.values(blocks).filter((b: any) =>
        b.createdAt >= dayStart && b.createdAt < dayEnd
      );

      // Build DailyData from block metadata
      const entries: TimelogEntry[] = dayBlocks
        .filter((b: any) => b.metadata?.markers?.some((m: any) => m.type === 'ctx'))
        .map((b: any) => ({
          time: new Date(b.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          summary: b.content?.slice(0, 120) || '',
          project: b.metadata?.markers?.find((m: any) => m.type === 'project')?.value,
          mode: b.metadata?.markers?.find((m: any) => m.type === 'mode')?.value,
          issue: b.metadata?.markers?.find((m: any) => m.type === 'issue')?.value,
          details: [], phases: [], prs: [],
        }));

      const data: DailyData = {
        date,
        dayOfWeek: new Date(date).toLocaleDateString([], { weekday: 'long' }),
        entries,
        notes: [],
        stats: { sessions: entries.length, hours: '—', prs: 0 },
      };
      return { data };
    } catch (err) {
      return { data: null as any, error: String(err) };
    }
  },

  view: DailyView,
};

export const meta = {
  id: 'daily',
  name: 'Daily Notes',
  version: '0.1.0',
  // No Tier 2 capabilities needed — uses ctx.server.fetch (Tier 1) only
};
```

### What This Proves

| Capability | How daily:: exercises it |
|-----------|--------------------------|
| SolidJS view component | `<For>`, `<Show>`, reactive props — real SolidJS, not vanilla DOM |
| Headless-first | `ctx.server.fetch('/api/v1/blocks')` — same API CLI agents use, no special commands |
| Typed data flow | `execute()` returns `DailyData`, view receives via `DoorViewProps<DailyData>` |
| Component registry | Host mounts via `<Dynamic component={door.view}>`, no hardcoded `<Show>` |
| Self-contained | Logic + view + types in one `.tsx` file |
| Zero Tier 2 deps | No `capabilities` needed — REST API is always available |

---

## 3. Rendering Architecture (Component Registry + `<Dynamic>`)

Currently `BlockItem.tsx` hardcodes view routing with nested `<Show>` guards
checking both `outputType` AND `outputStatus` (2 view types, 6+ branches):

```tsx
// CURRENT (actual code): nested <Show> guards per output type — doesn't scale
<Show when={block()?.outputType === 'daily-view' || block()?.outputType === 'daily-error'}>
  <Show when={block()?.outputStatus === 'running' || block()?.outputStatus === 'pending'}>
    {/* spinner */}
  </Show>
  <Show when={block()?.outputType === 'daily-view' && block()?.outputStatus === 'complete'}>
    <DailyView data={block()!.output as DailyNoteData} />
  </Show>
  <Show when={block()?.outputType === 'daily-error' && block()?.outputStatus !== 'running'}>
    <DailyErrorView error={...} />
  </Show>
</Show>
<Show when={block()?.outputType === 'search-results' || block()?.outputType === 'search-error'}>
  {/* Same triple-nesting pattern for search */}
</Show>
// Every new view type = 3+ branches in BlockItem.tsx. That's wrong.
```

### New: Component Registry + `<Dynamic>`

SolidJS provides `<Dynamic>` from `solid-js/web` — equivalent of Vue's `<component :is>`. Takes a component reference, mounts it reactively. When the reference changes, unmounts old, mounts new.

```tsx
import { Dynamic } from 'solid-js/web';

// One branch for ALL doors
<Show when={block()?.outputType === 'door-view' && block()?.outputStatus === 'complete'}>
  <Dynamic
    component={doorRegistry.getView(doorOutput()?.doorId)}
    data={doorOutput()?.data}
    settings={doorRegistry.getSettings(doorOutput()?.doorId)}
  />
</Show>
```

### Door Registry (`src/lib/handlers/doorRegistry.ts`)

Separate from `HandlerRegistry`. Maps door IDs to view components + settings.

```typescript
import type { Component } from 'solid-js';
import type { DoorViewProps } from './doorTypes';

class DoorRegistry {
  private doors = new Map<string, {
    view: Component<DoorViewProps>;
    settings: Record<string, unknown>;
  }>();

  register(doorId: string, view: Component<DoorViewProps>, settings: Record<string, unknown>) {
    this.doors.set(doorId, { view, settings });
  }

  getView(doorId: string): Component<DoorViewProps> | undefined {
    return this.doors.get(doorId)?.view;
  }

  getSettings(doorId: string): Record<string, unknown> {
    return this.doors.get(doorId)?.settings ?? {};
  }

  has(doorId: string): boolean { return this.doors.has(doorId); }
  clear(): void { this.doors.clear(); }
}

export const doorRegistry = new DoorRegistry();
```

### Host View Wrapper (`src/components/views/DoorHost.tsx`)

Wraps `<Dynamic>` with loading/error chrome. Door doesn't know about loading states.

```tsx
import { Show } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { doorRegistry } from '../../lib/handlers/doorRegistry';

interface DoorHostProps {
  doorId: string;
  data: unknown;
  error?: string;
  status?: string;
}

export function DoorHost(props: DoorHostProps) {
  const ViewComponent = () => doorRegistry.getView(props.doorId);

  return (
    <div class="door-output">
      <Show when={props.status === 'running'}>
        <div class="door-loading"><span class="door-spinner">◐</span> Loading...</div>
      </Show>
      <Show when={props.error && props.status !== 'running'}>
        <div class="door-error">{props.error}</div>
      </Show>
      <Show when={ViewComponent() && props.status === 'complete'}>
        <Dynamic
          component={ViewComponent()!}
          data={props.data}
          settings={doorRegistry.getSettings(props.doorId)}
        />
      </Show>
      <Show when={!ViewComponent() && props.status === 'complete'}>
        <div class="door-unknown">Unknown door: {props.doorId}</div>
      </Show>
    </div>
  );
}
```

### BlockItem.tsx Changes

```tsx
// BEFORE: N branches for N view types
<Show when={block()?.outputType === 'daily-view' || block()?.outputType === 'daily-error'}>
  <DailyView ... />
</Show>

// AFTER: one branch for all doors — route via output.kind discriminant
<Show when={(block()?.output as DoorOutput)?.kind === 'door'}>
  {(() => {
    const output = block()!.output as DoorOutput;
    return (
      <DoorHost
        doorId={output.doorId}
        data={output.data}
        error={output.error}
        status={block()?.outputStatus}
      />
    );
  })()}
</Show>
```

**Note**: The `kind: 'door'` discriminant replaces `outputType === 'door-view'`. We can keep `outputType` for backwards compat with legacy views during migration, but new code routes on `output.kind`.

---

## 4. Compilation Pipeline

### Why `.tsx`

Doors write SolidJS JSX. That JSX needs compilation — SolidJS uses `jsx-dom-expressions` to turn `<div>{signal()}</div>` into direct DOM creation calls with fine-grained subscriptions. Without compilation, JSX is syntax errors.

### swc with Solid Plugin (Rust Side) — EXPERIMENTAL until Phase 0C passes

```rust
// src-tauri/src/commands/plugins.rs
#[tauri::command]
pub async fn compile_door(source: String) -> Result<String, String> {
    // 1. Strip TypeScript types (swc built-in)
    // 2. Transform JSX via swc-plugin-jsx-dom-expressions
    // 3. Target: ES2022
}
```

**Transform configuration** (the exact settings that matter):
```json
{
  "generate": "dom",
  "hydratable": false,
  "delegateEvents": false,
  "wrapConditionals": true,
  "contextToCustomElements": false,
  "builtIns": ["For", "Show", "Switch", "Match", "Index", "Dynamic"],
  "moduleName": "solid-js/web"
}
```

Key settings:
- **`delegateEvents: false`** — Critical. Solid's event delegation attaches to `document`. Doors must NOT participate in host event delegation — prevents interference with outliner keyboard handling (tinykeys, BlockItem).
- **`generate: "dom"`** — Not SSR. Direct DOM creation calls.
- **`builtIns`** — Tells the transform which components are Solid primitives (not user components).
- **`moduleName: "solid-js/web"`** — Import target for generated runtime calls (`_$template`, `_$insert`, etc.). Must resolve via the import map.

**Sidecar fallback**: If `swc-plugin-jsx-dom-expressions` proves too brittle (WASM version coupling, plugin API breakage), the fallback is a Tauri sidecar running a minimal Vite/esbuild bundler. This adds a Node.js dependency at build time but keeps the compilation pipeline stable. The sidecar would be invoked via `Command::new_sidecar("floatty-door-compiler")` with the `.tsx` source on stdin, compiled JS on stdout.

### The Full Pipeline

```
 1. User drops daily.tsx into {data_dir}/plugins/doors/
 2. App startup: invoke('list_door_files') → ['daily.tsx']
 3. invoke('read_door_file', { name }) → .tsx source
 4. invoke('compile_door', { source }) → compiled JS
    └─ swc: strip TS + transform JSX → solid DOM calls
 5. new Blob([js], { type: 'application/javascript' })
 6. URL.createObjectURL(blob) → import(url)
 7. Validate: mod.door.prefixes, mod.door.execute, mod.door.view
 8. doorRegistry.register(doorId, mod.door.view, settings)
 9. registry.register(doorToBlockHandler(mod.door, ctx))
10. URL.revokeObjectURL(url)
```

### Import Resolution (Import Map Injection)

Door `.tsx` imports `solid-js` and `floatty/doors`. Inside a Blob module, bare specifiers like `import { createSignal } from 'solid-js'` fail unless the browser has an import map telling it where `solid-js` lives.

**Requirement**: Inject an import map into `index.html` **before** any doors load. The build process must export the specific SolidJS runtime chunks to predictable asset paths.

```html
<!-- src-tauri/index.html — injected at build time or by doorLoader on init -->
<script type="importmap">
{
  "imports": {
    "solid-js": "/assets/vendor/solid-js/solid.js",
    "solid-js/web": "/assets/vendor/solid-js/web.js",
    "solid-js/store": "/assets/vendor/solid-js/store.js",
    "floatty/doors": "/assets/floatty-doors.js"
  }
}
</script>
```

**Build integration**: Vite already bundles SolidJS. The import map entries must point to the **same** runtime instance the host app uses — not a second copy. If the door gets a different `createSignal`, reactivity won't cross the host/door boundary. Vite's `build.rollupOptions.output.manualChunks` can force SolidJS into a named chunk with a stable path.

**`floatty/doors` module**: A thin re-export of door type definitions. At runtime it's mostly a no-op (types are erased), but doors may import runtime helpers from it in future.

**Phase 0A must prove**: Does `import(blobUrl)` resolve bare specifiers via the import map? Some engines only apply import maps to static `<script type="module">`, not dynamic `import()`. If this fails, fall back to **Strategy B**: swc rewrites bare specifiers to relative paths during compilation (`'solid-js'` → `'/assets/vendor/solid-js/solid.js'`).

**Critical**: The door and the host MUST share the same SolidJS module instance. Two copies = two reactive runtimes = signals don't propagate across the boundary.

---

## 5. Technical Constraints

- **No Node.js** — Tauri webview. All system access through `DoorContext`.
- **Build Profile Isolation** — paths from `DataPaths`. Dev: `~/.floatty-dev/plugins/doors/`. Release: `~/.floatty/plugins/doors/`.
- **Handler Registry is King** — do NOT modify `registry.ts`. Doors become `BlockHandler` via adapter.
- **Hook Lifecycle** — doors go through `executeHandler()`. Full pipeline (`execute:before`/`execute:after`).
- **SolidJS Rules Apply** — don't destructure props, use `on()` for explicit deps.
- **JSON Serializable Only** — `DoorResult<T>` requires `T extends JsonSerializable`. No `Date`, `Map`, `Set`, class instances, functions, `undefined`, circular references. Strings, numbers, booleans, arrays, plain objects only. Door data flows through `setBlockOutput()` → Y.Map, and Y.Doc only round-trips JSON-safe types. Use ISO strings for dates, arrays for ordered collections, plain objects for maps.
- **CSS Scoping (Convention, Not Shadow DOM)** — Doors are NOT in Shadow DOM (needs reactive integration with host themes). CSS leakage is prevented by convention:

### CSP Requirements (Explicit)

Tauri's Content Security Policy must be configured to allow the door loading pipeline:

```json
// tauri.conf.json → app.security.csp
"script-src 'self' blob:"
```

- `blob:` is required for `import(URL.createObjectURL(...))` — the door module loading mechanism.
- If import maps don't resolve bare specifiers from Blob modules (Phase 0B), add the Vite asset origin.
- Do NOT add `'unsafe-eval'` — doors don't need `eval()` and it opens XSS surface.

### Import Allowlist (Compile-Time)

During swc compilation, statically analyze the door's import specifiers. Allow only:

| Specifier | Reason |
|-----------|--------|
| `solid-js`, `solid-js/web`, `solid-js/store` | Framework runtime (via import map) |
| `floatty/doors` | Door type definitions + runtime helpers |
| Relative imports (`./`, `../`) within the door directory | Multi-file doors (v2, optional) |

Everything else is a compile error. This prevents doors from importing host internals (`../../hooks/useBlockStore`), other doors' code, or arbitrary npm packages. The allowlist is enforced at compile time, not runtime — if it's not in the list, the compiled JS is never produced.

### CSS Scoping Protocol

Doors share the host document's style scope. Without discipline, a door's CSS bleeds into the outliner or other doors.

**Rules:**
1. Every door wraps its root JSX in a unique class: `<div class="door-{doorName}">`. The daily door uses `door-daily`, timestamp uses `door-timestamp`.
2. All door CSS selectors MUST be scoped under `.door-{doorName}`. No bare element selectors (`div`, `span`, `h3`) — always `.door-daily h3`.
3. `DoorHost.tsx` provides CSS custom properties derived from the active Floatty theme:

```css
.door-output {
  /* Theme bridge — doors use these, not raw --color-ansi-* */
  --door-bg: var(--color-bg-secondary);
  --door-fg: var(--color-fg-primary);
  --door-accent: var(--color-ansi-cyan);
  --door-muted: var(--color-fg-muted);
  --door-border: var(--color-border);
  --door-tag-bg: var(--color-bg-tertiary);
  --door-error: var(--color-ansi-red);
  --door-success: var(--color-ansi-green);
}
```

4. Doors style using `--door-*` variables, not theme variables directly. This gives the host a stable contract to remap if the theme system changes.
5. A `doors.css` base stylesheet provides sensible defaults for common door elements (`.door-tag`, `.door-chip`, `.door-stat`, `.door-empty`, `.door-loading`).

**Why not Shadow DOM**: Shadow DOM isolates reactivity boundaries. SolidJS signals wouldn't propagate from host to door, `<Dynamic>` wouldn't see the door's DOM, and theme CSS variables wouldn't inherit. Convention-based scoping is the pragmatic choice.

### Handler Adapter

```typescript
function doorToBlockHandler(door: Door, meta: DoorMeta, ctx: DoorContext): BlockHandler {
  return {
    prefixes: door.prefixes,
    async execute(blockId, content, actions) {
      let outputId = findOutputChild(blockId, actions);
      if (!outputId) outputId = actions.createBlockInside(blockId);

      actions.setBlockStatus?.(outputId, 'running');
      actions.updateBlockContent(outputId, '');

      try {
        const result = await door.execute(blockId, content, ctx);

        // Enforce JSON-serializable output (hard fail, not silent corruption)
        try { structuredClone(result.data); }
        catch { throw new Error('NON_SERIALIZABLE_OUTPUT: door returned data that cannot round-trip through Y.Doc'); }

        const output: DoorOutput = {
          kind: 'door', doorId: meta.id, schema: 1,
          data: result.data, error: result.error,
        };
        actions.setBlockOutput?.(outputId, output, 'door-view');
        actions.setBlockStatus?.(outputId, result.error ? 'error' : 'complete');
      } catch (err) {
        const output: DoorOutput = {
          kind: 'door', doorId: meta.id, schema: 1,
          data: null, error: String(err),
        };
        actions.setBlockOutput?.(outputId, output, 'door-view');
        actions.setBlockStatus?.(outputId, 'error');
      }
    },
  };
}
```

---

## 6. JavaScript API Surface (Three Tiers)

### Tier 1 — Always Available (No Declaration)

These require no `meta.capabilities` — they're the baseline every door gets.

```typescript
// Pre-authenticated REST API (localhost)
ctx.server.url          // "http://127.0.0.1:8765"
ctx.server.wsUrl        // "ws://127.0.0.1:8765/ws"
ctx.server.fetch(path)  // Bearer token pre-injected

// Block CRUD (convenience over REST)
ctx.actions.createBlockInside(parentId: string): string
ctx.actions.createBlockAfter(afterId: string): string
ctx.actions.updateBlockContent(id: string, content: string): void
ctx.actions.getBlock(id: string): BlockSnapshot | undefined
ctx.actions.setBlockOutput(id: string, output: unknown, outputType: string): void
ctx.actions.setBlockStatus(id: string, status: 'idle' | 'running' | 'complete' | 'error'): void

// Identity & config
ctx.blockId             // Current block ID
ctx.content             // Current block content
ctx.doorId              // Door identifier (first prefix)
ctx.settings            // [plugins.settings.X] from config.toml
ctx.log(...)            // Prefixed console logger
```

**Web platform** (always available, with one exception):
```
URL, URLSearchParams, TextEncoder/Decoder,
crypto.subtle, structuredClone, AbortController,
setTimeout/setInterval, JSON, Date, Intl, console
```

**`fetch` is NOT in this list.** Global `fetch()` is overridden in the door sandbox to prevent
bypassing the Tier 2 domain allowlist. Doors that need external HTTP must declare
`meta.capabilities.fetch` domains and use `ctx.fetch()`. Without this, the Tier 2 gate is
unenforceable — any door could `fetch('https://evil.com')` via the global.

The sandbox wrapper replaces `globalThis.fetch` in the door's module scope with a function
that throws: `"Use ctx.fetch() for external HTTP or ctx.server.fetch() for the local API."`
Localhost requests via `ctx.server.fetch()` (Tier 1) are unaffected.

**SolidJS** (via import map — always available in `.tsx`):
```
createSignal, createEffect, createMemo, createResource,
onMount, onCleanup, Show, For, Switch, Match, Dynamic
```

**Key distinction**: `ctx.server.fetch` (localhost, pre-auth) is Tier 1. `ctx.fetch` (external HTTP) is Tier 2. The server enforces its own access control — a door hitting `POST /api/v1/blocks` is no more dangerous than Claude Code doing the same thing every session.

### Tier 2 — Requires `meta.capabilities` Declaration

```typescript
// File I/O (scoped to declared directories)
ctx.fs.readFile(path: string): Promise<string>
ctx.fs.readBinary(path: string): Promise<Uint8Array>
ctx.fs.writeFile(path: string, content: string): Promise<void>
ctx.fs.listDir(path: string, glob?: string): Promise<string[]>
ctx.fs.exists(path: string): Promise<boolean>
// All paths canonicalized against meta.capabilities.fs

// External HTTP (scoped to declared domains)
ctx.fetch(url: string, init?: RequestInit): Promise<Response>
// Only domains in meta.capabilities.fetch

// Tauri commands (scoped to declared names)
ctx.invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>
// Only commands in meta.capabilities.invoke
```

Example declaration:
```typescript
export const meta = {
  capabilities: {
    fs: ['~/Documents/Notes/Daily'],     // Paths door can read/write
    fetch: ['wttr.in', 'api.github.com'], // Domains door can reach
    invoke: ['execute_daily_command'],     // Tauri commands door can call
  },
};
```

### Tier 3 — NOT Exposed (v1)

| Capability | Why Not |
|-----------|---------|
| `deleteBlock`, `focusBlock` | Too destructive / attention-stealing |
| `hookRegistry`, `eventBus` | Doors don't register hooks |
| Y.Doc direct access | CRDT internals stay internal |
| `window`/`document` globals | Doors render through their view component |
| `getChildren`, `getParentId` | Tree traversal via REST (`GET /api/v1/blocks`) |

---

## 7. Implementation Phases

### Phase 0: Proof of Concept (GATE — Do This First)

Tauri's CSP is intentionally restrictive. Whether `blob:` module imports work depends on the effective CSP and webview behavior. This must be proven in the target runtime, not assumed.

**A. Blob import in Tauri webview:**

Drop this into the Tauri webview console (or a dev-only UI action):

```typescript
(async () => {
  const blob = new Blob(
    ['export const x = 1; export default () => "ok";'],
    { type: 'application/javascript' }
  );
  const url = URL.createObjectURL(blob);

  try {
    const mod = await import(url);
    console.log('BLOB_IMPORT_OK', mod.x, mod.default?.());
  } catch (e) {
    console.error('BLOB_IMPORT_FAIL', e);
  } finally {
    URL.revokeObjectURL(url);
  }
})();
```

Interpretation:
- `BLOB_IMPORT_OK` → you can ship compiled door bundles as blob modules. Proceed.
- `BLOB_IMPORT_FAIL` → **stop**. Do not build infra. Pivot loading strategy (e.g., `asset:` protocol modules, pre-bundled static files, or a host-side module registry).

**B. Compiled SolidJS component via Blob + `<Dynamic>`:**

Pre-compile a trivial component (manually, using Vite's solid transform), Blob-import, mount via `<Dynamic>`. Confirm it renders and reactivity works.

**C. swc-plugin-jsx-dom-expressions reality check:**

The Solid SWC plugin (`milomg/swc-plugin-jsx-dom-expressions`) exists as a GitHub repo but is NOT a polished "grab-from-crates-and-go" crate. SWC's WASM plugin compatibility is a moving target with version coupling issues.

Before writing any architecture around "compile doors with SWC + plugin inside Tauri":
- Prove plugin loading format (native Rust crate vs WASM)
- Prove version pinning strategy (SWC core version ↔ plugin version)
- If WASM-only: does `swc_core` support loading WASM plugins from Rust?
- **Fallback**: Tauri sidecar running minimal Vite/esbuild bundler (adds Node.js build dep, keeps compilation stable)
- **Performance**: Measure compile cost per door on startup. If >500ms per door, consider caching compiled JS alongside `.tsx` source.

**Phase 0C success criterion**: "Given `swc_core` version X, we can compile Solid TSX with plugin Y, producing modules that load under our CSP and do not break host keyboard handling (`delegateEvents: false` confirmed in output)."

**If Phase 0 fails** — pivot loading mechanism first. Everything else is downstream noise.

### Phase 0.5: Server API Forcing Function

The headless-first principle means the API must serve doors before doors ship. `daily::` needs time-range queries. Fix the API first — every client benefits.

Add to `floatty-server/src/api.rs`:

```
GET /api/v1/blocks?since={unix_ms}&until={unix_ms}   # Filter by createdAt range
GET /api/v1/blocks?marker_type={type}                 # Filter by metadata marker type
GET /api/v1/blocks?marker_type={type}&marker_value={v} # Filter by marker type+value
```

These are query parameter extensions to the existing `GET /api/v1/blocks` endpoint — server-side filtering instead of shipping all blocks to the client. Without this, `daily::` fetches every block in the workspace and filters client-side, which won't scale past a few thousand blocks.

Implementation is straightforward: the `get_blocks()` handler already reads all blocks from Y.Doc. Add optional query params → filter the response before serialization. Index optimization can come later — the data is already in memory.

**This is the forcing function in action**: daily:: found a gap, so the gap gets fixed at the API level, and Claude Code / CLI agents / TUI followers all get time-travel queries for free.

### Phase 1: Rust Layer

- `src-tauri/src/commands/plugins.rs` — `list_door_files`, `read_door_file`, `compile_door`
- `src-tauri/src/paths.rs` — `doors_dir` on `DataPaths`
- `src-tauri/Cargo.toml` — `swc_core` + solid JSX plugin
- Security: `canonicalize()`, reject outside doors dir, reject `.`/`_` prefix, 1MB limit

### Phase 2: Loader + Registries

- `src/lib/handlers/doorTypes.ts` — interfaces
- `src/lib/handlers/doorRegistry.ts` — view component registry
- `src/lib/handlers/doorLoader.ts` — load, compile, validate, register
- `src/lib/handlers/doorSandbox.ts` — `createDoorContext()`
- `src/lib/handlers/doorAdapter.ts` — `doorToBlockHandler()`

Per-door try/catch. Return `DoorLoadResult`.

### Phase 3: Rendering

- `src/components/views/DoorHost.tsx` — `<Dynamic>` wrapper
- `src/components/BlockItem.tsx` — add `door-view` branch
- `src/styles/doors.css` — base styles + CSS custom properties

### Phase 4: The Daily Door

- `{data_dir}/plugins/doors/daily.tsx` — the door
- Delete: `src/lib/handlers/daily.ts`, `src/components/views/DailyView.tsx`
- Edit: `BlockItem.tsx` remove old `daily-view` branch
- Edit: `index.ts` remove `dailyHandler` registration

Validation:
- [ ] `daily::today` renders timeline via `<Dynamic>`
- [ ] `daily::yesterday` resolves correctly
- [ ] Error/loading states work
- [ ] Old DailyView.tsx and daily.ts deleted

### Phase 5: Config

```toml
[plugins]
enabled = true

[plugins.settings.daily]
notes_dir = "~/Documents/Notes/Daily"
template = "# {{date}}\n\n## Plan\n\n## Log\n"
```

### Phase 6: Second Door

```tsx
// timestamp.tsx — minimal, no invoke, no fs
import { Show } from 'solid-js';
import type { Door, DoorViewProps } from 'floatty/doors';

interface TsData { formatted: string; format: string; raw: string }

function TsView(props: DoorViewProps<TsData>) {
  return (
    <div class="door-timestamp">
      <span class="door-ts-value">{props.data.formatted}</span>
      <Show when={props.data.format !== 'iso'}>
        <span class="door-ts-format">{props.data.format}</span>
      </Show>
    </div>
  );
}

export const door: Door<TsData> = {
  prefixes: ['ts::', 'timestamp::'],
  async execute(blockId, content, ctx) {
    const fmt = content.replace(/^(ts|timestamp)::\s*/i, '').trim() || 'iso';
    const now = new Date();
    const formatted = fmt === 'unix' ? String(Math.floor(now.getTime() / 1000))
      : fmt === 'date' ? now.toLocaleDateString()
      : fmt === 'time' ? now.toLocaleTimeString()
      : now.toISOString();
    return { data: { formatted, format: fmt, raw: now.toISOString() } };
  },
  view: TsView,
};
```

---

## 8. What This Is NOT

| Not This | Why |
|----------|-----|
| Vanilla DOM rendering | Doors write JSX. Real SolidJS components. |
| npm / package manager | Drop a `.tsx` in a directory. That's it. |
| Hot reload | Restart to pick up doors. Future work. |
| Framework-agnostic | Doors are SolidJS. Lean into it. |
| Hook registration from doors | `execute()` + `view` only. No hooks (v1). |
| Plugin marketplace | Local files only. |

---

## 9. Open Questions (Phase 0 Research)

1. **Import maps in Tauri v2** — can webview `<script type="importmap">` resolve `solid-js` for Blob modules?
2. **swc-plugin-jsx-dom-expressions** — Rust crate or WASM-only? Determines where compilation lives. See Phase 0C.
3. **CSP for `blob:`** — does Tauri v2 allow `import()` from `blob:` URLs by default? See Phase 0A.
4. **Theme access** — doors use CSS custom properties (recommended) or receive theme signal via props?
5. **Server API gaps for doors** — verified gaps that `daily::` would need:
   - No query-by-date-range endpoint (client-side filter over `GET /api/v1/blocks` works but doesn't scale)
   - No query-by-marker-type endpoint (`metadata.markers` is per-block, no indexed query)
   - Search (`GET /api/v1/search`) is content-only, doesn't filter by metadata
   - Metadata not settable in `POST /api/v1/blocks` body (must PATCH after create, or rely on hooks)
   - These are forcing-function gaps: fix them in the server API so all clients benefit

---

## 10. Definition of Done

- [ ] `.tsx` in doors dir → prefix in `registry.getRegisteredPrefixes()` after restart
- [ ] `daily::today` renders SolidJS timeline via `<Dynamic>`
- [ ] Old `DailyView.tsx` and `daily.ts` deleted
- [ ] `BlockItem.tsx` uses `<DoorHost>` instead of per-type `<Show>` chains
- [ ] Door errors in DevTools, registry unaffected
- [ ] `timestamp::` validates generalization
- [ ] Config settings accessible via `props.settings`
- [ ] Path traversal returns errors
- [ ] Full hook lifecycle for doors
- [ ] `delegateEvents: false` — no keyboard interference

---

## 11. Architecture Diagram

```
User types "daily::today"
    │
    ▼
HandlerRegistry.findHandler('daily::today')
    │  ← doorToBlockHandler adapter
    ▼
executeHandler()  ← hooks: execute:before / execute:after
    │
    ├─ adapter.execute()
    │   ├─ Build DoorContext { server, actions, settings, blockId, ... }
    │   ├─ door.execute(blockId, content, ctx)
    │   │     └─ ctx.server.fetch('/api/v1/blocks')    ← Tier 1: pre-auth localhost
    │   │           └─ floatty-server → JSON blocks
    │   │     └─ Filter by date, build DailyData       ← Door logic (pure JS)
    │   ├─ setBlockOutput(childId, { doorId, data }, 'door-view')
    │   └─ setBlockStatus(childId, 'complete')
    │
    ▼
BlockItem: outputType === 'door-view'
    │
    ▼
<DoorHost doorId="daily::" data={DailyData} />
    ├─ doorRegistry.getView('daily::') → DailyView
    └─ <Dynamic component={DailyView} data={...} settings={...} />
         └─ SolidJS: <For>, <Show>, reactive props
            Timeline, tags, PR chips, details
```

---

## 12. Verification Procedure (Required Before Execution)

**Status**: This is a checklist to EXECUTE, not pre-filled assertions. Run each probe against the real codebase and fill in Status/Notes before proceeding to Phase 0.

### Handler System

| Assumption | Code Probe | Status | Notes |
|-----------|------------|--------|-------|
| `HandlerRegistry` exports `register()`, `findHandler()`, `getRegisteredPrefixes()` | `src/lib/handlers/registry.ts` | ___ | Record additional methods found |
| `BlockHandler` has `prefixes: string[]` + `execute(blockId, content, actions)` | `src/lib/handlers/types.ts` | ___ | Paste exact signature |
| `ExecutorActions` shape matches spec | `src/lib/handlers/types.ts` | ___ | Count actual methods, list any spec missed |
| `executeHandler()` wraps with `execute:before`/`execute:after` hooks | `src/lib/handlers/executor.ts` | ___ | Note hook abort behavior |
| `registerHandlers()` has HMR guard + built-in registration | `src/lib/handlers/index.ts` | ___ | Count built-in handlers, identify insertion point for `loadUserDoors()` |

### Rendering System

| Assumption | Code Probe | Status | Notes |
|-----------|------------|--------|-------|
| Block fields: `output`, `outputType`, `outputStatus` | `src/lib/blockTypes.ts` | ___ | Paste exact field names and types |
| `outputType` strings in use | `src/components/BlockItem.tsx` | ___ | List every string literal |
| Hardcoded view type count | `BlockItem.tsx` | ___ | Count branches, note nesting pattern |
| DailyView receives data via props | `src/components/views/DailyView.tsx` | ___ | Paste prop type |
| `DailyNoteData` shape (actual) | `src/lib/tauriTypes.ts` | ___ | Record exact field names (snake_case vs camelCase) |
| Output blocks keyboard behavior | `BlockItem.tsx` | ___ | Note tabIndex, event handler pattern |

### Config & Paths

| Assumption | Code Probe | Status | Notes |
|-----------|------------|--------|-------|
| Config is TOML with serde derives | `src-tauri/src/config.rs` | ___ | Note struct name and fields |
| `[plugins]` section exists | `config.rs` | ___ | If missing, note extensibility of `save_to()` |
| `DataPaths::default_root()` handles dev/release | `src-tauri/src/paths.rs` | ___ | Confirm `FLOATTY_DATA_DIR` override |
| Pattern for adding subdirs | `paths.rs::from_root()` | ___ | Note where new field + `ensure_dirs` would go |
| Y.Doc output round-trips JSON | `src/hooks/useBlockStore.ts` | ___ | Find `setBlockOutput()`, trace to Y.Map write |

### Server API (Headless-First Readiness)

| Assumption | Code Probe | Status | Notes |
|-----------|------------|--------|-------|
| Auth is Bearer token | `floatty-server/src/api.rs` | ___ | Note any exemptions |
| Block CRUD via REST | `api.rs` router | ___ | Count endpoints |
| Can POST blocks with metadata in body | `api.rs::create_block` | ___ | List accepted fields |
| Can query blocks by marker | `api.rs` | ___ | If missing, note workaround |
| Can query blocks by date | `api.rs` | ___ | If missing, note whether `createdAt` available |
| WebSocket real-time sync | `ws.rs` | ___ | Note message format |

### Compilation Pipeline

| Assumption | Code Probe | Status | Notes |
|-----------|------------|--------|-------|
| `swc-plugin-jsx-dom-expressions` is usable from Rust | crates.io + GitHub | ___ | **Must prove in Phase 0C** |
| `blob:` import works in Tauri webview | Tauri CSP in `tauri.conf.json` | ___ | **Must prove in Phase 0A** |
| Import map resolves bare specifiers from Blob modules | Webview test | ___ | **Must prove in Phase 0B** |

---

## 13. The Pattern

```
BBS (1985):  User dials in  → DOOR.BAT matches  → Door gets COM port   → Door paints ANSI
mIRC (1995): on TEXT *::*    → Script matches     → Script gets $chan     → Script sends text
Vue (2014):  :is="name"      → Registry resolves  → Component gets props  → Component renders
floatty:     User types ::   → Registry matches   → <Dynamic> mounts     → Door renders JSX
```

Same shape. 40 years deep.

---

## 14. Execution Order

**Status: DO NOT BUILD YET**

```
1. Run verification procedure (Section 12) — fill in every Status/Notes cell
2. Run Phase 0A: Blob import probe in Tauri webview
3. Run Phase 0B: Import map resolves bare specifiers from Blob module
4. Run Phase 0C: SWC + Solid plugin compilation → delegateEvents:false in output
5. Run Phase 0.5: Add date range + marker query endpoints to server API
6. Only if (2-4) pass → proceed with corrected spec
7. If any gate fails → pivot that specific mechanism FIRST
```

The spec is a hypothesis. The codebase is the truth. Phase 0 is the gate.
