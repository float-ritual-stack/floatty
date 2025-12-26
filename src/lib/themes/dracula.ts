/**
 * Dracula theme - https://draculatheme.com/
 */

import type { FloattyTheme } from './types';

export const draculaTheme: FloattyTheme = {
  name: 'dracula',
  displayName: 'Dracula',

  // Base colors
  bg: '#282a36',
  bgDark: '#21222c',
  bgLight: '#44475a',
  fg: '#f8f8f2',
  fgMuted: '#6272a4',
  border: '#44475a',

  // Accent colors
  accent: '#bd93f9',
  accentMuted: '#6272a4',

  // Semantic colors
  error: '#ff5555',
  success: '#50fa7b',
  warning: '#f1fa8c',
  info: '#8be9fd',

  // Selection
  selection: '#44475a',

  // Terminal ANSI palette
  ansi: {
    black: '#21222c',
    red: '#ff5555',
    green: '#50fa7b',
    yellow: '#f1fa8c',
    blue: '#bd93f9',
    magenta: '#ff79c6',
    cyan: '#8be9fd',
    white: '#f8f8f2',
    brightBlack: '#6272a4',
    brightRed: '#ff6e6e',
    brightGreen: '#69ff94',
    brightYellow: '#ffffa5',
    brightBlue: '#d6acff',
    brightMagenta: '#ff92df',
    brightCyan: '#a4ffff',
    brightWhite: '#ffffff',
  },
};
