# CLAUDE.md

---

## TL;DR: Critical Context

**Tech Stack** (NOT React):
- **Frontend**: SolidJS (fine-grained reactivity, no virtual DOM)
- **Backend**: Tauri v2 + Rust (IPC, subprocess management)
- **Server**: Axum (headless Y.Doc authority)
- **CRDT**: Yjs (frontend) ↔ Yrs (backend) via base64-encoded updates

**Philosophy**: Shacks Not Cathedrals. Walls that can move.

**The Pattern** (40 Years Deep):
```text
Event → Handler → Transform → Project
BBS (1985) → mIRC (1995) → Redux (2015) → floatty (2026)
```

**Three Fatal Mistakes**:
1. Don't destructure SolidJS props (breaks reactivity)
2. Don't use `<For>` for heavy components (use `<Key>` from @solid-primitives/keyed)
3. Don't skip origin filtering in Y.Doc observers (causes sync loops)

---

## What This Is

Terminal emulator + CRDT outliner + ctx:: aggregator. High-performance PTY (4000+ redraws/sec), multi-tab, Y.Doc sync, Ollama-powered ctx:: parsing, 5 themes.

## Architecture

SolidJS (local Y.Doc) → Tauri IPC → Rust (floatty-server subprocess) → Axum (Y.Doc authority, SQLite).

See @.claude/rules/architecture.md for full file inventory, data flows, and component details.

## Commands

```bash
npm install           # Install JS dependencies
npm run tauri dev     # Dev mode (hot reload frontend, rebuilds Rust)
npm run lint          # ESLint
npm run test          # Run vitest (420 tests)
npm run test:watch    # Watch mode for TDD
```

### Rust Tests (IMPORTANT)

Cargo.toml is in `src-tauri/`, not the project root. The package name is `float-pty`, not `floatty`.

```bash
# Run from src-tauri/ — test filter goes AFTER `--`
cd src-tauri && cargo test -p float-pty -- test_name_here

# Multiple test filters
cd src-tauri && cargo test -p float-pty -- test_one test_two

# All Rust tests
cd src-tauri && cargo test -p float-pty
```

**Common mistakes** (do NOT do these):
```bash
cargo test -p floatty ...              # Wrong package name (it's float-pty)
cargo test -p float-pty test_name      # Missing `--` before test filter
cargo test ...                         # No Cargo.toml in project root
```

### Version Bumping

Three files must stay in sync. Use the Edit tool for JSON files — `mv` on this machine is aliased to `mv -i` which blocks on interactive confirmation.

```
src-tauri/Cargo.toml      # workspace.package.version AND package.version
package.json              # .version
src-tauri/tauri.conf.json # .version
```

Use Edit tool with `replace_all: true` for all three.

### Release Build

```bash
./scripts/build-server.sh   # Build server sidecar
npm run tauri build          # Build app (includes sidecar)
```

Or use `./scripts/rebuild.sh` for full workflow (kill, build, install, launch, health check).

## API

Server requires auth. See @.claude/rules/api-reference.md for all endpoints.

Quick reference:
```bash
KEY=$(grep '^api_key' ~/.floatty-dev/config.toml | cut -d'"' -f2)
PORT=$(grep '^server_port' ~/.floatty-dev/config.toml | cut -d= -f2 | tr -d ' ')
curl -s -H "Authorization: Bearer $KEY" "http://127.0.0.1:$PORT/api/v1/blocks" | jq '.blocks | length'
```

## Testing

**Stack**: Vitest + jsdom + @solidjs/testing-library

**Philosophy**: Store-first testability. Test pure logic without fighting DOM/contentEditable.

```typescript
// Test pure logic — no rendering needed
import { determineKeyAction } from './useBlockInput';
const result = determineKeyAction('Enter', false, null, { block, cursorOffset: 5 });
expect(result.type).toBe('split_block');

// Test components — inject mock stores
import { WorkspaceProvider, createMockBlockStore } from '../context/WorkspaceContext';
render(() => (
  <WorkspaceProvider blockStore={createMockBlockStore({ ... })}>
    <BlockItem id="test" paneId="pane" depth={0} onFocus={() => {}} />
  </WorkspaceProvider>
));
```

## Keybind Registry

Check this list when adding keybinds to avoid conflicts.

**Reserved (pass through to terminal)**: `Ctrl+C/Z/D/A/E/K/U/W/L/R` (signals, readline)

