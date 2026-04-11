/**
 * Keybind System - Platform-aware, customizable keyboard shortcuts
 *
 * Design principles:
 * 1. Use Cmd on macOS, Ctrl on Windows/Linux (the "mod" key)
 * 2. Never intercept Ctrl+C/Z/D (must reach PTY for signals)
 * 3. Avoid system-reserved combos (Cmd+H, Cmd+M, Cmd+Tab, etc.)
 * 4. Match platform conventions (Cmd+T for new tab on macOS)
 * 5. Customizable via config file (future: ~/.floatty/keybinds.toml)
 */

// Available actions that can be bound
export type KeyAction =
  | 'newTab'
  | 'closeTab'
  | 'nextTab'
  | 'prevTab'
  | 'goToTab1'
  | 'goToTab2'
  | 'goToTab3'
  | 'goToTab4'
  | 'goToTab5'
  | 'goToTab6'
  | 'goToTab7'
  | 'goToTab8'
  | 'goToTab9'
  | 'toggleSidebar'
  | 'togglePanel'
  | 'splitHorizontal'
  | 'splitVertical'
  | 'splitHorizontalOutliner'
  | 'splitVerticalOutliner'
  | 'closeSplit'
  | 'focusLeft'
  | 'focusRight'
  | 'focusUp'
  | 'focusDown'
  | 'zoomIn'
  | 'zoomOut'
  | 'zoomReset'
  | 'zoomInBlock'    // Outliner: focus on block subtree (Cmd+Enter at block level)
  | 'zoomOutBlock'   // Outliner: return to parent/full view (Escape at block level)
  | 'collapseBlock'  // Outliner: toggle block collapse (Cmd+. at block level)
  | 'deleteBlock'    // Outliner: delete block and subtree (Cmd+Backspace at block level)
  | 'moveBlockUp'    // FLO-75: Move block before previous sibling (Cmd+Up)
  | 'moveBlockDown'  // FLO-75: Move block after next sibling (Cmd+Down)
  | 'nextTheme'      // Cycle through available themes (Cmd+;)
  | 'undo'           // Undo last block operation (Cmd+Z)
  | 'redo'           // Redo last undone operation (Cmd+Shift+Z)
  | 'toggleDevVisuals'   // FLO-259: Toggle dev mode visual distinction (Cmd+Shift+D)
  | 'commandPalette'   // FLO-276: Command bar (Cmd+K)
  | 'focusPane';       // Letter overlay to jump to any pane (Cmd+J)

// Modifier representation
export interface Modifiers {
  mod?: boolean;    // Cmd on macOS, Ctrl on Windows/Linux
  ctrl?: boolean;   // Always Ctrl (use sparingly - conflicts with terminal)
  shift?: boolean;
  alt?: boolean;    // Option on macOS
}

export interface Keybind {
  key: string;      // e.g., 't', '1', '[', 'ArrowLeft'
  modifiers: Modifiers;
  action: KeyAction;
}

// Platform detection
export const isMac = typeof navigator !== 'undefined' &&
  (navigator.platform ? /Mac|iPod|iPhone|iPad/.test(navigator.platform) : false);

// Check if event matches a keybind
export function matchesKeybind(event: KeyboardEvent, bind: Keybind): boolean {
  // Check key (case-insensitive for letters)
  const eventKey = event.key.toLowerCase();
  const bindKey = bind.key.toLowerCase();
  if (eventKey !== bindKey) return false;

  // Check modifiers
  const { mod, ctrl, shift, alt } = bind.modifiers;

  // "mod" = metaKey on Mac, ctrlKey on others
  const modPressed = isMac ? event.metaKey : event.ctrlKey;
  if (mod && !modPressed) return false;
  if (!mod && modPressed) return false;

  // Explicit ctrl (rarely used - avoid in terminal apps)
  if (ctrl && !event.ctrlKey) return false;
  if (!ctrl && !mod && event.ctrlKey) return false;

  // Shift
  if (shift && !event.shiftKey) return false;
  if (!shift && event.shiftKey) return false;

  // Alt/Option
  if (alt && !event.altKey) return false;
  if (!alt && event.altKey) return false;

  return true;
}

