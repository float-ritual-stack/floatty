import { createSignal, createEffect, For, Show, onCleanup } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import type { DragDropEvent } from '@tauri-apps/api/webview';

interface Shelf {
  id: string;
  name: string | null;
  position_x: number;
  position_y: number;
  width: number;
  height: number;
  created_at: number;
  updated_at: number;
}

export function ShelfDropOverlay() {
  const [visible, setVisible] = createSignal(false);
  const [shelves, setShelves] = createSignal<Shelf[]>([]);
  const [dragOverTarget, setDragOverTarget] = createSignal<string | null>(null);
  const [dropPosition, setDropPosition] = createSignal<{ x: number; y: number } | null>(null);
  const [pendingPaths, setPendingPaths] = createSignal<string[]>([]);

  const loadShelves = async () => {
    try {
      const result = await invoke<Shelf[]>('get_shelves');
      setShelves(result);
    } catch (e) {
      console.error('Failed to load shelves:', e);
    }
  };

  const showOverlay = async () => {
    setVisible(true);
    await loadShelves();
    // Also show existing shelf panels
    try {
      await invoke('show_all_shelf_panels');
    } catch (e) {
      console.error('Failed to show shelf panels:', e);
    }
  };

  // Use Tauri's drag-drop API for native file drops
  createEffect(() => {
    let unlisten: (() => void) | null = null;

    const setupListener = async () => {
      try {
        const webview = getCurrentWebview();
        unlisten = await webview.onDragDropEvent((event: DragDropEvent) => {
          const payload = event.payload;

          if (payload.type === 'enter' || payload.type === 'over') {
            // Show overlay when files enter the webview
            if (!visible()) {
              showOverlay();
            }
            // Track position for new shelf creation
            if (payload.position) {
              setDropPosition({ x: payload.position.x, y: payload.position.y });
            }
            // Store paths for when user drops on a zone
            if (payload.paths && payload.paths.length > 0) {
              setPendingPaths(payload.paths);
            }
          } else if (payload.type === 'leave') {
            // Small delay to prevent flicker
            setTimeout(() => {
              if (!visible()) return;
              setVisible(false);
              setDragOverTarget(null);
              setPendingPaths([]);
            }, 50);
          } else if (payload.type === 'drop') {
            // Drop happened - check if we have a target zone selected
            const target = dragOverTarget();
            const paths = payload.paths || pendingPaths();

            if (paths.length > 0 && target) {
              // Handle drop based on selected target
              if (target === 'new') {
                handleDropNewShelfWithPaths(paths, dropPosition());
              } else {
                handleDropOnShelfWithPaths(target, paths);
              }
            }

            // Reset state
            setVisible(false);
            setDragOverTarget(null);
            setPendingPaths([]);
          }
        });
      } catch (e) {
        console.error('Failed to setup drag-drop listener:', e);
      }
    };

    setupListener();

    onCleanup(() => {
      if (unlisten) {
        unlisten();
      }
    });
  });

  // Handler for dropping on existing shelf (using Tauri paths)
  const handleDropOnShelfWithPaths = async (shelfId: string, paths: string[]) => {
    if (paths.length === 0) return;

    try {
      await invoke('add_to_shelf', { shelfId, paths });
    } catch (e) {
      console.error('Failed to add files to shelf:', e);
    }
  };

  // Handler for creating new shelf (using Tauri paths)
  const handleDropNewShelfWithPaths = async (
    paths: string[],
    position: { x: number; y: number } | null
  ) => {
    if (paths.length === 0) return;

    try {
      // Create new shelf at drop position
      const shelf = await invoke<Shelf>('create_shelf', {
        position: position ? [position.x - 140, position.y - 200] : null,
      });

      // Add files to the new shelf
      await invoke('add_to_shelf', { shelfId: shelf.id, paths });
    } catch (e) {
      console.error('Failed to create shelf:', e);
    }
  };

  const getShelfDisplayName = (shelf: Shelf, index: number): string => {
    if (shelf.name) return shelf.name;
    return `Shelf ${index + 1}`;
  };

  return (
    <Show when={visible()}>
      <div class="shelf-drop-overlay">
        <div class="shelf-drop-content">
          <div class="shelf-drop-hint">
            Drop on a shelf or create new
          </div>

          <div class="shelf-drop-zones">
            {/* Existing shelves */}
            <For each={shelves()}>
              {(shelf, index) => (
                <div
                  class="shelf-drop-zone"
                  classList={{ 'shelf-drop-zone-active': dragOverTarget() === shelf.id }}
                  onMouseEnter={() => setDragOverTarget(shelf.id)}
                  onMouseLeave={() => setDragOverTarget(null)}
                >
                  <span class="shelf-drop-zone-icon">📥</span>
                  <span class="shelf-drop-zone-name">{getShelfDisplayName(shelf, index())}</span>
                </div>
              )}
            </For>

            {/* New shelf zone - always visible */}
            <div
              class="shelf-drop-zone shelf-drop-zone-new"
              classList={{ 'shelf-drop-zone-active': dragOverTarget() === 'new' }}
              onMouseEnter={() => setDragOverTarget('new')}
              onMouseLeave={() => setDragOverTarget(null)}
            >
              <span class="shelf-drop-zone-icon">+</span>
              <span class="shelf-drop-zone-name">New Shelf</span>
            </div>
          </div>
        </div>
      </div>
    </Show>
  );
}
