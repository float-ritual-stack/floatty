# floatty Patterns

Quick reference for common patterns. See `ARCHITECTURE.md` for data model details, `ARCHITECTURE_LINEAGE.md` for philosophy.

---

## Executable Block Handler

```typescript
// executor.ts
{
  prefixes: ['myprefix::', 'alias::'],
  execute: async (content) => { /* return string */ },
  parseOutput: parseMarkdownTree,  // optional: structure output
  pendingMessage: 'Working...',
}
```

---

## Child-Output Pattern

Executable blocks don't mutate their content. They create children:

```typescript
// Create output as child, not in-place
const outputId = actions.createBlockInside(blockId);
actions.updateBlockContent(outputId, `output::${result}`);
```

```
sh:: ls -la
  └─ output:: file1.txt file2.txt ...
```

This preserves: original command (rerunnable), undo semantics (delete child), multiple outputs (re-run appends).

---

## Y.Doc Transaction

Always wrap mutations:

```typescript
_doc.transact(() => {
  blocksMap.set(id, blockToYMap(block));
  setValueOnYMap(blocksMap, parentId, 'childIds', newChildIds);
});
// Origin is null (local) by default - UndoManager tracks these
```

---

## Origin Filtering (Prevent Sync Loops)

```typescript
// In Y.Doc observer
if (origin === 'remote' || isApplyingRemoteGlobal) return;
```

---

## Double-rAF for Post-Mutation Focus

Y.Doc → SolidJS reconciliation → DOM takes 2 frames:

```typescript
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    contentRef?.focus();
  });
});
```

---

## Wikilink Navigation

```typescript
import { navigateToPage } from '../hooks/useBacklinkNavigation';

// Regular click: same pane
navigateToPage(target, paneId, 'none');

// Cmd+Click: horizontal split
navigateToPage(target, paneId, 'horizontal');

// Cmd+Shift+Click: vertical split
navigateToPage(target, paneId, 'vertical');
```

---

## Pane State Access

```typescript
// Zoom
paneStore.getZoomedRootId(paneId);
paneStore.setZoomedRoot(paneId, blockId);

// Collapse (pane-specific override of block.collapsed)
paneStore.isCollapsed(paneId, blockId, block.collapsed);
paneStore.toggleCollapsed(paneId, blockId);

// Focus
paneStore.getFocusedBlockId(paneId);
paneStore.setFocusedBlockId(paneId, blockId);
```

---

## Terminal Re-Parenting

```typescript
// MUST dispose WebGL before re-opening
if (instance.webglAddon) {
  instance.webglAddon.dispose();
  instance.webglAddon = null;
}
instance.term.open(newContainer);
// Re-add WebGL after
```

---

## PTY Cleanup

```typescript
// Guard against double-call
if (this.disposing.has(id)) return;
this.disposing.add(id);

// Kill if still running, dispose if naturally exited
if (!instance.exitedNaturally) {
  await invoke('plugin:pty|kill', { pid });
} else {
  await invoke('plugin:pty|dispose', { pid });
}
```

---

## Auto-Execute Guard

```typescript
// Only auto-execute idempotent blocks
function isAutoExecutable(content: string): boolean {
  return isDailyBlock(content);
  // NOT: sh::, ai:: (side effects, need Enter)
}
```

---

## Selection Modes

```typescript
// handleSelect(id, mode)
'set'    // Clear selection, set anchor only (plain click)
'anchor' // Select block AND set as anchor (first Shift+Arrow, Cmd+A)
'toggle' // Toggle block in/out of selection (Cmd+Click)
'range'  // Select from anchor to target (subsequent Shift+Arrow)
```

---

## Cursor Check

```typescript
// Use this (handles edge cases)
cursor.isAtStart()

// NOT this (can disagree in edge cases)
cursor.getOffset() === 0
```

---

## Focus Transition (Text → Block Mode)

```typescript
if (isEditing) {
  (document.activeElement as HTMLElement)?.blur();
  containerRef?.focus();  // keeps keyboard events flowing to tinykeys
}
```

The outliner container has `tabIndex={-1}` for this.
