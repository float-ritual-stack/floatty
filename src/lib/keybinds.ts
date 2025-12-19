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
  | 'splitHorizontal'
  | 'splitVertical'
  | 'closeSplit'
  | 'focusLeft'
  | 'focusRight'
  | 'focusUp'
  | 'focusDown';

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
export const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);

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

  // Sidebar
  { key: 'b', modifiers: { mod: true }, action: 'toggleSidebar' },

  // Split management (future)
  { key: 'd', modifiers: { mod: true }, action: 'splitHorizontal' },
  { key: 'd', modifiers: { mod: true, shift: true }, action: 'splitVertical' },
  { key: 'w', modifiers: { mod: true, shift: true }, action: 'closeSplit' },

  // Focus navigation (future - using Alt to avoid terminal conflicts)
  { key: 'ArrowLeft', modifiers: { mod: true, alt: true }, action: 'focusLeft' },
  { key: 'ArrowRight', modifiers: { mod: true, alt: true }, action: 'focusRight' },
  { key: 'ArrowUp', modifiers: { mod: true, alt: true }, action: 'focusUp' },
  { key: 'ArrowDown', modifiers: { mod: true, alt: true }, action: 'focusDown' },
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
  const key = event.key.toLowerCase();
  return TERMINAL_RESERVED_KEYS.some(r => r.key === key && r.ctrl);
}
