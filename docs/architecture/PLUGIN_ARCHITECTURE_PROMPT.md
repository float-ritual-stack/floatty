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
  /** Block CRUD (sandboxed) */
  actions: ScopedActions;
  /** Read/write files (scoped to declared directories) */
  fs: ScopedFS;
  /** HTTP fetch (rate-limited, logged) */
  fetch: typeof fetch;
  /** Call Tauri commands (scoped allowlist) */
  invoke: ScopedInvoke;
  /** Door-specific settings from config.toml */
  settings: Record<string, unknown>;
  /** Prefixed logger */
  log: (...args: unknown[]) => void;
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
      const data = await ctx.invoke<DailyData>('execute_daily_command', { dateArg: date });
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
  capabilities: { invoke: ['execute_daily_command'] },
};
```

### What This Proves

| Capability | How daily:: exercises it |
|-----------|--------------------------|
| SolidJS view component | `<For>`, `<Show>`, reactive props — real SolidJS, not vanilla DOM |
| `ctx.invoke()` | Calls `execute_daily_command` (scoped allowlist) |
| Typed data flow | `execute()` returns `DailyData`, view receives via `DoorViewProps<DailyData>` |
| Component registry | Host mounts via `<Dynamic component={door.view}>`, no hardcoded `<Show>` |
| Self-contained | Logic + view + types in one `.tsx` file |

---

## 3. Rendering Architecture (Component Registry + `<Dynamic>`)

Currently `BlockItem.tsx` hardcodes view routing:

```tsx
// CURRENT: one <Show> branch per output type — doesn't scale
<Show when={block()?.outputType === 'daily-view'}>
  <DailyView data={...} />
</Show>
<Show when={block()?.outputType === 'search-results'}>
  <SearchResultsView data={...} />
</Show>
// Every new view type = edit BlockItem.tsx. That's wrong.
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

## 6. The Sandbox (DoorContext)

### ScopedActions

```typescript
interface ScopedActions {
  createBlockInside(parentId: string): string;
  createBlockAfter(afterId: string): string;
  updateBlockContent(id: string, content: string): void;
  getBlock(id: string): BlockSnapshot | undefined;
  setBlockOutput(id: string, output: unknown, outputType: string): void;
  setBlockStatus(id: string, status: string): void;
  // NOT exposed: deleteBlock, focusBlock, getChildren, getParentId
}
```

### ScopedFS

```typescript
interface ScopedFS {
  readFile(path: string): Promise<string>;
  readBinary(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: string): Promise<void>;
  listDir(path: string, glob?: string): Promise<string[]>;
  exists(path: string): Promise<boolean>;
}
```

All methods go through Tauri commands with `canonicalize()` against declared `capabilities.fs`.

### ScopedInvoke

```typescript
type ScopedInvoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
```

Only commands in `meta.capabilities.invoke`. Others throw.

---

## 7. Implementation Phases

### Phase 0: Proof of Concept (Do This First)

**A. Blob import in Tauri webview:**
```typescript
const code = `export const door = { prefixes: ['test::'] }`;
const blob = new Blob([code], { type: 'application/javascript' });
const url = URL.createObjectURL(blob);
const mod = await import(url);
console.log(mod.door.prefixes); // ['test::']
```

**B. Compiled SolidJS component via Blob + `<Dynamic>`:**
Pre-compile a trivial component, Blob-import, mount via `<Dynamic>`. Confirm it renders.

**If either fails** — stop. Check CSP in `tauri.conf.json`. `blob:` may need allow-listing.

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
2. **swc-plugin-jsx-dom-expressions** — Rust crate or WASM-only? Determines where compilation lives.
3. **CSP for `blob:`** — does Tauri v2 allow `import()` from `blob:` URLs by default?
4. **Theme access** — doors use CSS custom properties (recommended) or receive theme signal via props?

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
    │   ├─ Build DoorContext (scoped actions, fs, invoke, settings)
    │   ├─ door.execute(blockId, content, ctx)
    │   │     └─ ctx.invoke('execute_daily_command', { dateArg })
    │   │           └─ Rust → DailyData
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

## 12. The Pattern

```
BBS (1985):  User dials in  → DOOR.BAT matches  → Door gets COM port   → Door paints ANSI
mIRC (1995): on TEXT *::*    → Script matches     → Script gets $chan     → Script sends text
Vue (2014):  :is="name"      → Registry resolves  → Component gets props  → Component renders
floatty:     User types ::   → Registry matches   → <Dynamic> mounts     → Door renders JSX
```

Same shape. 40 years deep.
