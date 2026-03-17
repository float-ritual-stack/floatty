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
import { navigateToPage, navigateToBlock } from '../lib/navigation';
import { tabStore } from '../hooks/useTabStore';
import './sidebar-doors.css';

interface SidebarDoorContainerProps {
  visible: boolean;
  getOutlinerPaneId: () => string | null;
}

export function SidebarDoorContainer(props: SidebarDoorContainerProps) {
  const store = createSidebarDoorStore();

  // Chirp listener for sidebar iframes (manifest, portless doors)
  // Routes navigation to the sidebar's linked pane for the active tab
  onMount(() => {
    const handler = (e: MessageEvent) => {
      if (!e.data?.type?.startsWith('chirp:')) return;
      const { type, target } = e.data;

      if (type === 'chirp:navigate' && target) {
        const activeTab = tabStore.activeTabId();
        if (!activeTab) return;
        const paneId = paneLinkStore.resolveSidebarTarget(activeTab);
        if (!paneId) return;

        // Try as page first, then as block ID
        const pageResult = navigateToPage(target, { paneId, highlight: true });
        if (!pageResult.success) {
          navigateToBlock(target, { paneId, highlight: true });
        }
      }
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
