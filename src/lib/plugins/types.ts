/**
 * Plugin System Types
 *
 * Defines the contract for floatty plugins. Plugins are JavaScript/TypeScript
 * modules that register handlers, hooks, views, and styles.
 *
 * Inspired by nvim/lazyvim: drop a folder in `~/.floatty/plugins/`, it gets loaded.
 *
 * @see docs/architecture/PLUGIN_SYSTEM.md
 */

import type { Component } from 'solid-js';
import type { BlockHandler } from '../handlers/types';
import type { Hook } from '../hooks/types';

// ═══════════════════════════════════════════════════════════════
// PLUGIN MANIFEST
// ═══════════════════════════════════════════════════════════════

/**
 * Plugin definition exported from a plugin's entry point.
 *
 * A plugin can provide any combination of:
 * - handlers: Block handlers (sh::, daily::, custom:: prefixes)
 * - hooks: Lifecycle hooks (execute:before/after, block:create/update/delete)
 * - views: Custom output renderers keyed by outputType
 * - styles: CSS text to inject into the document
 *
 * @example
 * ```typescript
 * // plugins/daily/plugin.ts
 * export const plugin: FloattyPlugin = {
 *   id: 'daily',
 *   name: 'Daily Notes',
 *   version: '1.0.0',
 *   handlers: [dailyHandler],
 *   views: {
 *     'daily-view': DailyView,
 *     'daily-error': DailyErrorView,
 *   },
 *   styles: dailyCSS,
 * };
 * ```
 */
export interface FloattyPlugin {
  /** Unique plugin identifier (used for logging, dedup, unload) */
  id: string;

  /** Human-readable plugin name */
  name: string;

  /** Semver version string */
  version: string;

  /** Block handlers to register */
  handlers?: BlockHandler[];

  /** Hooks to register */
  hooks?: Hook[];

  /**
   * Custom view components keyed by outputType.
   *
   * When a block has `outputType` matching a key here, BlockItem
   * renders this component instead of hardcoded views.
   *
   * Component receives `{ data: unknown, status?: string }`.
   */
  views?: Record<string, Component<OutputViewProps>>;

  /** CSS text to inject into the document */
  styles?: string;

  /**
   * Called once after plugin is loaded and all handlers/hooks/views registered.
   * Use for one-time setup (e.g., registering Tauri event listeners).
   */
  activate?: (api: PluginAPI) => void | Promise<void>;

  /** Called when plugin is unloaded (HMR, disable). Clean up resources here. */
  deactivate?: () => void;
}

// ═══════════════════════════════════════════════════════════════
// VIEW PROPS
// ═══════════════════════════════════════════════════════════════

/**
 * Props passed to plugin-provided output view components.
 */
export interface OutputViewProps {
  /** The output data from the handler (shape varies by plugin) */
  data: unknown;
  /** Block output status */
  status?: 'idle' | 'running' | 'complete' | 'error' | 'pending';
  /** Block ID (for navigation/interaction) */
  blockId?: string;
  /** Pane ID (for split-aware operations) */
  paneId?: string;
}

// ═══════════════════════════════════════════════════════════════
// PLUGIN API
// ═══════════════════════════════════════════════════════════════

/**
 * API surface available to plugins during activation.
 *
 * This is the sandbox — plugins interact with floatty through this interface
 * rather than importing internal modules directly.
 */
export interface PluginAPI {
  /** Register an additional handler at runtime */
  registerHandler: (handler: BlockHandler) => void;

  /** Register an additional hook at runtime */
  registerHook: (hook: Hook) => void;

  /** Register a view component for an outputType */
  registerView: (outputType: string, component: Component<OutputViewProps>) => void;

  /** Log with plugin prefix (forwarded to floatty's structured logger) */
  log: (...args: unknown[]) => void;

  /** Warn with plugin prefix */
  warn: (...args: unknown[]) => void;

  /** Error with plugin prefix */
  error: (...args: unknown[]) => void;
}

// ═══════════════════════════════════════════════════════════════
// PLUGIN STATE
// ═══════════════════════════════════════════════════════════════

/**
 * Runtime state for a loaded plugin.
 * Tracks registrations for clean teardown.
 */
export interface LoadedPlugin {
  /** The plugin manifest */
  plugin: FloattyPlugin;

  /** IDs of handlers registered by this plugin (for unload) */
  handlerPrefixes: string[];

  /** IDs of hooks registered by this plugin (for unload) */
  hookIds: string[];

  /** outputTypes registered by this plugin (for unload) */
  viewTypes: string[];

  /** Style element injected by this plugin (for unload) */
  styleElement: HTMLStyleElement | null;
}

// Re-export handler types for plugin authors
export type { BlockHandler, ExecutorActions } from '../handlers/types';
export type {
  Hook,
  HookEvent,
  HookContext,
  HookResult,
  HookFilter,
  HookHandler,
  HookBlockStore,
  HookFilters,
} from '../hooks/types';
