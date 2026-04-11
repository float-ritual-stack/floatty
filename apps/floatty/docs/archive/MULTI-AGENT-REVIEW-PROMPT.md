# Floatty Multi-Agent Parallel Code Review

Use with Claude Opus 4.5 or spawn as parallel Task agents.

## Orchestration

Launch 6 specialized agents in parallel, then synthesize findings.

---

## AGENT 1: CSS & Paint Performance

**Files**: `src/index.css`, any inline styles in `.tsx`

**Find**:
1. Paint-breaking CSS (we just removed `contain: paint` - are there others?)
2. Expensive selectors (deep nesting, universal selectors)
3. Hardcoded colors not using CSS variables
4. Dead selectors (no matching elements)
5. Animation/transition not using GPU-accelerated properties
6. Theme consistency issues

**Stack Context**:
- Two-layer overlay architecture: display layer (styled, pointer-events: none) + edit layer (contentEditable, transparent text)
- Any CSS affecting character positioning will desync the layers
- `content-visibility: auto` broke the overlay - be suspicious of containment

**Silent Error Pattern**:
```css
/* BAD: breaks overlay sync */
.md-code { padding: 0 2px; }  /* shifts characters */

/* GOOD: safe decorations */
.md-code { color: green; background: rgba(); }
```

---

## AGENT 2: SolidJS Reactivity

**Files**: `src/hooks/*`, `src/components/*.tsx`, `src/context/*`

**Find**:
1. Effects without `onCleanup` (memory leaks)
2. Signals accessed outside tracking scope (event handlers, setTimeout)
3. Missing `batch()` for multiple signal updates
4. Store proxies leaking to external code (xterm, Y.Doc)
5. `<For>` used where `<Key>` needed (terminal panes, heavy components)
6. Props destructuring (breaks reactivity)
7. Refs accessed before mount

**Stack Context**:
- `createRoot` for singleton stores - verify not recreated
- Y.Doc observers must not trigger on their own updates
- `requestAnimationFrame` chains need cleanup

**Silent Error Patterns**:
```typescript
// BAD: loses reactivity
const handler = () => {
  const val = signal();  // accessed outside tracking
};

// BAD: self-triggering effect
createEffect(() => {
  const val = signal();
  setSignal(val + 1);  // infinite loop
});

// BAD: proxy escapes
terminalManager.attach(id, store.panes[id]);  // store proxy
```

---

## AGENT 3: Terminal & xterm.js Lifecycle

**Files**: `src/lib/terminalManager.ts`, `src/components/Terminal*.tsx`

**Find**:
1. WebGL context leaks (dispose before re-open)
2. PTY zombie processes (all exit paths must kill)
3. Event listeners not cleaned up on dispose
4. Scroll position lost on re-parent
5. Addon disposal order (WebGL before term.dispose)
6. Missing `exitedNaturally` flag checks

**Stack Context**:
- Tauri PTY uses channels - `onData`/`onExit` must be handled
- Re-parenting during SolidJS re-renders causes WebGL context loss
- `isDragging` state suppresses fit() - verify timeout cleanup

**Silent Error Patterns**:
```typescript
// BAD: WebGL context leak
instance.term.open(newContainer);  // no dispose first!

// BAD: fire-and-forget PTY kill
invoke('plugin:pty|kill', { pid });  // not awaited

// BAD: listener on detached container
resizeObserver.observe(oldContainer);  // never disconnected
```

---

## AGENT 4: CRDT/Yjs Synchronization

**Files**: `src/hooks/useSyncedYDoc.ts`, `src/hooks/useBlockStore.ts`

**Find**:
1. Missing origin filter (causes echo loops)
2. UndoManager tracking remote updates
3. Multiple mutations not batched in `transact()`
4. `recentTxIds` Set growing unbounded
5. Reconnect race conditions
6. LocalStorage backup causing duplication

**Stack Context**:
- HTTP + WebSocket dual-path sync
- Base64 encoding for binary diffs
- `hasPendingUpdates()` gates window close

