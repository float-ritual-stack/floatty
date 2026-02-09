/**
 * Theme registry and exports
 */

export type { FloattyTheme, AnsiColors } from './types';
export { toXtermTheme, applyThemeToCSS, applyDevModeOverride } from './types';

export { defaultTheme } from './default';
export { draculaTheme } from './dracula';
export { nordTheme } from './nord';
export { tokyoNightTheme } from './tokyoNight';
export { matteBlackTheme } from './matteBlack';

import { defaultTheme } from './default';
import { draculaTheme } from './dracula';
import { nordTheme } from './nord';
import { tokyoNightTheme } from './tokyoNight';
import { matteBlackTheme } from './matteBlack';
import type { FloattyTheme } from './types';

/**
 * All available themes indexed by name
 */
export const themes: Record<string, FloattyTheme> = {
  default: defaultTheme,
  dracula: draculaTheme,
  nord: nordTheme,
  tokyoNight: tokyoNightTheme,
  matteBlack: matteBlackTheme,
};

/**
 * List of theme names for UI selection
 */
export const themeNames = Object.keys(themes);

/**
 * Get theme by name, falling back to default
 */
export function getTheme(name: string): FloattyTheme {
  return themes[name] ?? defaultTheme;
}
