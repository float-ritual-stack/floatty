import { createSignal, createEffect, For, Show, onCleanup } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';

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

  // Track drag counter to handle nested elements
  let dragCounter = 0;

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

  // Global drag event listeners
  createEffect(() => {
    const onDragEnter = (e: DragEvent) => {
      // Only respond to file drags
      if (!e.dataTransfer?.types.includes('Files')) return;

      dragCounter++;
      if (dragCounter === 1) {
        e.preventDefault();
        showOverlay();
      }
    };

    const onDragLeave = (e: DragEvent) => {
      dragCounter--;
      if (dragCounter === 0) {
        // Small delay to prevent flicker when moving between elements
        setTimeout(() => {
          if (dragCounter === 0) {
            setVisible(false);
            setDragOverTarget(null);
          }
        }, 50);
      }
    };

    const onDragOver = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      e.preventDefault();
      // Track mouse position for new shelf creation
      setDropPosition({ x: e.screenX, y: e.screenY });
    };

    const onDrop = (e: DragEvent) => {
      dragCounter = 0;
      // Don't hide immediately - let specific handlers deal with it
    };

    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);

    onCleanup(() => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
    });
  });

  const handleDropOnShelf = async (e: DragEvent, shelfId: string) => {
    e.preventDefault();
    e.stopPropagation();

    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) {
      setVisible(false);
      return;
    }

    const paths: string[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i] as File & { path?: string };
      if (file.path) {
        paths.push(file.path);
      }
    }

    if (paths.length > 0) {
      try {
        await invoke('add_to_shelf', { shelfId, paths });
      } catch (e) {
        console.error('Failed to add files to shelf:', e);
      }
    }

    setVisible(false);
    setDragOverTarget(null);
    dragCounter = 0;
  };

  const handleDropNewShelf = async (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) {
      setVisible(false);
      return;
    }

    const paths: string[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i] as File & { path?: string };
      if (file.path) {
        paths.push(file.path);
      }
    }

    if (paths.length === 0) {
      setVisible(false);
      return;
    }

    try {
      // Create new shelf at drop position
      const position = dropPosition();
      const shelf = await invoke<Shelf>('create_shelf', {
        position: position ? [position.x - 140, position.y - 200] : null,
      });

      // Add files to the new shelf
      await invoke('add_to_shelf', { shelfId: shelf.id, paths });
    } catch (e) {
      console.error('Failed to create shelf:', e);
    }

    setVisible(false);
    setDragOverTarget(null);
    dragCounter = 0;
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
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragOverTarget(shelf.id);
                  }}
                  onDragLeave={() => setDragOverTarget(null)}
                  onDrop={(e) => handleDropOnShelf(e, shelf.id)}
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
              onDragOver={(e) => {
                e.preventDefault();
                setDragOverTarget('new');
              }}
              onDragLeave={() => setDragOverTarget(null)}
              onDrop={handleDropNewShelf}
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
