# Investigation Prompts Reference

Example handoff prompts for common floatty issues. These prompts are designed for a fresh Claude session to pick up and execute.

## Prompt Structure

```
Context: [Technology stack and component interactions]

Task:
1. Verify: [Steps to confirm the issue exists]
2. Orient: [Relevant files and patterns to review]
3. Action: [Step-by-step fix with code examples]
4. Validate: [Specific tests/checks to confirm fix]
```

---

## Example 1: Sync Loop Detection

**Trigger**: UI freezes or infinite updates when editing blocks

```markdown
# Investigation: Y.Doc Sync Loop in Block Observer

## Context
Floatty uses Yjs CRDTs for block storage. Observers on `blocksMap` fire on every change. If an observer writes back to Y.Doc without origin filtering, it triggers itself infinitely.

## Task

### 1. Verify
- Edit a block in the outliner
- Check browser console for rapid-fire observer logs
- Check if UI becomes unresponsive

### 2. Orient
Read these files for existing patterns:
- `src/hooks/useBlockStore.ts` - block CRUD with origin tagging
- `src/lib/origin.ts` - Origin enum values
- `.claude/rules/ydoc-patterns.md` - Pattern 4: Origin Prevents Infinite Loops

### 3. Action
Find the observer without origin filtering:

```typescript
// ❌ WRONG - no origin check
blocksMap.observeDeep(events => {
  const extracted = extractMetadata(events);
  blocksMap.set(id, { ...block, metadata: extracted });  // Triggers self!
});

// ✅ CORRECT - filter by origin
blocksMap.observeDeep(events => {
  const origin = events[0]?.transaction.origin;
  if (origin === Origin.Hook) return;  // Don't process our own writes

  const extracted = extractMetadata(events);
  yDoc.transact(() => {
    blocksMap.set(id, { ...block, metadata: extracted });
  }, Origin.Hook);  // Tag our write
});
```

### 4. Validate
- Edit a block, confirm no infinite loop
- Check that metadata extraction still works
- Run `npm run test` - all 318 tests should pass
```

---

## Example 2: Terminal Re-Parenting Crash

**Trigger**: WebGL errors when switching tabs or splitting panes

```markdown
# Investigation: Terminal WebGL Disposal on Re-Parent

## Context
xterm.js with WebGL addon crashes if the terminal is moved to a new DOM container without first disposing the WebGL context. The WebGL addon holds references to the old canvas.

## Task

### 1. Verify
- Open a terminal tab
- Split the pane horizontally
- Check browser console for WebGL errors like "context lost" or "invalid operation"

### 2. Orient
Read these files:
- `src/lib/terminalManager.ts` - terminal lifecycle management
- `src/components/TerminalPane.tsx` - thin wrapper component
- `.claude/rules/do-not.md` - Re-Parenting Trap section

### 3. Action
Ensure WebGL disposal happens BEFORE DOM manipulation:

```typescript
// In terminalManager.ts
reattach(id: string, newContainer: HTMLElement) {
  const instance = this.instances.get(id);
  if (!instance) return;

  // ❌ WRONG order - DOM first, then WebGL
  // instance.term.open(newContainer);
  // instance.webglAddon?.dispose();

  // ✅ CORRECT order - WebGL dispose, then DOM
  instance.webglAddon?.dispose();
  instance.webglAddon = null;

  // Double rAF for DOM to settle
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      instance.term.open(newContainer);
      instance.webglAddon = new WebglAddon();
      instance.term.loadAddon(instance.webglAddon);
    });
  });
}
```

### 4. Validate
- Split terminal pane multiple times
- Switch between tabs rapidly
- No WebGL errors in console
- Terminal renders correctly after each operation
```

---

## Example 3: PTY Zombie Process

**Trigger**: Shell processes remain after closing tabs or app crash

