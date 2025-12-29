# Floatty UX Review

**Date**: 2025-12-28 @ 08:05 PM
**Focus**: Keyboard UX
**Depth**: balanced
**Review ID**: 2025-12-28-keyboard-balanced-b8d2

## Scope

**In scope**: Keybind system, keyboard navigation, shortcut discoverability, platform consistency
**Out of scope**: Visual styling, outliner block content editing (covered in quick review a7f3)
**Previous reviews**: 2025-12-28-keyboard-quick-a7f3 (findings expanded here)
**Linear issues checked**: 50 issues, 0 conflicts (FLO-90 search tracked, skip)

---

## Executive Summary

1. **StatusBar shortcuts hardcoded** — Literal `⌘D` strings on lines 29-35 won't adapt on Windows/Linux
2. **No keybind discoverability overlay** — 25+ bindings hidden, only 5 shown in StatusBar
3. **Split keybind platform friction** — `Cmd+D` vs `Ctrl+\` causes muscle memory confusion
4. **Pane focus requires 3 keys** — `Cmd+Opt+Arrow` is heavy; consider tmux-style single-key cycling
5. **Outliner block keybinds not surfaced** — `Cmd+.`, `Cmd+Enter`, `Cmd+Backspace` are discoverable only by trying

---

## Detailed Findings

### 1. StatusBar Shortcuts Hardcoded

**Severity**: Major
**Location**: `src/components/Terminal.tsx:29-35`
**Linear**: NEW

The StatusBar component defines shortcuts as literal strings, but `getKeybindDisplay()` is already imported (line 14) and used in TabBar tooltips (lines 133, 145). This inconsistency means:
- StatusBar shows `⌘D` on Linux (incorrect)
- Dynamic keybind customization won't reflect in StatusBar

**Agent Prompt**:
> In `src/components/Terminal.tsx`, refactor the `shortcuts` array (lines 29-35) to use `getKeybindDisplay()` for each action. Example:
> ```typescript
> const shortcuts = [
>   { label: 'Split', keys: getKeybindDisplay('splitHorizontal') || '⌘D' },
>   { label: 'Outliner', keys: getKeybindDisplay('splitHorizontalOutliner') || '⌘O' },
>   // etc.
> ];
> ```
> The `|| 'fallback'` handles null returns gracefully.

---

### 2. No Keybind Discoverability Overlay

**Severity**: Major
**Location**: N/A (missing feature)
**Linear**: NEW

Power users expect `Cmd+?` or similar to show all keybinds. Currently:
- 25+ keybinds exist in `keybinds.ts`
- Only 5 shown in StatusBar
- No help modal or overlay component exists

This is the most impactful keyboard UX gap for a power-user terminal.

**Agent Prompt**:
> Create a new component `src/components/KeybindHelp.tsx` that:
> 1. Renders when `showKeybindHelp` signal is true
> 2. Lists all actions from `defaultKeybinds` in `keybinds.ts`, grouped by category (tabs, splits, navigation, outliner, zoom)
> 3. Uses `formatKeybind()` for display
> 4. Closes on Escape or click-outside
>
> Add keybind: `{ key: '?', modifiers: { mod: true, shift: true }, action: 'showKeybindHelp' }` (Cmd+Shift+?)
>
> Reference: The keybinds are already categorized by comment blocks in keybinds.ts lines 96-147.

---

### 3. Split Keybind Platform Inconsistency

**Severity**: Minor
**Location**: `src/lib/keybinds.ts:121-122`
**Linear**: NEW

```typescript
{ key: isMac ? 'd' : '\\', modifiers: { mod: true }, action: 'splitHorizontal' },
```

Mac users get `Cmd+D`, Windows/Linux users get `Ctrl+\`. This isn't wrong (VS Code uses backslash), but it creates friction for cross-platform users who develop on Mac but deploy on Linux.

**Agent Prompt**:
> Consider unifying to `Cmd/Ctrl+D` across platforms in `keybinds.ts:121-122`:
> ```typescript
> { key: 'd', modifiers: { mod: true }, action: 'splitHorizontal' },
> { key: 'd', modifiers: { mod: true, shift: true }, action: 'splitVertical' },
> ```
> This matches iTerm2's behavior. The backslash was chosen to avoid VS Code's `Ctrl+D` (add cursor), but floatty isn't VS Code.
>
> **Alternative**: Keep both as valid bindings (duplicate entries with same action).

---

### 4. Pane Focus Requires 3 Keys

**Severity**: Minor
**Location**: `src/lib/keybinds.ts:128-131`
**Linear**: NEW

Focus navigation uses `Cmd+Opt+Arrow` — three simultaneous keys plus arrow direction. Heavy for frequent use.

tmux approach: `Prefix` then single key (`o` cycles, `hjkl` for directional).
VS Code approach: `Cmd+K Arrow` (chord).

For a power-user terminal, consider adding a single-key cycle option.

**Agent Prompt**:
> Add a `focusCycle` action that cycles through panes in order (like tmux `Prefix+o`):
>
> In `keybinds.ts`, add:
> ```typescript
> | 'focusCycle'
> // and
> { key: 'o', modifiers: { mod: true, shift: true }, action: 'focusCycle' }, // Cmd+Shift+O
> ```
>
> In `Terminal.tsx` handleKeydown, implement cycling through `getAllPaneIds()` order, wrapping at end.

---

### 5. Outliner Block Keybinds Not Surfaced

**Severity**: Minor
**Location**: UI (missing discoverability)
**Linear**: NEW (related to finding #2)

Block-level keybinds (`Cmd+.` collapse, `Cmd+Enter` zoom, `Cmd+Backspace` delete) are only in keybinds.ts, not surfaced anywhere. Users discover by accident or reading source.

This is partially addressed by finding #2 (keybind overlay). Additionally, the bullet affordance could hint at actions.

**Agent Prompt**:
> In `BlockItem.tsx`, add a tooltip to the bullet that shows available actions:
> ```tsx
> <div
>   class={`block-bullet ${bulletClass()}`}
>   title="Click to collapse • ⌘Enter zoom • ⌘⌫ delete"
>   ...
> >
> ```
> This provides inline discoverability without UI clutter.

---

## Priority Matrix

| Issue | Severity | Effort | Linear |
|-------|----------|--------|--------|
| StatusBar hardcoded keys | Major | Low | NEW |
| No keybind overlay | Major | Medium | NEW |
| Split keybind platform | Minor | Low | NEW |
| Pane focus 3 keys | Minor | Medium | NEW |
| Block keybinds hidden | Minor | Low | NEW |

**Effort key**: Low (< 30 min), Medium (few hours), High (day+)

---

## Open Questions

1. **Keybind overlay trigger**: Should it be `Cmd+?` (common), `Cmd+Shift+/` (same key, explicit), or `Cmd+K Cmd+S` (VS Code style)?

2. **Split keybind unification**: Does Evan use floatty on non-Mac? If not, platform consistency is low priority.

---

## Self-Verification Checklist

- [x] Linear checked for each recommendation (FLO-90 search excluded, no conflicts)
- [x] Code line claims validated via explorer agent
- [x] No accessibility recommendations (handled by build-time rules)
- [x] Output format correct (no table paragraphs)
- [x] Agent prompts are copy-paste ready with file paths and line numbers

---

*Review persisted. Next: create Linear issues for NEW findings or proceed to implementation.*
