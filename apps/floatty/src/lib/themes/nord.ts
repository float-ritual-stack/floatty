/**
 * Nord theme - https://www.nordtheme.com/
 */

import type { FloattyTheme } from './types';

export const nordTheme: FloattyTheme = {
  name: 'nord',
  displayName: 'Nord',

  // Base colors (Polar Night)
  bg: '#2e3440',
  bgDark: '#242933',
  bgLight: '#3b4252',
  bgSecondary: '#353c4a',
  bgHover: '#434c5e',
  fg: '#eceff4',
  fgMuted: '#d8dee9',
  fgDimmed: '#7b8499',
  border: '#4c566a',

  // Accent colors (Frost)
  accent: '#88c0d0',
  accentMuted: '#81a1c1',

  // Semantic colors (Aurora)
  error: '#bf616a',
  success: '#a3be8c',
  warning: '#ebcb8b',
  info: '#5e81ac',

  // Selection
  selection: '#434c5e',

  // Reader typography (FLO-625) — Snow Storm 2, between fg (SS3) and fgMuted (SS1)
  // so body text stays distinct from both muted secondary and primary fg.
  textPrimary: '#e5e9f0',
  contentMaxWidth: '720px',
  bodyLineHeight: '1.6',

  // Terminal ANSI palette
  ansi: {
    black: '#3b4252',
    red: '#bf616a',
    green: '#a3be8c',
    yellow: '#ebcb8b',
    blue: '#81a1c1',
    magenta: '#b48ead',
    cyan: '#88c0d0',
    white: '#e5e9f0',
    brightBlack: '#4c566a',
    brightRed: '#bf616a',
    brightGreen: '#a3be8c',
    brightYellow: '#ebcb8b',
    brightBlue: '#81a1c1',
    brightMagenta: '#b48ead',
    brightCyan: '#8fbcbb',
    brightWhite: '#eceff4',
  },
};
