/**
 * Sidebar Door Store — ephemeral state for sidebar door tabs
 *
 * Phase 2: hardcoded ['ctx'] tab + sidebarEligible doors from DoorRegistry.
 *
 * No Y.Doc coupling — sidebar tab state is ephemeral (resets on app restart).
 */

import { createSignal, createMemo } from 'solid-js';
import { doorRegistry } from '../lib/handlers/doorRegistry';

export interface SidebarDoorInfo {
  id: string;
  label: string;
}

// Hardcoded built-in tabs (always present). Module-level so the set of
// built-in ids can be consumed by SidebarDoorContainer without duplication.
const BUILTIN: SidebarDoorInfo[] = [
  { id: 'ctx', label: 'ctx' },
  // FLO-502: Pin shelf — renders a stack of Outliners zoomed at whatever
  // block each child of the `pinned::` root block references via [[...]].
  { id: 'pins', label: 'pins' },
];

/** Set of builtin door ids — single source of truth shared with SidebarDoorContainer. */
export const BUILTIN_DOOR_IDS = new Set(BUILTIN.map(d => d.id));

export function createSidebarDoorStore() {
  const [activeDoorId, setActiveDoorId] = createSignal('ctx');

  // Merge built-in + registry sidebar doors (reactive via registry version signal)
  const allDoors = createMemo((): SidebarDoorInfo[] => {
    const registryDoors = doorRegistry.getSidebarDoors().map(d => ({
      id: d.id,
      label: d.meta.name,
    }));
    return [...BUILTIN, ...registryDoors];
  });

  return {
    activeDoorId,
    setActiveDoorId,
    /** All sidebar tabs — built-in + registry doors */
    allDoors,
  };
}
