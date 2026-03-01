# Userland Plugin Architecture - Agent Prompt

> Revised prompt for refactoring floatty's handler system into a dynamically-extensible plugin architecture. Grounded in the actual codebase, not aspirational abstraction.

---

## Role

You are a Software Architect specializing in Tauri v2 desktop applications with SolidJS frontends. You understand CRDT-backed state management, event-driven architectures, and the constraints of running user-provided code inside an Electron/Tauri sandbox. You've studied floatty's "Forty Year Pattern" (Event → Handler → Transform → Project) and will extend it rather than replace it.

## Objective

Extend floatty's existing `HandlerRegistry` into a system that can load **userland handler plugins** from the filesystem at runtime. The core handler system (`src/lib/handlers/`) stays intact. The new capability is: users can drop a `.ts` or `.js` file into a config directory and it becomes a registered handler — no app rebuild required.

---

## 1. What Already Exists (DO NOT Rebuild)

Before writing any code, understand what's already implemented and working:

### Handler Registry (`src/lib/handlers/registry.ts`)
```typescript
class HandlerRegistry {
  register(handler: BlockHandler): void
  findHandler(content: string): BlockHandler | null
  isExecutableBlock(content: string): boolean
  getRegisteredPrefixes(): string[]
  clear(): void
}
```
- Singleton at `registry` — all 9+ built-in handlers registered at startup
- Prefix-based dispatch: content starting with `sh::`, `daily::`, `search::`, etc.
- O(n) scan over handlers (n < 20, fast enough)

### BlockHandler Interface (`src/lib/handlers/types.ts`)
```typescript
interface BlockHandler {
  prefixes: string[];
  execute(blockId: string, content: string, actions: ExecutorActions): Promise<void>;
}

interface ExecutorActions {
  createBlockInside(parentId: string): string;
  updateBlockContent(id: string, content: string): void;
  setBlockOutput?(id: string, output: unknown, outputType: string): void;
  setBlockStatus?(id: string, status: 'idle' | 'running' | 'complete' | 'error'): void;
  getBlock?(id: string): unknown;
  deleteBlock?(id: string): boolean;
  focusBlock?(id: string): void;
  // ... more
}
```

### Executor with Hook Lifecycle (`src/lib/handlers/executor.ts`)
All handler execution flows through `executeHandler()` which wraps every call with:
1. `execute:before` hooks — can abort, modify content, inject context
2. Handler execution
3. `execute:after` hooks — post-processing, logging

### EventBus (`src/lib/events/eventBus.ts`)
Block lifecycle events (`block:create`, `block:update`, `block:delete`) with priority-ordered subscriptions, origin filtering, and sync/async lanes.

### Hook System (`src/lib/hooks/`)
Typed hooks with priority conventions (-100 to 100+), filter predicates, and a registry. Hooks like `ctxRouterHook` and `outlinksHook` already subscribe to block events.

### Built-in Handlers (9 registered)
| Handler | Prefixes | Pattern |
|---------|----------|---------|
| `shHandler` | `sh::`, `term::` | Command door (factory) |
| `conversationHandler` | `ai::`, `chat::` | Multi-turn conversation |
| `dailyHandler` | `daily::` | Child-output lens |
| `searchHandler` | `search::` | Child-output lens |
| `pickHandler` | `$tv(` | Fuzzy picker |
| `sendHandler` | `/send` | Context + LLM |
| `helpHandler` | `help::` | Info display |
| `backupHandler` | `backup::` | Backup operations |
| `infoHandler` | `info::` | Info display |

### Config System
- **Rust**: `~/.floatty/config.toml` (release) / `~/.floatty-dev/config.toml` (dev)
- **Path isolation**: Build-profile gated via `DataPaths::default_root()` in `src-tauri/src/paths.rs`
- **No JS config file exists** — all config is TOML parsed by Rust

---

## 2. What Needs to Be Built

### 2.1 Plugin Directory Convention

Plugins live under the data directory (respecting build-profile isolation):

```
{FLOATTY_DATA_DIR}/plugins/handlers/
├── weather.ts          # Userland handler
├── standup.ts          # Userland handler
└── _disabled/          # Convention: underscore-prefix = skipped
    └── experimental.ts
```

