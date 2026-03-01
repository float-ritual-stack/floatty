/**
 * Plugin Loader
 *
 * Scans the plugins directory, imports plugin modules, validates manifests,
 * and registers handlers/hooks/views/styles.
 *
 * Two loading modes:
 * 1. **Bundled plugins** (src/plugins/*): Statically imported, always available
 * 2. **User plugins** (~/.floatty/plugins/*): Dynamically loaded from filesystem
 *
 * Bundled plugins are loaded first and serve as the reference implementation
 * for the plugin API. User plugins can override bundled ones by using the same ID.
 */

import { registry } from '../handlers/registry';
import { hookRegistry } from '../hooks/hookRegistry';
import { registerView, unregisterView } from './viewRegistry';
import type { FloattyPlugin, LoadedPlugin, PluginAPI } from './types';

// ═══════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════

const loadedPlugins = new Map<string, LoadedPlugin>();

// ═══════════════════════════════════════════════════════════════
// VALIDATION
// ═══════════════════════════════════════════════════════════════

/**
 * Validate that a plugin manifest has the required shape.
 * Returns error message if invalid, null if valid.
 */
export function validatePlugin(plugin: unknown): string | null {
  if (!plugin || typeof plugin !== 'object') {
    return 'Plugin must be a non-null object';
  }

  const p = plugin as Record<string, unknown>;

  if (typeof p.id !== 'string' || !p.id.trim()) {
    return 'Plugin must have a non-empty string "id"';
  }

  if (typeof p.name !== 'string' || !p.name.trim()) {
    return 'Plugin must have a non-empty string "name"';
  }

  if (typeof p.version !== 'string' || !p.version.trim()) {
    return 'Plugin must have a non-empty string "version"';
  }

  // Validate handlers array if present
  if (p.handlers !== undefined) {
    if (!Array.isArray(p.handlers)) {
      return '"handlers" must be an array';
    }
    for (let i = 0; i < p.handlers.length; i++) {
      const h = p.handlers[i] as Record<string, unknown>;
      if (!Array.isArray(h.prefixes) || h.prefixes.length === 0) {
        return `handlers[${i}] must have a non-empty "prefixes" array`;
      }
      if (typeof h.execute !== 'function') {
        return `handlers[${i}] must have an "execute" function`;
      }
    }
  }

  // Validate hooks array if present
  if (p.hooks !== undefined) {
    if (!Array.isArray(p.hooks)) {
      return '"hooks" must be an array';
    }
    for (let i = 0; i < p.hooks.length; i++) {
      const h = p.hooks[i] as Record<string, unknown>;
      if (typeof h.id !== 'string') {
        return `hooks[${i}] must have a string "id"`;
      }
      if (typeof h.handler !== 'function') {
        return `hooks[${i}] must have a "handler" function`;
      }
    }
  }

  // Validate views object if present
  if (p.views !== undefined) {
    if (typeof p.views !== 'object' || p.views === null) {
      return '"views" must be an object';
    }
    for (const [key, val] of Object.entries(p.views as Record<string, unknown>)) {
      if (typeof val !== 'function') {
        return `views["${key}"] must be a component function`;
      }
    }
  }

  // Validate styles if present
  if (p.styles !== undefined && typeof p.styles !== 'string') {
    return '"styles" must be a string';
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════
// PLUGIN API FACTORY
// ═══════════════════════════════════════════════════════════════

/**
 * Create the PluginAPI sandbox for a plugin.
 * Tracks registrations so they can be torn down on unload.
 */
function createPluginAPI(pluginId: string, loaded: LoadedPlugin): PluginAPI {
  const prefix = `[plugin:${pluginId}]`;

  return {
    registerHandler(handler) {
      registry.register(handler);
      loaded.handlerPrefixes.push(...handler.prefixes);
    },

    registerHook(hook) {
      hookRegistry.register(hook);
      loaded.hookIds.push(hook.id);
    },

    registerView(outputType, component) {
      registerView(outputType, component);
      loaded.viewTypes.push(outputType);
    },

    log: (...args: unknown[]) => console.log(prefix, ...args),
    warn: (...args: unknown[]) => console.warn(prefix, ...args),
    error: (...args: unknown[]) => console.error(prefix, ...args),
  };
}

// ═══════════════════════════════════════════════════════════════
// LOAD / UNLOAD
// ═══════════════════════════════════════════════════════════════

/**
 * Load and activate a single plugin.
 *
 * If a plugin with the same ID is already loaded, it is unloaded first
 * (allows user plugins to override bundled ones).
 */
export async function loadPlugin(plugin: FloattyPlugin): Promise<void> {
  // Validate
  const error = validatePlugin(plugin);
  if (error) {
    console.error(`[pluginLoader] Invalid plugin "${plugin.id ?? '?'}": ${error}`);
    return;
  }

  // Unload existing if re-loading (HMR or user override)
  if (loadedPlugins.has(plugin.id)) {
    console.log(`[pluginLoader] Replacing existing plugin "${plugin.id}"`);
    unloadPlugin(plugin.id);
  }

  console.log(`[pluginLoader] Loading plugin "${plugin.id}" v${plugin.version}`);

  // Track registrations for teardown
  const loaded: LoadedPlugin = {
    plugin,
    handlerPrefixes: [],
    hookIds: [],
    viewTypes: [],
    styleElement: null,
  };

  // Register handlers
  if (plugin.handlers) {
    for (const handler of plugin.handlers) {
      try {
        registry.register(handler);
        loaded.handlerPrefixes.push(...handler.prefixes);
      } catch (err) {
        console.error(`[pluginLoader] Failed to register handler for "${plugin.id}":`, err);
      }
    }
  }

  // Register hooks
  if (plugin.hooks) {
    for (const hook of plugin.hooks) {
      try {
        hookRegistry.register(hook);
        loaded.hookIds.push(hook.id);
      } catch (err) {
        console.error(`[pluginLoader] Failed to register hook "${hook.id}" for "${plugin.id}":`, err);
      }
    }
  }

  // Register views
  if (plugin.views) {
    for (const [outputType, component] of Object.entries(plugin.views)) {
      registerView(outputType, component);
      loaded.viewTypes.push(outputType);
    }
  }

  // Inject styles
  if (plugin.styles) {
    const style = document.createElement('style');
    style.setAttribute('data-plugin', plugin.id);
    style.textContent = plugin.styles;
    document.head.appendChild(style);
    loaded.styleElement = style;
  }

  loadedPlugins.set(plugin.id, loaded);

  // Activate (after everything is registered)
  if (plugin.activate) {
    try {
      const api = createPluginAPI(plugin.id, loaded);
      await plugin.activate(api);
    } catch (err) {
      console.error(`[pluginLoader] Plugin "${plugin.id}" activation failed:`, err);
    }
  }

  console.log(
    `[pluginLoader] Plugin "${plugin.id}" loaded:`,
    `${loaded.handlerPrefixes.length} handler(s),`,
    `${loaded.hookIds.length} hook(s),`,
    `${loaded.viewTypes.length} view(s)`
  );
}

/**
 * Unload a plugin by ID. Tears down all registrations.
 */
export function unloadPlugin(pluginId: string): boolean {
  const loaded = loadedPlugins.get(pluginId);
  if (!loaded) return false;

  console.log(`[pluginLoader] Unloading plugin "${pluginId}"`);

  // Deactivate
  if (loaded.plugin.deactivate) {
    try {
      loaded.plugin.deactivate();
    } catch (err) {
      console.error(`[pluginLoader] Plugin "${pluginId}" deactivation failed:`, err);
    }
  }

  // Unregister hooks
  for (const hookId of loaded.hookIds) {
    hookRegistry.unregister(hookId);
  }

  // Unregister views
  for (const outputType of loaded.viewTypes) {
    unregisterView(outputType);
  }

  // Remove injected styles
  if (loaded.styleElement) {
    loaded.styleElement.remove();
  }

  // Note: HandlerRegistry doesn't support unregister by prefix yet.
  // For now, handlers persist until full registry clear (HMR).
  // This is acceptable — nvim plugins also persist until restart.

  loadedPlugins.delete(pluginId);
  return true;
}

/**
 * Load multiple plugins in sequence.
 * Errors in one plugin don't prevent others from loading.
 */
export async function loadPlugins(plugins: FloattyPlugin[]): Promise<void> {
  for (const plugin of plugins) {
    try {
      await loadPlugin(plugin);
    } catch (err) {
      console.error(`[pluginLoader] Failed to load plugin "${plugin.id ?? '?'}":`, err);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// QUERY
// ═══════════════════════════════════════════════════════════════

/** Get all loaded plugin IDs */
export function getLoadedPluginIds(): string[] {
  return Array.from(loadedPlugins.keys());
}

/** Check if a plugin is loaded */
export function isPluginLoaded(pluginId: string): boolean {
  return loadedPlugins.has(pluginId);
}

/** Get loaded plugin state (for debugging) */
export function getLoadedPlugin(pluginId: string): LoadedPlugin | undefined {
  return loadedPlugins.get(pluginId);
}

// ═══════════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════════

/** Unload all plugins (for HMR or shutdown) */
export function unloadAllPlugins(): void {
  for (const pluginId of Array.from(loadedPlugins.keys())) {
    unloadPlugin(pluginId);
  }
}
