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
  /** Prefixes that trigger this door (e.g., ['daily::']) */
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

export interface DoorResult<T = unknown> {
  /** Structured data passed to the view component */
  data: T;
  /** Optional error message */
  error?: string;
}

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

### Door Metadata (Optional)

```typescript
export const meta = {
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

// AFTER: one branch for all doors
<Show when={block()?.outputType === 'door-view'}>
  <DoorHost
    doorId={(block()?.output as any)?.doorId}
    data={(block()?.output as any)?.data}
    error={(block()?.output as any)?.error}
    status={block()?.outputStatus}
  />
</Show>
```

---

## 4. Compilation Pipeline

### Why `.tsx`

Doors write SolidJS JSX. That JSX needs compilation — SolidJS uses `jsx-dom-expressions` to turn `<div>{signal()}</div>` into direct DOM creation calls with fine-grained subscriptions. Without compilation, JSX is syntax errors.

### swc with Solid Plugin (Rust Side)

```rust
// src-tauri/src/commands/plugins.rs
#[tauri::command]
pub async fn compile_door(source: String) -> Result<String, String> {
    // 1. Strip TypeScript types (swc built-in)
    // 2. Transform JSX via swc-plugin-jsx-dom-expressions
    //    Config: generate = "dom", hydratable = false, delegateEvents = false
    // 3. Target: ES2022
}
```

**`delegateEvents: false` is critical.** Solid's event delegation attaches to `document`. Doors must NOT participate in host event delegation — prevents interference with outliner keyboard handling.

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

### Import Resolution

Door `.tsx` imports `solid-js` and `floatty/doors`. These need to resolve at runtime.

**Strategy A: Import Map** (recommended):
```html
<script type="importmap">
{ "imports": {
    "solid-js": "/assets/solid-js.js",
    "solid-js/web": "/assets/solid-js-web.js",
    "floatty/doors": "/assets/floatty-doors.js"
} }
</script>
```

**Strategy B**: swc rewrites imports to globals during compilation.

Research Tauri v2 import map support in Phase 0.

---

## 5. Technical Constraints

- **No Node.js** — Tauri webview. All system access through `DoorContext`.
- **Build Profile Isolation** — paths from `DataPaths`. Dev: `~/.floatty-dev/plugins/doors/`. Release: `~/.floatty/plugins/doors/`.
- **Handler Registry is King** — do NOT modify `registry.ts`. Doors become `BlockHandler` via adapter.
- **Hook Lifecycle** — doors go through `executeHandler()`. Full pipeline (`execute:before`/`execute:after`).
- **SolidJS Rules Apply** — don't destructure props, use `on()` for explicit deps.
- **JSON Serializable Only** — `DoorResult<T>` requires `T extends JsonSerializable`. No `Date`, `Map`, `Set`, class instances, functions, `undefined`, circular references. Strings, numbers, booleans, arrays, plain objects only. Door data flows through `setBlockOutput()` → Y.Map, and Y.Doc only round-trips JSON-safe types. Use ISO strings for dates, arrays for ordered collections, plain objects for maps.

### Handler Adapter

