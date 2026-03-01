/**
 * Plugin Loader Tests
 *
 * Tests plugin validation, loading, unloading, and the view registry.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  validatePlugin,
  loadPlugin,
  unloadPlugin,
  unloadAllPlugins,
  getLoadedPluginIds,
  isPluginLoaded,
} from './pluginLoader';
import {
  getView,
  hasView,
  getRegisteredViewTypes,
  clearViews,
} from './viewRegistry';
import { registry } from '../handlers/registry';
import { hookRegistry } from '../hooks/hookRegistry';
import type { FloattyPlugin } from './types';

// ═══════════════════════════════════════════════════════════════
// TEST FIXTURES
// ═══════════════════════════════════════════════════════════════

function createMinimalPlugin(overrides: Partial<FloattyPlugin> = {}): FloattyPlugin {
  return {
    id: 'test-plugin',
    name: 'Test Plugin',
    version: '1.0.0',
    ...overrides,
  };
}

function createFullPlugin(): FloattyPlugin {
  return {
    id: 'full-plugin',
    name: 'Full Plugin',
    version: '2.0.0',
    handlers: [
      {
        prefixes: ['test::'],
        execute: async () => {},
      },
    ],
    hooks: [
      {
        id: 'test-hook',
        event: 'execute:before',
        filter: () => true,
        priority: 50,
        handler: () => ({}),
      },
    ],
    views: {
      'test-view': () => null,
    },
    styles: '.test { color: red; }',
  };
}

// ═══════════════════════════════════════════════════════════════
// SETUP / TEARDOWN
// ═══════════════════════════════════════════════════════════════

beforeEach(() => {
  registry.clear();
  hookRegistry.clear();
  clearViews();
  unloadAllPlugins();
});

afterEach(() => {
  registry.clear();
  hookRegistry.clear();
  clearViews();
  unloadAllPlugins();
});

// ═══════════════════════════════════════════════════════════════
// VALIDATION
// ═══════════════════════════════════════════════════════════════

describe('validatePlugin', () => {
  it('accepts a valid minimal plugin', () => {
    expect(validatePlugin(createMinimalPlugin())).toBeNull();
  });

  it('accepts a valid full plugin', () => {
    expect(validatePlugin(createFullPlugin())).toBeNull();
  });

  it('rejects null', () => {
    expect(validatePlugin(null)).toBe('Plugin must be a non-null object');
  });

  it('rejects non-object', () => {
    expect(validatePlugin('string')).toBe('Plugin must be a non-null object');
  });

  it('rejects missing id', () => {
    expect(validatePlugin({ name: 'A', version: '1' })).toBe(
      'Plugin must have a non-empty string "id"'
    );
  });

  it('rejects empty id', () => {
    expect(validatePlugin({ id: '  ', name: 'A', version: '1' })).toBe(
      'Plugin must have a non-empty string "id"'
    );
  });

  it('rejects missing name', () => {
    expect(validatePlugin({ id: 'a', version: '1' })).toBe(
      'Plugin must have a non-empty string "name"'
    );
  });

  it('rejects missing version', () => {
    expect(validatePlugin({ id: 'a', name: 'A' })).toBe(
      'Plugin must have a non-empty string "version"'
    );
  });

  it('rejects handlers that are not an array', () => {
    expect(
      validatePlugin({ id: 'a', name: 'A', version: '1', handlers: 'not array' })
    ).toBe('"handlers" must be an array');
  });

  it('rejects handler without prefixes', () => {
    expect(
      validatePlugin({
        id: 'a',
        name: 'A',
        version: '1',
        handlers: [{ execute: () => {} }],
      })
    ).toBe('handlers[0] must have a non-empty "prefixes" array');
  });

  it('rejects handler without execute function', () => {
    expect(
      validatePlugin({
        id: 'a',
        name: 'A',
        version: '1',
        handlers: [{ prefixes: ['x::'] }],
      })
    ).toBe('handlers[0] must have an "execute" function');
  });

  it('rejects hooks that are not an array', () => {
    expect(
      validatePlugin({ id: 'a', name: 'A', version: '1', hooks: {} })
    ).toBe('"hooks" must be an array');
  });

  it('rejects hook without id', () => {
    expect(
      validatePlugin({
        id: 'a',
        name: 'A',
        version: '1',
        hooks: [{ handler: () => ({}) }],
      })
    ).toBe('hooks[0] must have a string "id"');
  });

  it('rejects views that are not an object', () => {
    expect(
      validatePlugin({ id: 'a', name: 'A', version: '1', views: 'not obj' })
    ).toBe('"views" must be an object');
  });

  it('rejects view that is not a function', () => {
    expect(
      validatePlugin({
        id: 'a',
        name: 'A',
        version: '1',
        views: { 'my-view': 'not a component' },
      })
    ).toBe('views["my-view"] must be a component function');
  });

  it('rejects styles that are not a string', () => {
    expect(
      validatePlugin({ id: 'a', name: 'A', version: '1', styles: 42 })
    ).toBe('"styles" must be a string');
  });
});

// ═══════════════════════════════════════════════════════════════
// LOADING
// ═══════════════════════════════════════════════════════════════

describe('loadPlugin', () => {
  it('loads a minimal plugin', async () => {
    await loadPlugin(createMinimalPlugin());
    expect(isPluginLoaded('test-plugin')).toBe(true);
    expect(getLoadedPluginIds()).toContain('test-plugin');
  });

  it('registers handlers from plugin', async () => {
    await loadPlugin(createFullPlugin());
    expect(registry.isExecutableBlock('test:: hello')).toBe(true);
  });

  it('registers hooks from plugin', async () => {
    await loadPlugin(createFullPlugin());
    expect(hookRegistry.getHookIds()).toContain('test-hook');
  });

  it('registers views from plugin', async () => {
    await loadPlugin(createFullPlugin());
    expect(hasView('test-view')).toBe(true);
    expect(getView('test-view')).toBeDefined();
  });

  it('injects styles from plugin', async () => {
    await loadPlugin(createFullPlugin());
    const styleEl = document.querySelector('style[data-plugin="full-plugin"]');
    expect(styleEl).not.toBeNull();
    expect(styleEl!.textContent).toBe('.test { color: red; }');
  });

  it('calls activate with PluginAPI', async () => {
    const activateSpy = vi.fn();
    await loadPlugin(
      createMinimalPlugin({
        activate: activateSpy,
      })
    );
    expect(activateSpy).toHaveBeenCalledTimes(1);
    // Check API shape
    const api = activateSpy.mock.calls[0][0];
    expect(typeof api.registerHandler).toBe('function');
    expect(typeof api.registerHook).toBe('function');
    expect(typeof api.registerView).toBe('function');
    expect(typeof api.log).toBe('function');
    expect(typeof api.warn).toBe('function');
    expect(typeof api.error).toBe('function');
  });

  it('replaces existing plugin with same ID', async () => {
    const deactivateSpy = vi.fn();
    await loadPlugin(
      createMinimalPlugin({
        deactivate: deactivateSpy,
        views: { 'v1': () => null },
      })
    );
    expect(hasView('v1')).toBe(true);

    // Load replacement
    await loadPlugin(
      createMinimalPlugin({
        views: { 'v2': () => null },
      })
    );

    expect(deactivateSpy).toHaveBeenCalledTimes(1);
    expect(hasView('v1')).toBe(false); // Old view removed
    expect(hasView('v2')).toBe(true);  // New view registered
  });

  it('does not load invalid plugin', async () => {
    await loadPlugin({ id: '', name: '', version: '' } as FloattyPlugin);
    expect(getLoadedPluginIds()).toHaveLength(0);
  });

  it('catches activation errors without failing', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await loadPlugin(
      createMinimalPlugin({
        activate: () => {
          throw new Error('activation failed');
        },
      })
    );
    expect(isPluginLoaded('test-plugin')).toBe(true); // Still loaded
    consoleSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════
// UNLOADING
// ═══════════════════════════════════════════════════════════════

describe('unloadPlugin', () => {
  it('unloads a plugin and removes registrations', async () => {
    await loadPlugin(createFullPlugin());
    expect(isPluginLoaded('full-plugin')).toBe(true);
    expect(hasView('test-view')).toBe(true);
    expect(hookRegistry.getHookIds()).toContain('test-hook');

    unloadPlugin('full-plugin');

    expect(isPluginLoaded('full-plugin')).toBe(false);
    expect(hasView('test-view')).toBe(false);
    expect(hookRegistry.getHookIds()).not.toContain('test-hook');
  });

  it('removes injected styles on unload', async () => {
    await loadPlugin(createFullPlugin());
    expect(document.querySelector('style[data-plugin="full-plugin"]')).not.toBeNull();

    unloadPlugin('full-plugin');

    expect(document.querySelector('style[data-plugin="full-plugin"]')).toBeNull();
  });

  it('calls deactivate on unload', async () => {
    const deactivateSpy = vi.fn();
    await loadPlugin(
      createMinimalPlugin({ deactivate: deactivateSpy })
    );

    unloadPlugin('test-plugin');
    expect(deactivateSpy).toHaveBeenCalledTimes(1);
  });

  it('returns false for unknown plugin', () => {
    expect(unloadPlugin('nonexistent')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// UNLOAD ALL
// ═══════════════════════════════════════════════════════════════

describe('unloadAllPlugins', () => {
  it('unloads all loaded plugins', async () => {
    await loadPlugin(createMinimalPlugin({ id: 'p1', name: 'P1', version: '1' }));
    await loadPlugin(createMinimalPlugin({ id: 'p2', name: 'P2', version: '1' }));
    expect(getLoadedPluginIds()).toHaveLength(2);

    unloadAllPlugins();

    expect(getLoadedPluginIds()).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// VIEW REGISTRY
// ═══════════════════════════════════════════════════════════════

describe('viewRegistry', () => {
  it('returns undefined for unregistered outputType', () => {
    expect(getView('nonexistent')).toBeUndefined();
    expect(getView(undefined)).toBeUndefined();
  });

  it('hasView returns false for undefined', () => {
    expect(hasView(undefined)).toBe(false);
  });

  it('lists registered view types', async () => {
    await loadPlugin(createFullPlugin());
    expect(getRegisteredViewTypes()).toContain('test-view');
  });
});

// ═══════════════════════════════════════════════════════════════
// PLUGIN API (runtime registration)
// ═══════════════════════════════════════════════════════════════

describe('PluginAPI runtime registration', () => {
  it('registerHandler via API adds to global registry', async () => {
    await loadPlugin(
      createMinimalPlugin({
        activate: (api) => {
          api.registerHandler({
            prefixes: ['api-test::'],
            execute: async () => {},
          });
        },
      })
    );
    expect(registry.isExecutableBlock('api-test:: hello')).toBe(true);
  });

  it('registerHook via API adds to global hook registry', async () => {
    await loadPlugin(
      createMinimalPlugin({
        activate: (api) => {
          api.registerHook({
            id: 'api-test-hook',
            event: 'execute:before',
            filter: () => true,
            priority: 50,
            handler: () => ({}),
          });
        },
      })
    );
    expect(hookRegistry.getHookIds()).toContain('api-test-hook');
  });

  it('registerView via API adds to view registry', async () => {
    const MockComponent = () => null;
    await loadPlugin(
      createMinimalPlugin({
        activate: (api) => {
          api.registerView('api-test-view', MockComponent);
        },
      })
    );
    expect(hasView('api-test-view')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// DAILY PLUGIN (integration sanity check)
// ═══════════════════════════════════════════════════════════════

describe('daily plugin (bundled)', () => {
  it('exports a valid plugin manifest', async () => {
    // Dynamic import to test the actual plugin
    const { plugin } = await import('../../plugins/daily/plugin');
    expect(validatePlugin(plugin)).toBeNull();
    expect(plugin.id).toBe('daily');
    expect(plugin.handlers).toHaveLength(1);
    expect(plugin.handlers![0].prefixes).toContain('daily::');
    expect(plugin.views).toBeDefined();
    expect(plugin.views!['daily-view']).toBeDefined();
    expect(plugin.views!['daily-error']).toBeDefined();
    expect(plugin.styles).toBeDefined();
    expect(plugin.styles!.length).toBeGreaterThan(100); // Sanity check CSS exists
  });

  it('loads and registers daily:: handler', async () => {
    const { plugin } = await import('../../plugins/daily/plugin');
    await loadPlugin(plugin);

    expect(isPluginLoaded('daily')).toBe(true);
    expect(registry.isExecutableBlock('daily::today')).toBe(true);
    expect(hasView('daily-view')).toBe(true);
    expect(hasView('daily-error')).toBe(true);
  });
});
