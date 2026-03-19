/**
 * SidebarDoorContainer — Tabbed container wrapping sidebar panels
 *
 * Phase 2: "ctx" tab (built-in) + sidebarEligible doors from DoorRegistry.
 *
 * Focus contract: no tabIndex or onKeyDown on panels —
 * sidebar is display-only, main app owns focus.
 */

import { Show, For, createMemo, onMount, onCleanup } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { ContextSidebar } from './ContextSidebar';
import { createSidebarDoorStore } from '../hooks/useSidebarDoorStore';
import { doorRegistry } from '../lib/handlers/doorRegistry';
import { getServerAccess } from './views/DoorHost';
import { paneLinkStore } from '../hooks/usePaneLinkStore';
import { handleChirpNavigate } from '../lib/navigation';
import { tabStore } from '../hooks/useTabStore';
import './sidebar-doors.css';

interface SidebarDoorContainerProps {
  visible: boolean;
  getOutlinerPaneId: () => string | null;
}

export function SidebarDoorContainer(props: SidebarDoorContainerProps) {
  const store = createSidebarDoorStore();

  // Chirp listener for sidebar door iframes (manifest, portless doors)
  // Uses handleChirpNavigate (the ONE canonical navigation path) with
  // resolveSidebarTarget to find the right outliner pane per tab.
  //
  // Canonical chirp format: { type: 'chirp', message: 'navigate', data: { target } }
  // (same as EvalOutput / DoorHost — one format, not many)
  onMount(() => {
    const handler = (e: MessageEvent) => {
      // Only handle chirp messages
      if (e.data?.type !== 'chirp') return;
      if (e.data?.message !== 'navigate') return;
      const target = e.data?.data?.target;
      if (!target) return;

      const activeTab = tabStore.activeTabId();
      if (!activeTab) return;
      const paneId = paneLinkStore.resolveSidebarTarget(activeTab);
      if (!paneId) return;

      handleChirpNavigate(target, { sourcePaneId: paneId });
    };

    window.addEventListener('message', handler);
    onCleanup(() => window.removeEventListener('message', handler));
  });

  // Get the view component for the active door (if it's a registry door, not built-in ctx)
  const activeView = createMemo(() => {
    const id = store.activeDoorId();
    if (id === 'ctx') return null; // Built-in, rendered directly
    return doorRegistry.getView(id) ?? null;
  });

  const activeSettings = createMemo(() => {
    const id = store.activeDoorId();
    if (id === 'ctx') return {};
    return doorRegistry.getSettings(id);
  });

  return (
    <aside class="sidebar-door-container" role="complementary" aria-label="Sidebar doors">
      {/* Tab strip */}
      <div class="sidebar-door-tabs" role="tablist" aria-label="Sidebar door tabs">
        <For each={store.allDoors()}>
          {(door) => (
            <button
              class="sidebar-door-tab"
              role="tab"
              id={`sidebar-tab-${door.id}`}
              aria-selected={store.activeDoorId() === door.id}
              aria-controls={store.activeDoorId() === door.id ? `sidebar-panel-${door.id}` : undefined}
              onClick={() => store.setActiveDoorId(door.id)}
            >
              {door.label}
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
        {/* Built-in: ctx sidebar */}
        <Show when={store.activeDoorId() === 'ctx'}>
          <ContextSidebar visible={props.visible} />
        </Show>

        {/* Registry doors: render via Dynamic */}
        <Show when={store.activeDoorId() !== 'ctx' && activeView()}>
          <Dynamic
            component={activeView()!}
            data={null}
            settings={activeSettings()}
            server={getServerAccess()}
          />
        </Show>
      </div>
    </aside>
  );
}
