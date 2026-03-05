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

export function createSidebarDoorStore() {
  const [activeDoorId, setActiveDoorId] = createSignal('ctx');

  // Hardcoded built-in tabs (always present)
  const BUILTIN: SidebarDoorInfo[] = [{ id: 'ctx', label: 'ctx' }];

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
