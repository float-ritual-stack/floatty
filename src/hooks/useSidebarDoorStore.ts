/**
 * Sidebar Door Store — ephemeral state for sidebar door tabs
 *
 * Phase 1: hardcoded ['ctx'] tab, activeDoorId signal.
 * Phase 2+: door registry integration for sidebarEligible doors.
 *
 * No Y.Doc coupling — sidebar tab state is ephemeral (resets on app restart).
 */

import { createSignal } from 'solid-js';

export function createSidebarDoorStore() {
  const [activeDoorId, setActiveDoorId] = createSignal('ctx');

  // Phase 1: hardcoded. Phase 2: read from DoorRegistry where sidebarEligible
  const pinnedDoors = () => ['ctx'];

  return {
    activeDoorId,
    setActiveDoorId,
    pinnedDoors,
  };
}