// Default keybindings
export const defaultKeybinds: Keybind[] = [
  // Tab management
  { key: 't', modifiers: { mod: true }, action: 'newTab' },
  { key: 'w', modifiers: { mod: true }, action: 'closeTab' },
  { key: '[', modifiers: { mod: true, shift: true }, action: 'prevTab' },
  { key: ']', modifiers: { mod: true, shift: true }, action: 'nextTab' },

  // Go to tab N (Cmd+1 through Cmd+9)
  { key: '1', modifiers: { mod: true }, action: 'goToTab1' },
  { key: '2', modifiers: { mod: true }, action: 'goToTab2' },
  { key: '3', modifiers: { mod: true }, action: 'goToTab3' },
  { key: '4', modifiers: { mod: true }, action: 'goToTab4' },
  { key: '5', modifiers: { mod: true }, action: 'goToTab5' },
  { key: '6', modifiers: { mod: true }, action: 'goToTab6' },
  { key: '7', modifiers: { mod: true }, action: 'goToTab7' },
  { key: '8', modifiers: { mod: true }, action: 'goToTab8' },
  { key: '9', modifiers: { mod: true }, action: 'goToTab9' },

  // Sidebar (⌘\ — matches VS Code convention)
  { key: '\\', modifiers: { mod: true }, action: 'toggleSidebar' },

  // Floating panel (NSPanel spike)
  { key: 'p', modifiers: { mod: true, shift: true }, action: 'togglePanel' },

  // Split management
  { key: isMac ? 'd' : '\\', modifiers: { mod: true }, action: 'splitHorizontal' },
  { key: isMac ? 'd' : '\\', modifiers: { mod: true, shift: true }, action: 'splitVertical' },
  { key: 'o', modifiers: { mod: true }, action: 'splitHorizontalOutliner' },
  { key: 'o', modifiers: { mod: true, shift: true }, action: 'splitVerticalOutliner' },
  { key: 'w', modifiers: { mod: true, shift: true }, action: 'closeSplit' },

  // Focus navigation (future - using Alt to avoid terminal conflicts)
  { key: 'ArrowLeft', modifiers: { mod: true, alt: true }, action: 'focusLeft' },
  { key: 'ArrowRight', modifiers: { mod: true, alt: true }, action: 'focusRight' },
  { key: 'ArrowUp', modifiers: { mod: true, alt: true }, action: 'focusUp' },
  { key: 'ArrowDown', modifiers: { mod: true, alt: true }, action: 'focusDown' },

  // Zoom
  { key: '=', modifiers: { mod: true }, action: 'zoomIn' },
  { key: '+', modifiers: { mod: true }, action: 'zoomIn' },
  { key: '-', modifiers: { mod: true }, action: 'zoomOut' },
  { key: '0', modifiers: { mod: true }, action: 'zoomReset' },

  // Block-level actions (Outliner)
  { key: 'Enter', modifiers: { mod: true }, action: 'zoomInBlock' },
  { key: 'Escape', modifiers: {}, action: 'zoomOutBlock' },
  { key: '.', modifiers: { mod: true }, action: 'collapseBlock' },
  { key: 'Backspace', modifiers: { mod: true }, action: 'deleteBlock' },
  // FLO-75: Block movement (Cmd+Up/Down)
  { key: 'ArrowUp', modifiers: { mod: true }, action: 'moveBlockUp' },
  { key: 'ArrowDown', modifiers: { mod: true }, action: 'moveBlockDown' },

  // Theme (using ; to avoid conflict with command palette Cmd+K)
  { key: ';', modifiers: { mod: true }, action: 'nextTheme' },

  // Undo/Redo (outliner operations)
  { key: 'z', modifiers: { mod: true }, action: 'undo' },
  { key: 'z', modifiers: { mod: true, shift: true }, action: 'redo' },

  // Dev mode visuals (FLO-259) — Ctrl+Shift+D (not mod+shift to avoid splitVertical conflict)
  { key: 'd', modifiers: { ctrl: true, shift: true }, action: 'toggleDevVisuals' },

  // Command palette (FLO-276) — Cmd+K (intentionally reserved, see line 153 comment)
  { key: 'k', modifiers: { mod: true }, action: 'commandPalette' },

  // Focus pane overlay — Cmd+J (Jump)
  { key: 'j', modifiers: { mod: true }, action: 'focusPane' },
];

