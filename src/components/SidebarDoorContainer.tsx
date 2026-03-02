/**
 * SidebarDoorContainer — Tabbed container wrapping sidebar panels
 *
 * Phase 1: single "ctx" tab rendering ContextSidebar.
 * Phase 2+: additional tabs from DoorRegistry (sidebarEligible doors).
 *
 * Focus contract: no tabIndex or onKeyDown on panels —
 * sidebar is display-only, main app owns focus.
 */

import { Show, For } from 'solid-js';
import { ContextSidebar } from './ContextSidebar';
import { createSidebarDoorStore } from '../hooks/useSidebarDoorStore';
import './sidebar-doors.css';

interface SidebarDoorContainerProps {
  visible: boolean;
  getOutlinerPaneId: () => string | null;
}

// Phase 1: static label map. Phase 2: read from DoorRegistry meta.
const DOOR_LABELS: Record<string, string> = {
  ctx: 'ctx',
};

export function SidebarDoorContainer(props: SidebarDoorContainerProps) {
  const store = createSidebarDoorStore();

  return (
    <aside class="sidebar-door-container" role="complementary" aria-label="Sidebar doors">
      {/* Tab strip */}
      <div class="sidebar-door-tabs" role="tablist" aria-label="Sidebar door tabs">
        <For each={store.pinnedDoors()}>
          {(doorId) => (
            <button
              class="sidebar-door-tab"
              role="tab"
              id={`sidebar-tab-${doorId}`}
              aria-selected={store.activeDoorId() === doorId}
              aria-controls={store.activeDoorId() === doorId ? `sidebar-panel-${doorId}` : undefined}
              onClick={() => store.setActiveDoorId(doorId)}
            >
              {DOOR_LABELS[doorId] ?? doorId}
            </button>
          )}
        </For>
      </div>

      {/* Panel area */}
      <div
        class="sidebar-door-panel"
        role="tabpanel"
        id={`sidebar-panel-${store.activeDoorId()}`}
        aria-labelledby={`sidebar-tab-${store.activeDoorId()}`}
      >
        <Show when={store.activeDoorId() === 'ctx'}>
          <ContextSidebar visible={props.visible} />
        </Show>
      </div>
    </aside>
  );
}
