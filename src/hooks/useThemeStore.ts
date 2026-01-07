/**
 * Theme Store - SolidJS store for theme management
 *
 * Manages current theme selection, applies CSS variables,
 * and syncs with terminal instances.
 */

import { createSignal, createRoot } from 'solid-js';
import { invoke } from '../lib/tauriTypes';
import {
  getTheme,
  themeNames,
  applyThemeToCSS,
  toXtermTheme,
  type FloattyTheme,
} from '../lib/themes';
import { terminalManager } from '../lib/terminalManager';

function createThemeStore() {
  const [currentThemeName, setCurrentThemeName] = createSignal<string>('default');
  const [isLoaded, setIsLoaded] = createSignal(false);

  /**
   * Get the current theme object
   */
  const currentTheme = () => getTheme(currentThemeName());

  /**
   * Apply theme to CSS and all terminal instances
   */
  const applyTheme = (theme: FloattyTheme) => {
    // Apply CSS variables
    applyThemeToCSS(theme);

    // Update all terminal instances
    const xtermTheme = toXtermTheme(theme);
    terminalManager.updateAllThemes(xtermTheme);
  };

  /**
   * Set theme by name and apply it
   */
  const setTheme = async (themeName: string) => {
    if (!themeNames.includes(themeName)) {
      console.warn(`[ThemeStore] Unknown theme: ${themeName}, using default`);
      themeName = 'default';
    }

    const theme = getTheme(themeName);
    setCurrentThemeName(themeName);
    applyTheme(theme);

    // Persist to config.toml
    try {
      await invoke('set_theme', { theme: themeName });
    } catch (err) {
      console.error('[ThemeStore] Failed to save theme preference:', err);
    }
  };

  /**
   * Cycle to next theme
   */
  const nextTheme = () => {
    const currentIndex = themeNames.indexOf(currentThemeName());
    const nextIndex = (currentIndex + 1) % themeNames.length;
    setTheme(themeNames[nextIndex]);
  };

  /**
   * Load theme from config on startup
   */
  const loadTheme = async () => {
    try {
      const savedTheme = await invoke<string>('get_theme');
      if (savedTheme && themeNames.includes(savedTheme)) {
        setCurrentThemeName(savedTheme);
      }
    } catch (err) {
      console.warn('[ThemeStore] Failed to load theme from config:', err);
    }

    // Apply current theme (default or loaded)
    applyTheme(currentTheme());
    setIsLoaded(true);
  };

  return {
    // State (reactive)
    currentThemeName,
    currentTheme,
    isLoaded,
    // Actions
    setTheme,
    nextTheme,
    loadTheme,
    // Constants
    availableThemes: themeNames,
  };
}

// Create singleton store
export const themeStore = createRoot(createThemeStore);