```markdown
# Investigation: PTY Process Not Killed on Tab Close

## Context
Each terminal tab spawns a PTY process in Rust. If the frontend closes without notifying the backend, or if the kill signal is skipped, zombie processes accumulate.

## Task

### 1. Verify
```bash
# Before: count shell processes
pgrep -f "zsh|bash" | wc -l

# Open floatty, create 3 terminal tabs, close app

# After: count again - should be same as before
pgrep -f "zsh|bash" | wc -l
```

### 2. Orient
Read these files:
- `src-tauri/src/pty/manager.rs` - PTY lifecycle
- `src-tauri/src/lib.rs` - Tauri command handlers
- `src/hooks/useTabStore.ts` - tab close handlers

### 3. Action
Ensure cleanup runs on all exit paths:

```rust
// src-tauri/src/pty/manager.rs

impl Drop for PtyManager {
    fn drop(&mut self) {
        self.kill_all();  // Kill all processes on drop
    }
}

fn kill_all(&mut self) {
    for (id, process) in self.processes.drain() {
        if process.pid > 0 {
            // Check if still alive before killing
            if self.process_exists(process.pid) {
                let _ = signal::kill(
                    Pid::from_raw(process.pid as i32),
                    Signal::SIGTERM
                );
            }
        }
    }
}
```

Frontend must also notify on tab close:

```typescript
// useTabStore.ts
closeTab(id: string) {
  invoke('close_pty', { id }).catch(console.error);
  // ... remove from store
}
```

### 4. Validate
- Create multiple terminal tabs
- Close individual tabs - check `pgrep` count decreases
- Close entire app - check no orphans remain
- Force-quit app (Cmd+Q) - check cleanup still runs
```

---

## Example 4: Split Brain After Sync

**Trigger**: Wrong block content after receiving remote updates

```markdown
# Investigation: Stale Block Reference After Remote Sync

## Context
Callbacks and event handlers may capture block references at creation time. If a remote sync updates the block, the captured reference is stale. Using the stale reference overwrites the remote change.

## Task

### 1. Verify
- Open same outline in two windows
- Edit block in window A
- Before sync arrives, edit same block in window B
- Check if one edit is lost

### 2. Orient
Read these files:
- `src/hooks/useBlockStore.ts` - getBlock() lookup pattern
- `.claude/rules/ydoc-patterns.md` - Pattern 8: ID-Based Lookups

### 3. Action
Always re-fetch block at time of use, not capture time:

```typescript
// ❌ WRONG - captured at handler creation
const block = store.getBlock(id);
const handleBlur = () => {
  store.updateBlock(id, { content: block.content + suffix });  // Stale!
};

// ✅ CORRECT - fresh fetch at execution time
const handleBlur = () => {
  const currentBlock = store.getBlock(id);  // Fresh!
  store.updateBlock(id, { content: currentBlock.content + suffix });
};
```

For callbacks that might race with sync:

```typescript
// Use edit tokens to detect stale writes
let editToken = 0;

const handleInput = () => {
  editToken = Date.now();
  debouncedSave(id, content, editToken);
};

const save = (id: string, content: string, token: number) => {
  const block = store.getBlock(id);
  if (block.lastRemoteUpdate > token) {
    // Remote update arrived after our edit started - don't overwrite
    return;
  }
  store.updateBlockContent(id, content);
};
```

### 4. Validate
- Two-window edit test passes
- No content loss on rapid editing
- Remote changes appear in both windows
```

---

## Prompt File Naming Convention

When writing investigation prompts to `.claude/prompts/`:

```
.claude/prompts/
├── 2026-01-14-sync-loop-observer.md
├── 2026-01-14-webgl-reparent.md
└── 2026-01-15-pty-zombie.md
```

Format: `{YYYY-MM-DD}-{issue-slug}.md`

Include front matter for tooling:

```yaml
---
created: 2026-01-14
category: sync-loop | pty | webgl | split-brain
severity: high | medium | low
status: open | resolved
---
```
