/**
 * Matte Black theme
 * Inspired by https://github.com/tahayvr/matte-black-theme
 * True black with subtle warm grays and orange accent
 */

import type { FloattyTheme } from './types';

export const matteBlackTheme: FloattyTheme = {
  name: 'matteBlack',
  displayName: 'Matte Black',

  // Base colors - true black with warm grays
  bg: '#0a0a0a',
  bgDark: '#000000',
  bgLight: '#1a1a1a',
  bgSecondary: '#141414',
  bgHover: '#222222',
  fg: '#e0e0e0',
  fgMuted: '#6e6e6e',
  fgDimmed: '#4a4a4a',
  border: '#2a2a2a',

  // Accent colors - warm orange
  accent: '#ff9e64',
  accentMuted: '#805030',

  // Semantic colors
  error: '#ff5555',
  success: '#50fa7b',
  warning: '#ffb86c',
  info: '#8be9fd',

  // Selection
  selection: '#3a3a3a',

  // Reader typography (FLO-625)
  textPrimary: '#d0cbc2',
  contentMaxWidth: '720px',
  bodyLineHeight: '1.6',

  // ANSI 16-color palette
  ansi: {
    black: '#000000',
    red: '#ff5555',
    green: '#50fa7b',
    yellow: '#f1fa8c',
    blue: '#6272a4',
    magenta: '#ff79c6',
    cyan: '#8be9fd',
    white: '#e0e0e0',
    brightBlack: '#6e6e6e',
    brightRed: '#ff6e6e',
    brightGreen: '#69ff94',
    brightYellow: '#ffffa5',
    brightBlue: '#d6acff',
    brightMagenta: '#ff92df',
    brightCyan: '#a4ffff',
    brightWhite: '#ffffff',
  },
};