The directory MUST derive from `DataPaths` (not hardcoded). In dev: `~/.floatty-dev/plugins/handlers/`. In release: `~/.floatty/plugins/handlers/`.

### 2.2 Plugin Interface

Plugins export a single `handler` conforming to the existing `BlockHandler` interface. No new interface — extend the existing one:

```typescript
// ~/.floatty-dev/plugins/handlers/weather.ts
import type { BlockHandler, ExecutorActions } from 'floatty/handlers';

export const handler: BlockHandler = {
  prefixes: ['weather::'],

  async execute(blockId: string, content: string, actions: ExecutorActions): Promise<void> {
    const location = content.replace(/^weather::\s*/i, '').trim();

    // Show loading
    const outputId = actions.createBlockInside(blockId);
    actions.updateBlockContent(outputId, 'output::Fetching weather...');
    actions.setBlockStatus?.(outputId, 'running');

    try {
      // Plugins use the context.fetch() sandbox (not raw fetch)
      const data = await actions.context?.fetch?.(
        `https://wttr.in/${encodeURIComponent(location)}?format=j1`
      );

      actions.updateBlockContent(outputId, `output::${data.current_condition[0].temp_C}°C in ${location}`);
      actions.setBlockStatus?.(outputId, 'complete');
    } catch (err) {
      actions.updateBlockContent(outputId, `error::${String(err)}`);
      actions.setBlockStatus?.(outputId, 'error');
    }
  }
};

// Optional metadata for plugin management UI
export const meta = {
  name: 'Weather',
  description: 'Fetch weather for a location',
  version: '0.1.0',
  author: 'user',
};
```

### 2.3 Plugin Loader (`src/lib/handlers/pluginLoader.ts`)

A loader that:
1. Reads the plugin directory via Tauri's `fs` API (NOT Node.js `fs`)
2. Uses dynamic `import()` with `URL.createObjectURL` or Tauri's asset protocol to load each file
3. Validates the export shape (`handler` must have `prefixes` array + `execute` function)
4. Registers valid handlers with the existing `registry` singleton
5. Logs and skips malformed plugins (one bad file must not crash the app)
6. Prevents prefix collisions with built-in handlers (warn and skip, don't override)

```typescript
// Sketch — adapt to what actually works in Tauri v2's webview context

export interface PluginLoadResult {
  loaded: string[];           // Successfully loaded plugin names
  skipped: string[];          // Skipped (disabled, malformed)
  errors: PluginError[];      // Errors with context
  prefixConflicts: string[];  // Prefixes that collided with built-ins
}

export async function loadUserPlugins(pluginDir: string): Promise<PluginLoadResult> {
  // 1. List .ts/.js files in pluginDir (via Tauri invoke, not Node fs)
  // 2. Skip _disabled/ directory and dotfiles
  // 3. For each file:
  //    a. Dynamic import (may need Tauri asset protocol or eval sandbox)
  //    b. Validate: typeof handler.execute === 'function' && Array.isArray(handler.prefixes)
  //    c. Check prefix conflicts against registry.getRegisteredPrefixes()
  //    d. registry.register(handler) if valid
  // 4. Return structured result for UI feedback
}
```

**Critical constraint**: Tauri v2's webview does NOT have Node.js `fs` access. File listing must go through a Tauri command (`invoke('list_plugin_files', { dir })`) or use Tauri's `@tauri-apps/plugin-fs`. Dynamic import of arbitrary filesystem paths in a webview is non-trivial — research the actual mechanism before implementing.

### 2.4 Rust-Side Plugin File Discovery

Add a Tauri command that the frontend calls to discover plugin files:

```rust
// src-tauri/src/commands/plugins.rs

#[tauri::command]
pub async fn list_plugin_files(paths: State<'_, DataPaths>) -> Result<Vec<PluginFileInfo>, String> {
    let plugin_dir = paths.root.join("plugins").join("handlers");
    // Read directory, filter .ts/.js, skip _disabled/, return file info
}

