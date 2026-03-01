/**
 * Door Loader — Discovery + Blob Import Pipeline
 *
 * loadDoors() invokes Rust to discover door files on disk,
 * Blob-imports their JS, validates exports, and registers
 * in both DoorRegistry (views) and HandlerRegistry (handlers).
 *
 * Loading is per-door isolated — one bad door doesn't kill others.
 */

import { invoke } from '../tauriTypes';
import { registry } from './registry';
import { doorRegistry } from './doorRegistry';
import { doorToBlockHandler } from './doorAdapter';
import type {
  Door,
  DoorMeta,
  DoorInfo,
  DoorLoadResult,
} from './doorTypes';

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

  for (const info of doorInfos) {
    if (!info.hasEntry) {
      console.warn(`[doors] ${info.id}: no index.js found, skipping`);
      results.push({ doorId: info.id, ok: false, error: 'No index.js' });
      continue;
    }

    try {
      // Read JS source from Rust
      const js: string = await invoke('read_door_file', { doorId: info.id });

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

      // Register view in DoorRegistry (if view door)
      if (door.kind === 'view' && door.view) {
        doorRegistry.register(meta.id, door.view, {});
      }

      // Register handler in HandlerRegistry via adapter
      const handler = doorToBlockHandler(door, meta, {});
      registry.register(handler);

      console.log(`[doors] Loaded: ${meta.id} (${door.kind}, prefixes: ${door.prefixes.join(', ')})`);
      results.push({ doorId: meta.id, ok: true });

    } catch (err) {
      console.error(`[doors] Failed to load ${info.id}:`, err);
      results.push({ doorId: info.id, ok: false, error: String(err) });
    }
  }

  const loaded = results.filter(r => r.ok);
  console.log(`[doors] Loaded ${loaded.length}/${doorInfos.length} doors: [${loaded.map(r => r.doorId).join(', ')}]`);

  return results;
}
