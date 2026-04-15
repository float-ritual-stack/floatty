/**
 * Theme type definitions for floatty
 *
 * Themes define colors for both UI chrome and terminal ANSI palette.
 * CSS variables are set at :root, xterm theme is passed to terminal instances.
 */

export interface AnsiColors {
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export interface FloattyTheme {
  name: string;
  displayName: string;

  // Base colors
  bg: string;           // Main background
  bgDark: string;       // Darker background (tab bar, status)
  bgLight: string;      // Lighter background (sidebar, active pane)
  bgSecondary: string;  // Card/panel background (door tag bg, nested surfaces)
  bgHover: string;      // Hover state background
  fg: string;           // Primary text
  fgMuted: string;      // Secondary/muted text
  fgDimmed: string;     // Dimmed text (placeholders, tertiary info)
  border: string;       // Borders and dividers

  // Accent colors
  accent: string;       // Primary accent (purple in default)
  accentMuted: string;  // Muted accent for hover states

  // Semantic colors
  error: string;
  success: string;
  warning: string;
  info: string;

  // Selection
  selection: string;    // Text selection background

  // Reader typography (FLO-625)
  // Controls max reading column width, body line-height, and warm text color
  // for comfortable long-form reading in outliner + door output.
  textPrimary: string;      // Warm body text color (separate from fg which can be brighter)
  contentMaxWidth: string;  // e.g. "720px" — reading column width
  bodyLineHeight: string;   // e.g. "1.6" — body text line-height

  // Terminal ANSI palette
  ansi: AnsiColors;
}

/**
 * Convert theme to xterm.js theme object
 */
export function toXtermTheme(theme: FloattyTheme) {
  return {
    background: theme.bg,
    foreground: theme.fg,
    cursor: theme.fg,
    cursorAccent: theme.bg,
    selectionBackground: theme.selection,
    ...theme.ansi,
  };
}

/**
 * Toggle diagnostics strip visibility.
 * Adds/removes `.diagnostics-visible` class on body to show/hide diagnostic items.
 */
export function setDiagnosticsVisible(enabled: boolean) {
  if (enabled) {
    document.body.classList.add('diagnostics-visible');
  } else {
    document.body.classList.remove('diagnostics-visible');
  }
}

/**
 * Apply theme to document CSS variables
 */
export function applyThemeToCSS(theme: FloattyTheme) {
  const root = document.documentElement;

  // Base colors
  root.style.setProperty('--color-bg', theme.bg);
  root.style.setProperty('--color-bg-dark', theme.bgDark);
  root.style.setProperty('--color-bg-light', theme.bgLight);
  root.style.setProperty('--color-bg-secondary', theme.bgSecondary);
  root.style.setProperty('--color-bg-hover', theme.bgHover);
  root.style.setProperty('--color-fg', theme.fg);
  root.style.setProperty('--color-fg-muted', theme.fgMuted);
  root.style.setProperty('--color-fg-dimmed', theme.fgDimmed);
  root.style.setProperty('--color-border', theme.border);

  // Reader typography (FLO-625)
  root.style.setProperty('--text-primary', theme.textPrimary);
  root.style.setProperty('--content-max-width', theme.contentMaxWidth);
  root.style.setProperty('--body-line-height', theme.bodyLineHeight);

  // Accent
  root.style.setProperty('--color-accent', theme.accent);
  root.style.setProperty('--color-accent-muted', theme.accentMuted);

  // Semantic
  root.style.setProperty('--color-error', theme.error);
  root.style.setProperty('--color-success', theme.success);
  root.style.setProperty('--color-warning', theme.warning);
  root.style.setProperty('--color-info', theme.info);

  // Selection
  root.style.setProperty('--color-selection', theme.selection);

  // ANSI colors (for block bullets and other UI elements)
  root.style.setProperty('--color-ansi-black', theme.ansi.black);
  root.style.setProperty('--color-ansi-red', theme.ansi.red);
  root.style.setProperty('--color-ansi-green', theme.ansi.green);
  root.style.setProperty('--color-ansi-yellow', theme.ansi.yellow);
  root.style.setProperty('--color-ansi-blue', theme.ansi.blue);
  root.style.setProperty('--color-ansi-magenta', theme.ansi.magenta);
  root.style.setProperty('--color-ansi-cyan', theme.ansi.cyan);
  root.style.setProperty('--color-ansi-white', theme.ansi.white);
  root.style.setProperty('--color-ansi-bright-black', theme.ansi.brightBlack);
  root.style.setProperty('--color-ansi-bright-red', theme.ansi.brightRed);
  root.style.setProperty('--color-ansi-bright-green', theme.ansi.brightGreen);
  root.style.setProperty('--color-ansi-bright-yellow', theme.ansi.brightYellow);
  root.style.setProperty('--color-ansi-bright-blue', theme.ansi.brightBlue);
  root.style.setProperty('--color-ansi-bright-magenta', theme.ansi.brightMagenta);
  root.style.setProperty('--color-ansi-bright-cyan', theme.ansi.brightCyan);
  root.style.setProperty('--color-ansi-bright-white', theme.ansi.brightWhite);
}
