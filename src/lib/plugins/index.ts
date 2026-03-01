/**
 * Plugin System
 *
 * Public API for floatty's plugin architecture.
 *
 * Plugins are loaded from two sources:
 * 1. Bundled plugins (src/plugins/*) — shipped with the app
 * 2. User plugins (~/.floatty/plugins/*) — user-installed
 *
 * @module plugins
 * @see docs/architecture/PLUGIN_SYSTEM.md
 */

// Types (for plugin authors)
export type {
  FloattyPlugin,
  PluginAPI,
  OutputViewProps,
  LoadedPlugin,
} from './types';

// View registry (for BlockItem.tsx)
export {
  registerView,
  getView,
  hasView,
  getRegisteredViewTypes,
  clearViews,
} from './viewRegistry';

// Plugin loader
export {
  loadPlugin,
  loadPlugins,
  unloadPlugin,
  unloadAllPlugins,
  getLoadedPluginIds,
  isPluginLoaded,
  validatePlugin,
} from './pluginLoader';
