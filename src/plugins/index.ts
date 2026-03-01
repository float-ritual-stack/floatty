/**
 * Bundled Plugins
 *
 * Plugins that ship with floatty. These are statically imported
 * (unlike user plugins which are dynamically loaded from disk).
 *
 * To add a new bundled plugin:
 * 1. Create src/plugins/your-plugin/plugin.ts
 * 2. Import and add to the bundledPlugins array below
 */

import type { FloattyPlugin } from '../lib/plugins/types';
import { plugin as dailyPlugin } from './daily/plugin';

/**
 * All bundled plugins, loaded in order.
 * Bundled plugins load before user plugins, so user plugins
 * can override them by registering the same ID.
 */
export const bundledPlugins: FloattyPlugin[] = [
  dailyPlugin,
];
