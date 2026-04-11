/**
 * Tokyo Night theme
 * https://github.com/folke/tokyonight.nvim
 */

import type { FloattyTheme } from './types';

export const tokyoNightTheme: FloattyTheme = {
  name: 'tokyoNight',
  displayName: 'Tokyo Night',

  // Base colors
  bg: '#1a1b26',
  bgDark: '#15161e',
  bgLight: '#24283b',
  fg: '#c0caf5',
  fgMuted: '#565f89',
  border: '#3b4261',

  // Accent colors
  accent: '#7aa2f7',
  accentMuted: '#565f89',

  // Semantic colors
  error: '#f7768e',
  success: '#9ece6a',
  warning: '#e0af68',
  info: '#7dcfff',

  // Selection
  selection: '#33467c',

  // ANSI 16-color palette
  ansi: {
    black: '#15161e',
    red: '#f7768e',
    green: '#9ece6a',
    yellow: '#e0af68',
    blue: '#7aa2f7',
    magenta: '#bb9af7',
    cyan: '#7dcfff',
    white: '#a9b1d6',
    brightBlack: '#414868',
    brightRed: '#ff899d',
    brightGreen: '#9fe044',
    brightYellow: '#faba4a',
    brightBlue: '#8db0ff',
    brightMagenta: '#c7a9ff',
    brightCyan: '#a4daff',
    brightWhite: '#c0caf5',
  },
};
