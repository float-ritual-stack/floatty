/**
 * Door Loader — Discovery + Blob Import Pipeline
 *
 * loadDoors() invokes Rust to discover door files on disk,
 * Blob-imports their JS, validates exports, and registers
 * in both DoorRegistry (views) and HandlerRegistry (handlers).
 *
 * Loading is per-door isolated — one bad door doesn't kill others.
 *
 * Import Shim System:
 * Compiled doors import from 'solid-js' and 'solid-js/web' (bare specifiers).
 * Blob modules can't resolve bare specifiers (Phase 0.B proved this).
 * Solution: create Blob shim URLs that re-export the host's SolidJS modules
 * from window globals. Rewrite door JS before Blob import.
 */

import { invoke, type AggregatorConfig } from '../tauriTypes';
import { registry } from './registry';
import { doorRegistry } from './doorRegistry';
import { doorToBlockHandler } from './doorAdapter';
import type {
  Door,
  DoorMeta,
  DoorInfo,
  DoorLoadResult,
} from './doorTypes';

// Host SolidJS modules — these are the SAME instances the app uses.
// Doors must share the same reactive runtime (two copies = signals don't propagate).
import * as solidJs from 'solid-js';
import * as solidJsWeb from 'solid-js/web';

// Door standard library — shared utilities exposed to all doors
import * as doorStdlib from '../doorStdlib';

// ═══════════════════════════════════════════════════════════════
// IMPORT SHIM SYSTEM
// ═══════════════════════════════════════════════════════════════

let shimUrls: { solidJs: string; solidJsWeb: string; stdlib: string } | null = null;

/**
 * Build a shim module that re-exports host SolidJS from window globals.
 * Each named export reads from the global at import time.
 */
function buildShimCode(moduleName: string, mod: Record<string, unknown>): string {
  const validId = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;
  const lines: string[] = [];
  for (const key of Object.keys(mod)) {
    if (key === '__esModule') continue;
    if (key === 'default') {
      lines.push(`export default window.__DOOR_DEPS__['${moduleName}']['default'];`);
    } else if (validId.test(key)) {
      lines.push(`export const ${key} = window.__DOOR_DEPS__['${moduleName}']['${key}'];`);
    }
  }
  return lines.join('\n');
}

/**
 * Set up window globals and create Blob shim URLs for solid-js, solid-js/web, and @floatty/stdlib.
 * Called once, URLs cached for all door loads.
 */
function ensureDoorDeps(): { solidJs: string; solidJsWeb: string; stdlib: string } {
  if (shimUrls) return shimUrls;

  // Expose host modules on window for shim access
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as Record<string, any>).__DOOR_DEPS__ = {
    'solid-js': solidJs,
    'solid-js/web': solidJsWeb,
    '@floatty/stdlib': doorStdlib,
  };

  const solidJsShim = buildShimCode('solid-js', solidJs as Record<string, unknown>);
  const solidJsWebShim = buildShimCode('solid-js/web', solidJsWeb as Record<string, unknown>);
  const stdlibShim = buildShimCode('@floatty/stdlib', doorStdlib as Record<string, unknown>);

  shimUrls = {
    solidJs: URL.createObjectURL(new Blob([solidJsShim], { type: 'application/javascript' })),
    solidJsWeb: URL.createObjectURL(new Blob([solidJsWebShim], { type: 'application/javascript' })),
    stdlib: URL.createObjectURL(new Blob([stdlibShim], { type: 'application/javascript' })),
  };

  console.log('[doors] Import shims ready (solid-js, solid-js/web, @floatty/stdlib)');
  return shimUrls;
}

/**
 * Rewrite bare specifier imports in door JS to point at shim Blob URLs.
 * Must rewrite solid-js/web BEFORE solid-js (longer match first).
 * @floatty/stdlib rewrites door standard library imports.
 */
