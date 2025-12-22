import { createSignal, createEffect, For, Show, onMount, onCleanup } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';

interface ShelfItem {
  id: string;
  shelf_id: string;
  original_path: string;
  stored_path: string;
  filename: string;
  size_bytes: number;
  is_directory: boolean;
  added_at: number;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function getFileIcon(filename: string, isDirectory: boolean): string {
  if (isDirectory) return '📁';

  const ext = filename.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'pdf': return '📕';
    case 'doc': case 'docx': return '📘';
    case 'xls': case 'xlsx': return '📗';
    case 'ppt': case 'pptx': return '📙';
    case 'zip': case 'tar': case 'gz': case 'rar': return '📦';
    case 'png': case 'jpg': case 'jpeg': case 'gif': case 'svg': case 'webp': return '🖼️';
    case 'mp4': case 'mov': case 'avi': case 'mkv': return '🎬';
    case 'mp3': case 'wav': case 'flac': case 'aac': return '🎵';
    case 'js': case 'ts': case 'jsx': case 'tsx': return '📜';
    case 'py': return '🐍';
    case 'rs': return '🦀';
    case 'go': return '🐹';
    case 'json': case 'yaml': case 'toml': return '⚙️';
    case 'md': return '📝';
    default: return '📄';
  }
}

export function ShelfPanel() {
  // Get shelf ID from URL params
  const params = new URLSearchParams(window.location.search);
  const shelfId = params.get('id') || '';

  const [items, setItems] = createSignal<ShelfItem[]>([]);
  const [dragOver, setDragOver] = createSignal(false);
  const [loading, setLoading] = createSignal(true);

  const loadItems = async () => {
    try {
      const result = await invoke<ShelfItem[]>('get_shelf_items', { shelfId });
      setItems(result);
    } catch (e) {
      console.error('Failed to load shelf items:', e);
    } finally {
      setLoading(false);
    }
  };

  onMount(() => {
    loadItems();

    // Track position/size changes to persist
    const window = getCurrentWindow();

    // Debounce position updates
    let positionTimeout: number | undefined;
    const unlistenMove = window.onMoved(({ payload }) => {
      clearTimeout(positionTimeout);
      positionTimeout = setTimeout(() => {
        invoke('update_shelf_position', {
          shelfId,
          x: payload.x,
          y: payload.y,
        }).catch(console.error);
      }, 500) as unknown as number;
    });

    let sizeTimeout: number | undefined;
    const unlistenResize = window.onResized(({ payload }) => {
      clearTimeout(sizeTimeout);
      sizeTimeout = setTimeout(() => {
        invoke('update_shelf_size', {
          shelfId,
          width: payload.width,
          height: payload.height,
        }).catch(console.error);
      }, 500) as unknown as number;
    });

    onCleanup(() => {
      unlistenMove.then(fn => fn());
      unlistenResize.then(fn => fn());
      clearTimeout(positionTimeout);
      clearTimeout(sizeTimeout);
    });
  });

  // Listen for updates from other windows
  createEffect(() => {
    const unlisten = listen(`shelf-updated-${shelfId}`, () => {
      loadItems();
    });
    onCleanup(() => {
      unlisten.then(fn => fn());
    });
  });

  const handleDragOver = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(true);
  };

  const handleDragLeave = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Only set false if we're leaving the container entirely
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = e.clientX;
    const y = e.clientY;
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
      setDragOver(false);
    }
  };

  const handleDrop = async (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);

    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;

    // Get file paths - Tauri provides real paths
    const paths: string[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i] as File & { path?: string };
      if (file.path) {
        paths.push(file.path);
      }
    }

    if (paths.length === 0) return;

    try {
      await invoke('add_to_shelf', { shelfId, paths });
      await loadItems();
    } catch (e) {
      console.error('Failed to add files to shelf:', e);
    }
  };

  const handleItemClick = async (item: ShelfItem) => {
    // Could open in Finder or trigger other action
    console.log('Clicked item:', item.stored_path);
  };

  const handleDeleteItem = async (e: MouseEvent, itemId: string) => {
    e.stopPropagation();
    try {
      await invoke('delete_shelf_item', { itemId });
      await loadItems();
    } catch (e) {
      console.error('Failed to delete item:', e);
    }
  };

  const handleCloseShelf = async () => {
    try {
      await invoke('delete_shelf', { shelfId });
    } catch (e) {
      console.error('Failed to delete shelf:', e);
    }
  };

  return (
    <div
      class="shelf-panel"
      classList={{ 'shelf-drag-over': dragOver() }}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div class="shelf-header" data-tauri-drag-region>
        <span class="shelf-title">Shelf</span>
        <div class="shelf-header-actions">
          <span class="shelf-item-count">{items().length}</span>
          <button class="shelf-close-btn" onClick={handleCloseShelf} title="Delete shelf">
            ×
          </button>
        </div>
      </div>

      <div class="shelf-items">
        <Show when={!loading()} fallback={<div class="shelf-loading">Loading...</div>}>
          <Show when={items().length > 0} fallback={
            <div class="shelf-empty">
              Drop files here
            </div>
          }>
            <For each={items()}>
              {(item) => (
                <div
                  class="shelf-item"
                  draggable={true}
                  onClick={() => handleItemClick(item)}
                  onDragStart={(e) => {
                    e.dataTransfer?.setData('text/uri-list', `file://${item.stored_path}`);
                    e.dataTransfer?.setData('text/plain', item.stored_path);
                  }}
                >
                  <span class="shelf-item-icon">{getFileIcon(item.filename, item.is_directory)}</span>
                  <div class="shelf-item-info">
                    <span class="shelf-item-name" title={item.filename}>
                      {item.filename.length > 24 ? item.filename.slice(0, 21) + '...' : item.filename}
                    </span>
                    <span class="shelf-item-size">{formatSize(item.size_bytes)}</span>
                  </div>
                  <button
                    class="shelf-item-delete"
                    onClick={(e) => handleDeleteItem(e, item.id)}
                    title="Remove from shelf"
                  >
                    ×
                  </button>
                </div>
              )}
            </For>
          </Show>
        </Show>
      </div>

      <Show when={dragOver()}>
        <div class="shelf-drop-indicator">
          Drop to add
        </div>
      </Show>
    </div>
  );
}
