# Floatty UX Review

**Date**: 2025-12-28 @ 08:04 PM
**Focus**: Keyboard UX
**Depth**: quick
**Review ID**: 2025-12-28-keyboard-quick-a7f3

## Scope

**In scope**: Keybind system, keyboard navigation, shortcut discoverability
**Out of scope**: Deep component breakdown (quick depth)
**Previous reviews**: None (first review)
**Linear issues checked**: 50 issues scanned, 4 keyboard-related tracked

---

## Executive Summary

1. **StatusBar shortcuts hardcoded** — Uses literal `⌘D`, `⌘O` instead of `getKeybindDisplay()`, will break on non-macOS platforms
2. **No keybind discoverability overlay** — Power users can't see all available shortcuts at once; StatusBar shows only 5 of 25+ bindings
3. **Split keybind platform inconsistency** — `Cmd+D` on macOS but `Ctrl+\` on Windows (line 121 keybinds.ts), may confuse cross-platform users
4. **Missing `focusPrev`/`focusNext` for outliner blocks** — Arrow keys navigate within outliner, but no keybind for cycling focus between panes via keyboard (only `Cmd+Opt+Arrow` which requires 3 keys)
5. **FLO-90 covers search** — Block fuzzy find already tracked, skip recommending

---

*Quick review complete. For deeper analysis including agent prompts and priority matrix, run `/floatty:ux-review keyboard balanced`.*