**Silent Error Patterns**:
```typescript
// BAD: no origin filter
doc.on('update', (update) => {
  syncToServer(update);  // echoes remote back!
});

// BAD: unbatched
blocksMap.set(id1, block1);
blocksMap.set(id2, block2);  // two update events!

// GOOD:
doc.transact(() => {
  blocksMap.set(id1, block1);
  blocksMap.set(id2, block2);
});
```

---

## AGENT 5: Tauri IPC & Error Handling

**Files**: All files with `invoke()`, `src-tauri/src/*.rs`

**Find**:
1. `invoke()` without error handling
2. Type mismatches (TS return type vs Rust)
3. Blocking invoke in render path
4. `beforeunload` trying to await (impossible)
5. Tauri channel leaks
6. Double-encoding (Base64 twice)

**Stack Context**:
- Tauri v2 plugin syntax: `plugin:pty|spawn`
- `getCurrentWebviewWindow()` vs `getCurrentWindow()`
- PTY binary data needs Base64 encoding

**Silent Error Patterns**:
```typescript
// BAD: fire and forget
invoke('save_state', { data });  // error swallowed

// BAD: wrong return type
invoke<string>('get_data');  // Rust returns Option<String>!

// BAD: can't await in beforeunload
window.addEventListener('beforeunload', () => {
  invoke('cleanup');  // can't await!
});
```

---

## AGENT 6: Outliner Block Engine

**Files**: `src/components/BlockItem.tsx`, `src/components/Outliner.tsx`, `src/hooks/useBlock*.ts`

**Find**:
1. `textContent` vs `innerText` (line break handling)
2. Focus without mount check (ref might be undefined)
3. Selection not cleared on block delete
4. Cursor utilities missing edge cases
5. Double-rAF pattern not applied consistently
6. Zoom boundary violations in navigation

**Stack Context**:
- contentEditable + SolidJS is finicky
- `<Key>` for stable block identity during reorder
- Zoom state is per-pane

**Silent Error Patterns**:
```typescript
// BAD: textContent loses line breaks
const content = contentRef.textContent;  // <div> becomes ""

// GOOD:
const content = contentRef.innerText;  // <div> becomes "\n"

// BAD: focus after unmount
requestAnimationFrame(() => {
  contentRef.focus();  // might be undefined!
});

// BAD: stale selection
deleteBlock(id);
// selectedBlockIds still contains deleted id!
```

---

## UNIVERSAL ANTI-PATTERNS (ALL AGENTS)

Flag these anywhere:

```typescript
// 1. Fire-and-forget async
someAsyncFunction();  // no await, no .catch()

// 2. Empty catch
try { ... } catch (e) { }

// 3. console.error without user feedback
catch (e) { console.error(e); }  // user sees nothing

// 4. Type assertion hiding errors
const data = response as SomeType;  // no validation

// 5. Optional chaining hiding undefined
obj?.deeply?.nested?.value;  // silent failure

// 6. Index access without bounds
const item = array[index];  // might be undefined

// 7. Event listener without cleanup
window.addEventListener('resize', handler);
// Missing: onCleanup(() => window.removeEventListener(...))
```

---

## SYNTHESIS OUTPUT FORMAT

After all agents complete, produce:

```markdown
## Executive Summary
[5-10 most critical findings]

## Priority Matrix

| Issue | Severity | Agent | Fix Complexity |
|-------|----------|-------|----------------|
| ...   | 🔴/⚠️/🛠 | #1-6  | Low/Med/High   |

## 🔴 Fix Immediately (Data Loss / Crashes)
1. [Issue] - [File:Line] - [Fix]

## ⚠️ Fix Soon (Leaks / Performance)
1. [Issue] - [File:Line] - [Fix]

## 🛠 Refactor When Convenient
1. [Pattern] - [Files] - [Strategy]

## Code Reuse Opportunities
[Duplicated logic across files]

## Simplification Opportunities
[Over-engineered patterns that can be reduced]
```

---

## Execution

```bash
# If using Claude Code Task tool, spawn 6 agents:
# Each agent gets their section above + the relevant source files

# Agent outputs should be JSON for synthesis:
{
  "agent": 1,
  "critical": [...],
  "warnings": [...],
  "simplifications": [...],
  "silent_errors": [...]
}
```