**Terminal/Global** (in `Terminal.tsx`):
- `⌘T` / `Ctrl+T` - New tab
- `⌘W` / `Ctrl+W` - Close tab
- `⌘1-9` - Jump to tab N
- `⌘⇧[` / `⌘⇧]` - Prev/next tab
- `⌘\` - Toggle sidebar
- `⌘K` - Command palette
- `⌘L` - Link pane (overlay picker)
- `⌘J` - Focus pane (overlay picker)
- `⌘⌥Arrow` - Directional pane focus

**Outliner** (in `Outliner.tsx` via tinykeys):

| Key | Behavior |
|-----|----------|
| `Enter` | Command block: execute handler. Regular: create sibling/split |
| `⌘Enter` | Zoom into subtree |
| `Escape` | Zoom out to full tree |
| `Tab` | Indent (at line start) or insert spaces |
| `⇧Tab` | Outdent (at line start) |
| `⌘.` | Toggle collapse |
| `⌘⌫` | Delete block and subtree |
| `⌘⇧M` / `Ctrl+Shift+M` | Export markdown to clipboard |
| `⌘⇧J` / `Ctrl+Shift+J` | Export JSON (FLO-247) |
| `⌘⇧B` / `Ctrl+Shift+B` | Export binary Y.Doc (FLO-247) |
| `⌘[` / `⌘]` | Navigation history back/forward |
| `⌘Z` / `⌘⇧Z` | Undo/redo |
| `⌘A` | Select all (escalates: text → block → tree) |
| `⌘0-3` | Expand to level N |

## Four Bug Categories

| Category | Symptoms | Fix |
|----------|----------|-----|
| **Re-Parenting Trap** | xterm WebGL errors on tab/split | Dispose WebGL addon BEFORE DOM reparent |
| **Sync Loop** | Infinite updates, frozen UI | Origin filtering in Y.Doc observers |
| **PTY Zombies** | Orphan processes after close | Guard disposal with `disposing` Set, `kill_all` on close |
| **Split Brain** | Stale data, wrong block selected | ID-based lookups (not index), re-fetch after CRDT update |

## Configuration

Data dir: `~/.floatty-dev` (debug) / `~/.floatty` (release). Override: `FLOATTY_DATA_DIR`.

See @.claude/rules/config-and-logging.md for config fields, logging, sync health, selection architecture.

## Known Issues

1. **xterm decorations** - `term.registerDecoration()` crashed with renderer errors. Removed.

## Canonical Paths (Use The Architecture)

Before implementing any common pattern, **grep the codebase for existing implementations**. If infrastructure exists, use it.

| Pattern | Use This | Not This |
|---------|----------|----------|
| Logging | `createLogger('Target')` from `lib/logger.ts` | `console.log/warn/error` (ESLint enforced) |
| Navigation | `navigateToBlock/navigateToPage` from `lib/navigation.ts` | Direct `zoomTo()` or hook exports |
| Block tree queries | `lib/blockContext.ts` helpers | Inline `getBlock → childIds → getBlock` traversals |
| Block type detection | `blockTypes.ts` `parseBlockType()` | Inline `content.startsWith('sh::')` checks |
| Events/reactions | `EventBus` from `lib/events/` | `window.dispatchEvent` or custom emitters |
| Typed IPC | `invoke<T>()` via `lib/tauriTypes.ts` | Raw `invoke()` from `@tauri-apps/api/core` |
| Inline formatting | `inlineParser.ts` | Regex-based markdown/wikilink parsing |
| Expansion/collapse | `expansionPolicy.ts` `computeExpansion()` | Direct `setCollapsed()` calls |
| Y.Array mutations | Surgical helpers (`insertChildId`, `removeChildId`) | `delete(0, length)` then `push()` |

### Protected Architecture

These modules are load-bearing infrastructure. Do not delete, bypass, or reimplement:

- **`logger.ts`** — console interception + Rust log bridge. All logging flows through here.
- **`navigation.ts`** — single navigation funnel. All nav (wikilinks, search, backlinks, chirp) routes through here.
- **`expansionPolicy.ts`** — unified expand/collapse logic. One policy, not five.
- **`EventBus`** + **`ProjectionScheduler`** — search fidelity chain (layers 1-2). Deleting these starves the Tantivy index.
- **Y.Doc surgical helpers** in `useBlockStore.ts` — `insertChildId`, `removeChildId`, etc. Never delete-all-then-push.

## Pattern References

- See @.claude/rules/solidjs-patterns.md — SolidJS reactivity patterns (CRITICAL)
- See @.claude/rules/ydoc-patterns.md — CRDT architecture (source of truth, surgical mutations)
- See @.claude/rules/do-not.md — anti-patterns by layer (PTY, SolidJS, Y.Doc, Rust)
- See @.claude/rules/contenteditable-patterns.md — cursor, offset, DOM edge cases
- See @.claude/rules/serde-api-patterns.md — snake_case/camelCase API boundary
- See @.claude/rules/pane-drag-drop-patterns.md — split layout drag/resize
- See @.claude/rules/output-block-patterns.md — embedded view focus routing
- See @.claude/rules/accessibility-baseline.md — ARIA, focus, motion
- See @.claude/rules/symmetry-check.md — hotfix drift prevention
- See @.claude/rules/architecture.md — full file inventory, data flows
- See @docs/architecture/EXPAND_COLLAPSE_NAVIGATION.md — unified expansion policy + navigation funnel
- See @.claude/rules/api-reference.md — all REST/WS endpoints
- See @.claude/rules/config-and-logging.md — paths, config, logging, sync health