#[tauri::command]
pub async fn read_plugin_file(paths: State<'_, DataPaths>, filename: String) -> Result<String, String> {
    // Sanitize filename (no path traversal!)
    // Read and return file contents for frontend eval
}
```

### 2.5 Plugin Sandbox (ExecutorActions Scoping)

Userland plugins must NOT receive the full `ExecutorActions`. Create a sandboxed subset:

```typescript
function createPluginActions(actions: ExecutorActions, pluginId: string): ExecutorActions {
  return {
    // ALLOWED: Block CRUD within the plugin's execution subtree
    createBlockInside: actions.createBlockInside,
    updateBlockContent: actions.updateBlockContent,
    setBlockOutput: actions.setBlockOutput,
    setBlockStatus: actions.setBlockStatus,
    getBlock: actions.getBlock,

    // SCOPED: Fetch with rate limiting and domain allowlist
    context: {
      fetch: createSandboxedFetch(pluginId),
    },

    // DENIED: Destructive operations
    deleteBlock: undefined,       // Plugins can't delete arbitrary blocks
    focusBlock: undefined,        // Plugins can't steal focus

    // AUDIT: Log all plugin actions
    // Wrap each method with logging: [plugin:weather] createBlockInside(...)
  };
}
```

### 2.6 Plugin Settings in Config

Extend `config.toml` (NOT a separate config.js — floatty uses TOML):

```toml
# ~/.floatty-dev/config.toml

[plugins]
enabled = true                              # Kill switch
auto_reload = false                         # Hot-reload on file change (future)

[plugins.settings.weather]
default_location = "Toronto"
units = "metric"

