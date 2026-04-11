/**
 * Default floatty theme - the original dark navy aesthetic
 */

import type { FloattyTheme } from './types';

export const defaultTheme: FloattyTheme = {
  name: 'default',
  displayName: 'Float Dark',

  // Base colors
  bg: '#1a1a2e',
  bgDark: '#0f0f1a',
  bgLight: '#24243e',
  fg: '#eaeaea',
  fgMuted: '#8b8b8b',
  border: '#2a2a4a',

  // Accent colors
  accent: '#7c3aed',
  accentMuted: '#5a5a8a',

  // Semantic colors
  error: '#ef4444',
  success: '#22c55e',
  warning: '#eab308',
  info: '#06b6d4',

  // Selection
  selection: '#4a4a7a',

  // Terminal ANSI palette
  ansi: {
    black: '#1a1a2e',
    red: '#ef4444',
    green: '#22c55e',
    yellow: '#eab308',
    blue: '#3b82f6',
    magenta: '#7c3aed',
    cyan: '#06b6d4',
    white: '#eaeaea',
    brightBlack: '#8b8b8b',
    brightRed: '#f87171',
    brightGreen: '#4ade80',
    brightYellow: '#fde047',
    brightBlue: '#60a5fa',
    brightMagenta: '#a78bfa',
    brightCyan: '#22d3ee',
    brightWhite: '#ffffff',
  },
};