function rewriteDoorImports(js: string, urls: { solidJs: string; solidJsWeb: string; stdlib: string }): string {
  return js
    .replace(/from\s+['"]@floatty\/stdlib['"]/g, `from '${urls.stdlib}'`)
    .replace(/from\s+['"]solid-js\/web['"]/g, `from '${urls.solidJsWeb}'`)
    .replace(/from\s+['"]solid-js['"]/g, `from '${urls.solidJs}'`);
}

/**
 * Clean up shim resources (called on HMR dispose).
 */
export function cleanupDoorDeps(): void {
  if (shimUrls) {
    URL.revokeObjectURL(shimUrls.solidJs);
    URL.revokeObjectURL(shimUrls.solidJsWeb);
    URL.revokeObjectURL(shimUrls.stdlib);
    shimUrls = null;
  }
  if ('__DOOR_DEPS__' in window) {
    delete (window as Record<string, unknown>).__DOOR_DEPS__;
  }
}

// ═══════════════════════════════════════════════════════════════
// VALIDATION
// ═══════════════════════════════════════════════════════════════

/** Validate a door module's exports are well-formed */
function validateDoorModule(mod: Record<string, unknown>): {
  door: Door;
  meta: DoorMeta;
} {
  // Check required exports
  if (!mod.door) {
    throw new Error(`Missing 'door' export`);
  }
  if (!mod.meta) {
    throw new Error(`Missing 'meta' export`);
  }

  const door = mod.door as Door;
  const meta = mod.meta as DoorMeta;

  // Validate meta
  if (!meta.id || typeof meta.id !== 'string') {
    throw new Error(`meta.id must be a non-empty string`);
  }
  if (!meta.name || typeof meta.name !== 'string') {
    throw new Error(`meta.name must be a non-empty string`);
  }

  // Validate door shape
  if (!door.prefixes || !Array.isArray(door.prefixes) || door.prefixes.length === 0) {
    throw new Error(`door.prefixes must be a non-empty string array`);
  }
  if (typeof door.execute !== 'function') {
    throw new Error(`door.execute must be a function`);
  }

  // Kind consistency
  const kind = door.kind;
  if (kind !== 'view' && kind !== 'block') {
    throw new Error(`door.kind must be 'view' or 'block', got '${kind}'`);
  }
  if (kind === 'view' && !door.view) {
    throw new Error(`View door (kind='view') must export a view component`);
  }
  if (kind === 'block' && door.view) {
    throw new Error(`Block door (kind='block') must not have a view component`);
  }

  // Warn if meta.id doesn't match manifest id
  // (Not fatal — meta.id is authoritative)

  return { door, meta };
}

// ═══════════════════════════════════════════════════════════════
// LOADER
// ═══════════════════════════════════════════════════════════════

/**
 * Load all doors from disk.
 * Called once during app init (fire-and-forget from registerHandlers).
 */
export async function loadDoors(): Promise<DoorLoadResult[]> {
  const results: DoorLoadResult[] = [];
  const deps = ensureDoorDeps();

  // Fetch config once for plugin settings
  let pluginSettings: Record<string, Record<string, unknown>> = {};
  try {
    const config = await invoke<AggregatorConfig>('get_ctx_config', {});
    pluginSettings = (config.plugins ?? {}) as Record<string, Record<string, unknown>>;
  } catch (err) {
    console.warn('[doors] Failed to load config for plugin settings:', err);
  }

  let doorInfos: DoorInfo[];
  try {
    doorInfos = await invoke('list_door_files', {});
  } catch (err) {
    console.error('[doors] Failed to list doors:', err);
    return [];
  }

  if (doorInfos.length === 0) {
    console.log('[doors] No doors found on disk');
    return [];
  }

  console.log(`[doors] Found ${doorInfos.length} door(s): ${doorInfos.map(d => d.id).join(', ')}`);

  const settled = await Promise.allSettled(doorInfos.map(async (info): Promise<DoorLoadResult> => {
    if (!info.hasEntry) {
      console.warn(`[doors] ${info.id}: no index.js found, skipping`);
      return { doorId: info.id, ok: false, error: 'No index.js' };
    }

    // Read JS source from Rust
    const rawJs: string = await invoke('read_door_file', { doorId: info.id });

    // Rewrite bare specifiers to shim URLs (solid-js, solid-js/web)
    const js = rewriteDoorImports(rawJs, deps);

    // Blob import
    const blob = new Blob([js], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);

    let mod: Record<string, unknown>;
    try {
      mod = await import(/* @vite-ignore */ url);
    } finally {
      URL.revokeObjectURL(url);
    }

    // Validate exports
    const { door, meta } = validateDoorModule(mod);

    // Warn on id mismatch
    if (meta.id !== info.id) {
      console.warn(
        `[doors] ${info.id}: meta.id is '${meta.id}' (differs from directory name '${info.id}'). Using meta.id as registry key.`
      );
    }

    // Per-door settings from config.toml [plugins.<id>]
    const settings = pluginSettings[meta.id] ?? {};

    // Register view in DoorRegistry (if view door)
    if (door.kind === 'view' && door.view) {
      doorRegistry.register(meta.id, door.view, settings);
    }

    // Register handler in HandlerRegistry via adapter
    const handler = doorToBlockHandler(door, meta, settings);
    registry.register(handler);

    console.log(`[doors] Loaded: ${meta.id} (${door.kind}, prefixes: ${door.prefixes.join(', ')})`);
    return { doorId: meta.id, ok: true };
  }));

  for (const outcome of settled) {
    if (outcome.status === 'fulfilled') {
      results.push(outcome.value);
    } else {
      console.error(`[doors] Failed to load door:`, outcome.reason);
      results.push({ doorId: 'unknown', ok: false, error: String(outcome.reason) });
    }
  }

  const loaded = results.filter(r => r.ok);
  console.log(`[doors] Loaded ${loaded.length}/${doorInfos.length} doors: [${loaded.map(r => r.doorId).join(', ')}]`);

  return results;
}