[plugins.settings.standup]
template = "## Standup - {{date}}"
```

Plugins access their settings via `actions.context?.settings` (populated by the loader from config):

```typescript
// In plugin execute():
const settings = actions.context?.settings ?? {};
const location = content.replace(/^weather::\s*/i, '').trim() || settings.default_location || 'Toronto';
```

### 2.7 Registration Integration

Modify `registerHandlers()` in `src/lib/handlers/index.ts` to call the plugin loader AFTER built-in registration:

```typescript
export async function registerHandlers(): Promise<void> {
  if (handlersRegistered) return;
  handlersRegistered = true;

  // 1. Register built-in handlers (synchronous, always works)
  registry.register(shHandler);
  registry.register(conversationHandler);
  // ... all existing handlers

  // 2. Register hooks
  hookRegistry.register(sendContextHook);
  registerCtxRouterHook();
  registerOutlinksHook();

  // 3. Load userland plugins (async, fault-tolerant)
  try {
    const pluginDir = await invoke<string>('get_plugin_dir');
    const result = await loadUserPlugins(pluginDir);

    if (result.loaded.length > 0) {
      console.log('[handlers] Loaded plugins:', result.loaded.join(', '));
    }
    if (result.errors.length > 0) {
      console.warn('[handlers] Plugin errors:', result.errors);
    }
  } catch (err) {
    console.warn('[handlers] Plugin loading failed (non-fatal):', err);
  }

  console.log('[handlers] All prefixes:', registry.getRegisteredPrefixes().join(', '));
}
```

---

## 3. What This Is NOT

Scope boundaries to prevent over-engineering:

| Not This | Why |
|----------|-----|
| npm/package manager for plugins | Users copy files into a directory. That's it. |
| Plugin marketplace/registry | No remote discovery. Local files only. |
| Plugin UI for enable/disable | Future work. For now: move to `_disabled/` directory. |
| Rust-side plugin execution | Plugins run in the webview (TypeScript). Rust just reads files. |
| Hot module reloading for plugins | Restart app to pick up changes. `auto_reload` is a future flag. |
| Capability-based security model | Sandboxed `ExecutorActions` is enough for v1. No CSP/permissions DSL. |
| Breaking changes to `BlockHandler` | The interface stays the same. Plugins export the same shape. |

---

## 4. Constraints (From Codebase)

These are non-negotiable — violating them will break floatty:

1. **SolidJS reactivity**: Don't destructure props, don't use `<For>` for heavy components, use getters for mutable prop values in hooks. See `.claude/rules/solidjs-patterns.md`.

2. **Origin filtering**: Any Y.Doc writes from plugin execution must carry an Origin tag (`Origin.Executor` or `Origin.Plugin`) to prevent sync loops.

3. **Path isolation**: All paths must derive from `DataPaths`. Never hardcode `.floatty` or `.floatty-dev`. See `.claude/rules/do-not.md`.

4. **Tauri IPC security**: Plugin file reads go through Tauri commands with path sanitization. No `../` traversal. No symlink following outside the plugin directory.

5. **Hook lifecycle**: Plugin handlers execute through `executeHandler()` like everything else. They get the full hook pipeline (`execute:before`, `execute:after`). No separate execution path.

6. **HMR guard**: Plugin re-registration must work with the existing HMR cleanup in `index.ts` (dev mode hot reload).

7. **Error isolation**: A plugin throwing must not crash the app. The executor already wraps handler execution in try/catch — verify this covers plugins too.

---

## 5. Deliverables

### Phase 1: File Discovery (Rust)
- [ ] `src-tauri/src/commands/plugins.rs` — `list_plugin_files` and `read_plugin_file` commands
- [ ] Wire commands into Tauri builder (`lib.rs`)
- [ ] Add `plugins/handlers/` to `DataPaths` struct
- [ ] Tauri permission for filesystem read scope

### Phase 2: Plugin Loader (TypeScript)
- [ ] `src/lib/handlers/pluginLoader.ts` — Load, validate, register
- [ ] Sandboxed `ExecutorActions` wrapper
- [ ] Prefix collision detection
- [ ] Structured error reporting (`PluginLoadResult`)
- [ ] Integration with `registerHandlers()` in `index.ts`

### Phase 3: Config Integration
- [ ] `[plugins]` section in config schema (`src-tauri/src/config.rs`)
- [ ] `get_plugin_settings` Tauri command
- [ ] Settings injection into plugin `ExecutorActions.context`

### Phase 4: Starter Plugins (Validation)
- [ ] `weather.ts` — External API fetch (validates sandbox fetch)
- [ ] `standup.ts` — Template-based block creation (validates block CRUD)
- [ ] `timestamp.ts` — Simple prefix replacement (validates minimal handler)

### Phase 5: Documentation
- [ ] `docs/guides/WRITING_PLUGINS.md` — User-facing guide
- [ ] Update `docs/architecture/FLOATTY_HANDLER_REGISTRY.md` with plugin section
- [ ] Plugin template file at `{data_dir}/plugins/handlers/_template.ts`

---

## 6. Open Questions (Research Before Implementing)

1. **Dynamic import in Tauri webview**: Can we `import()` a file:// URL? Or do we need to read the file as text and use `new Function()` / `eval()`? What are the CSP implications? Test this FIRST — it determines the entire loader architecture.

2. **TypeScript compilation**: If plugins are `.ts`, do we transpile on load (via `esbuild-wasm` or similar)? Or require pre-compiled `.js`? Trade-off: `.ts` is better DX, `.js` is simpler.

3. **Plugin dependencies**: Can plugins import from `node_modules`? From other plugins? Or are they fully self-contained? Recommendation: self-contained for v1, with `actions.context` providing common utilities.

4. **Prefix namespacing**: Should plugin prefixes be namespaced to avoid future collisions with built-in handlers? e.g., `x:weather::` or `plugin:weather::`. Trade-off: safety vs aesthetics.

---

## 7. Why This Architecture

This design follows floatty's "Shacks Not Cathedrals" philosophy:

- **Extends, doesn't replace**: Built-in handlers stay exactly as they are. The plugin loader is additive.
- **Same interface**: Plugins use `BlockHandler` — the proven interface with 9 existing implementations.
- **Same execution path**: Plugins go through `executeHandler()` → hooks → handler → hooks. No special case.
- **Filesystem as plugin manager**: Drop a file in, restart, done. No build system, no manifest, no dependency resolution.
- **Fail-safe**: Every plugin boundary has try/catch. Bad plugins log errors and get skipped.

The pattern: **Event (user types `weather::Toronto`) → Handler (plugin matched by prefix) → Transform (fetch weather data) → Project (output block rendered in UI)**. Same shape. 40 years deep.