// Find action for a keyboard event
export function getActionForEvent(event: KeyboardEvent, binds: Keybind[] = defaultKeybinds): KeyAction | null {
  for (const bind of binds) {
    if (matchesKeybind(event, bind)) {
      return bind.action;
    }
  }
  return null;
}

/**
 * Actions owned by Terminal's global capture listener.
 * Outliner-local actions are intentionally excluded and handled in Outliner.tsx.
 */
export const GLOBAL_KEY_ACTIONS: ReadonlySet<KeyAction> = new Set<KeyAction>([
  'newTab',
  'closeTab',
  'nextTab',
  'prevTab',
  'goToTab1',
  'goToTab2',
  'goToTab3',
  'goToTab4',
  'goToTab5',
  'goToTab6',
  'goToTab7',
  'goToTab8',
  'goToTab9',
  'toggleSidebar',
  'togglePanel',
  'splitHorizontal',
  'splitVertical',
  'splitHorizontalOutliner',
  'splitVerticalOutliner',
  'closeSplit',
  'focusLeft',
  'focusRight',
  'focusUp',
  'focusDown',
  'zoomIn',
  'zoomOut',
  'zoomReset',
  'nextTheme',
  'toggleDevVisuals',
  'commandPalette',
  'focusPane',
]);

/** True if the action should be handled by Terminal's global capture listener. */
export function isGlobalKeyAction(action: KeyAction): boolean {
  return GLOBAL_KEY_ACTIONS.has(action);
}

// Format keybind for display (e.g., "⌘T" or "Ctrl+T")
export function formatKeybind(bind: Keybind): string {
  const parts: string[] = [];

  if (bind.modifiers.mod) {
    parts.push(isMac ? '⌘' : 'Ctrl');
  }
  if (bind.modifiers.ctrl) {
    parts.push('Ctrl');
  }
  if (bind.modifiers.shift) {
    parts.push(isMac ? '⇧' : 'Shift');
  }
  if (bind.modifiers.alt) {
    parts.push(isMac ? '⌥' : 'Alt');
  }

  // Format key nicely
  let keyDisplay = bind.key;
  if (bind.key === '[') keyDisplay = '[';
  if (bind.key === ']') keyDisplay = ']';
  if (bind.key.startsWith('Arrow')) keyDisplay = bind.key.replace('Arrow', '');
  if (bind.key.length === 1) keyDisplay = bind.key.toUpperCase();

  parts.push(keyDisplay);

  return isMac ? parts.join('') : parts.join('+');
}

// Get display string for an action (for tooltips, menus)
export function getKeybindDisplay(action: KeyAction, binds: Keybind[] = defaultKeybinds): string | null {
  const bind = binds.find(b => b.action === action);
  return bind ? formatKeybind(bind) : null;
}

/**
 * Keys that should NEVER be intercepted - must reach the terminal
 * These are control characters that shells and programs depend on
 */
export const TERMINAL_RESERVED_KEYS = [
  // Signals
  { key: 'c', ctrl: true },  // SIGINT
  { key: 'z', ctrl: true },  // SIGTSTP
  { key: '\\', ctrl: true }, // SIGQUIT
  // Control chars
  { key: 'd', ctrl: true },  // EOF
  { key: 'l', ctrl: true },  // Clear (let terminal handle)
  { key: 'r', ctrl: true },  // Reverse search in bash
  { key: 'a', ctrl: true },  // Beginning of line
  { key: 'e', ctrl: true },  // End of line
  { key: 'k', ctrl: true },  // Kill to end of line
  { key: 'u', ctrl: true },  // Kill to beginning of line
  { key: 'w', ctrl: true },  // Kill word backward
];

export function isTerminalReserved(event: KeyboardEvent): boolean {
  if (!event.ctrlKey) return false;
  // Allow Shift/Alt/Meta combos to pass through (e.g. Ctrl+Shift+C for copy)
  if (event.shiftKey || event.altKey || event.metaKey) return false;

  const key = event.key.toLowerCase();
  return TERMINAL_RESERVED_KEYS.some(r => r.key === key && r.ctrl);
}