```typescript
function doorToBlockHandler(door: Door, ctx: DoorContext): BlockHandler {
  return {
    prefixes: door.prefixes,
    async execute(blockId, content, actions) {
      let outputId = findOutputChild(blockId, actions);
      if (!outputId) outputId = actions.createBlockInside(blockId);

      actions.setBlockStatus?.(outputId, 'running');
      actions.updateBlockContent(outputId, '');

      try {
        const result = await door.execute(blockId, content, ctx);
        actions.setBlockOutput?.(outputId, {
          doorId: door.prefixes[0], data: result.data, error: result.error,
        }, 'door-view');
        actions.setBlockStatus?.(outputId, result.error ? 'error' : 'complete');
      } catch (err) {
        actions.setBlockOutput?.(outputId, {
          doorId: door.prefixes[0], data: null, error: String(err),
        }, 'door-view');
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

**Web platform** (it's a browser — always available):
```
fetch, URL, URLSearchParams, TextEncoder/Decoder,
crypto.subtle, structuredClone, AbortController,
setTimeout/setInterval, JSON, Date, Intl, console
```

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
- **Fallback**: Vite's `@vitejs/plugin-solid` as a build step, invoked via Node.js subprocess

**If Phase 0 fails** — pivot loading mechanism first. Everything else is downstream noise.

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

## 12. Verification: Spec vs Codebase (Required Before Execution)

Run this verification pass before building anything. Record actual type names and exact string literals.

### Handler System

| Assumption | Code Probe | Status | Notes |
|-----------|------------|--------|-------|
| `HandlerRegistry` exports `register()`, `findHandler()`, `getRegisteredPrefixes()` | `src/lib/handlers/registry.ts` | ✅ Match | Also has `isExecutableBlock()`, `clear()` (HMR) |
| `BlockHandler` has `prefixes: string[]` + `execute(blockId, content, actions)` | `src/lib/handlers/types.ts` | ✅ Match | Exact signature confirmed |
| `ExecutorActions` has block CRUD methods | `src/lib/handlers/types.ts` | ⚠️ Richer | 12 methods including `createBlockInsideAtTop`, `updateBlockContentFromExecutor`, `getParentId`, `getChildren`, `focusBlock`, `paneId`. Spec only showed 6. |
| `executeHandler()` wraps with `execute:before`/`execute:after` hooks | `src/lib/handlers/executor.ts` | ✅ Match | Also takes `store: HookBlockStore` param. Hooks can abort (returns `blocked::` prefix). |
| `registerHandlers()` has HMR guard + built-in registration | `src/lib/handlers/index.ts` | ✅ Match | 9 built-in handlers. `loadUserDoors()` slots after line 65, before hook registration. |

### Rendering System

| Assumption | Code Probe | Status | Notes |
|-----------|------------|--------|-------|
| Block fields: `output`, `outputType`, `outputStatus` | `src/lib/blockTypes.ts:44-52` | ✅ Match | `outputStatus: 'pending' \| 'running' \| 'complete' \| 'error'`. Documented as client-only state. |
| `outputType` string: `'daily-view'` | `src/components/BlockItem.tsx:910` | ✅ Match | Also `'daily-error'`, `'search-results'`, `'search-error'` |
| 2 hardcoded view types in BlockItem.tsx | `BlockItem.tsx:900-950` | ✅ Match | Daily (3 branches) + Search (3 branches). Nested `<Show>` checks both type AND status. |
| DailyView receives data via props | `src/components/views/DailyView.tsx:11` | ✅ Match | `DailyViewProps { data: DailyNoteData }` |
| `DailyNoteData` shape | `src/lib/tauriTypes.ts:82-87` | ⚠️ Drift | Real shape uses `snake_case` from Rust: `day_of_week`, `timelogs`, `scattered_thoughts`. Spec used `camelCase`: `dayOfWeek`, `entries`, `notes`. Door would need to match Rust shape OR transform. |
| Output blocks are keyboard dead zones | `BlockItem.tsx:901` | ✅ Match | Wrapped in `div[tabIndex=0]` with separate `handleOutputBlockKeyDown`. |

### Config & Paths

| Assumption | Code Probe | Status | Notes |
|-----------|------------|--------|-------|
| Config is TOML with serde derives | `src-tauri/src/config.rs` | ✅ Match | `AggregatorConfig` with `#[derive(Serialize, Deserialize)]` |
| `[plugins]` section exists | `config.rs` | ❌ Missing | No plugin config yet. But `save_to()` TOML merge preserves unknown sections — extensible. |
| `DataPaths::default_root()` handles dev/release | `src-tauri/src/paths.rs` | ✅ Match | `~/.floatty-dev` (debug) / `~/.floatty` (release). `FLOATTY_DATA_DIR` env override. |
| Pattern for adding subdirs | `paths.rs::from_root()` | ✅ Match | Add `pub doors: PathBuf` field, set in `from_root()`, create in `ensure_dirs()`. |
| Y.Doc output round-trips JSON | `src/hooks/useBlockStore.ts:621` | ✅ Match | `setBlockOutput()` → `setValueOnYMap()`. Y.Map stores arbitrary JSON-safe values. |

### Server API (Headless-First Readiness)

| Assumption | Code Probe | Status | Notes |
|-----------|------------|--------|-------|
| Auth is Bearer token | `src-tauri/floatty-server/src/api.rs` | ✅ Match | `Authorization: Bearer <key>`. Localhost (127.0.0.1, ::1) exempt. |
| Block CRUD via REST | `api.rs` router | ✅ Match | 27 endpoints. Full CRUD: GET/POST/PATCH/DELETE `/api/v1/blocks`. |
| Can POST blocks with metadata | `api.rs::create_block` | ⚠️ Partial | `POST /api/v1/blocks` accepts `content`, `parentId`, `afterId`, `atIndex`. No `metadata` in create body — must PATCH after. |
| Can query blocks by marker | `api.rs` | ❌ Missing | No metadata query endpoint. Must `GET /api/v1/blocks` + filter client-side. |
| Can query blocks by date | `api.rs` | ❌ Missing | `createdAt`/`updatedAt` available per block, but no date range query. |
| WebSocket for real-time | `ws.rs` | ✅ Match | Seq-based gap detection, heartbeat every 30s. |

### Compilation Pipeline

| Assumption | Code Probe | Status | Notes |
|-----------|------------|--------|-------|
| `swc-plugin-jsx-dom-expressions` is a Rust crate | crates.io / GitHub | ⚠️ Unverified | GitHub repo exists (`milomg/swc-plugin-jsx-dom-expressions`). Not obviously a polished crate. WASM plugin compat is version-coupled. **Must prove in Phase 0C.** |
| `blob:` import works in Tauri webview | Tauri CSP | ⚠️ Unverified | Known edge cases with blob/object URLs. **Must prove in Phase 0A.** |

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
1. Run verification pass (Section 12) — patch spec where reality disagrees  ✅ DONE
2. Run Blob import probe in Tauri webview (Phase 0A gate)
3. Run SWC + Solid plugin feasibility check (Phase 0C)
4. Only if (2) passes → proceed with corrected spec
5. If (2) fails → pivot loading mechanism FIRST; everything else is downstream noise
```

The spec is a hypothesis. The codebase is the truth. Phase 0 is the gate.
