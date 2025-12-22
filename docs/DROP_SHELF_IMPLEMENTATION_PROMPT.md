# Drop Shelf Implementation Prompt

> **For AI Agent**: This prompt guides you through implementing the drop shelf feature for floatty. Read the architecture doc first, then follow the phases below.

---

## Context

You are implementing a "drop shelf" feature for **floatty**, a Tauri v2 terminal emulator. This feature allows users to drag files into the app and stage them on floating shelves—inspired by the [Dropover](https://dropoverapp.com/) macOS app.

**Read first**: `docs/DROP_SHELF_ARCHITECTURE.md` contains the full design, data flows, and component specifications.

**Key files to understand before starting**:
- `src-tauri/src/lib.rs` — App setup, existing Tauri commands
- `src-tauri/src/db.rs` — Existing SQLite patterns (reuse for shelf storage)
- `src/components/Terminal.tsx` — How components are structured
- `src/hooks/useTabStore.ts` — SolidJS store patterns used in this codebase
- `CLAUDE.md` — Critical SolidJS gotchas and PTY patterns

---

## Implementation Phases

### Phase 1: Rust Foundation

#### 1.1 Create shelf module structure

Create `src-tauri/src/shelf/mod.rs`:
```rust
mod manager;
mod store;
mod drag_drop;

pub use manager::{Shelf, ShelfItem, ShelfManager};
pub use store::ShelfStore;
pub use drag_drop::setup_drag_drop_handler;
```

#### 1.2 Implement ShelfStore (`src-tauri/src/shelf/store.rs`)

Use the existing `db.rs` patterns. The store should:

1. **Initialize schema** — Add tables to the existing SQLite database (`~/.floatty/ctx_markers.db`):
```sql
CREATE TABLE IF NOT EXISTS shelves (
    id TEXT PRIMARY KEY,
    name TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS shelf_items (
    id TEXT PRIMARY KEY,
    shelf_id TEXT NOT NULL REFERENCES shelves(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    name TEXT NOT NULL,
    size INTEGER NOT NULL,
    kind TEXT NOT NULL,  -- "file", "directory", "image", "video", etc.
    added_at TEXT NOT NULL,
    FOREIGN KEY (shelf_id) REFERENCES shelves(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_shelf_items_shelf ON shelf_items(shelf_id);
```

2. **Implement CRUD operations**:
   - `insert_shelf(shelf: &Shelf) -> Result<()>`
   - `insert_items(shelf_id: &str, items: &[ShelfItem]) -> Result<()>`
   - `get_all_shelves() -> Result<Vec<Shelf>>`
   - `get_shelf_items(shelf_id: &str) -> Result<Vec<ShelfItem>>`
   - `delete_shelf(shelf_id: &str) -> Result<()>`
   - `delete_items(item_ids: &[String]) -> Result<()>`
   - `update_shelf_name(shelf_id: &str, name: &str) -> Result<()>`

3. **Use existing connection patterns** from `db.rs` — WAL mode, same DB path.

#### 1.3 Implement ShelfManager (`src-tauri/src/shelf/manager.rs`)

```rust
use std::path::PathBuf;
use chrono::{DateTime, Utc};
use uuid::Uuid;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Shelf {
    pub id: String,
    pub name: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub items: Vec<ShelfItem>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ShelfItem {
    pub id: String,
    pub path: PathBuf,
    pub name: String,
    pub size: u64,
    pub kind: String,
    pub added_at: DateTime<Utc>,
}

pub struct ShelfManager {
    store: ShelfStore,
    shelf_counter: usize,  // For auto-naming "Shelf 1", "Shelf 2", etc.
}

impl ShelfManager {
    pub fn new(store: ShelfStore) -> Self;

    /// Create shelf with auto-generated name if None provided
    pub fn create_shelf(&mut self, name: Option<String>) -> Result<Shelf>;

    /// Add paths to existing shelf, returns created items
    pub fn add_to_shelf(&mut self, shelf_id: &str, paths: Vec<PathBuf>) -> Result<Vec<ShelfItem>>;

    /// Create new shelf AND add files atomically
    pub fn create_and_add(&mut self, paths: Vec<PathBuf>) -> Result<Shelf>;

    /// List all shelves with their items
    pub fn list_shelves(&self) -> Result<Vec<Shelf>>;

    /// Remove specific items from a shelf
    pub fn remove_items(&mut self, shelf_id: &str, item_ids: Vec<String>) -> Result<()>;

    /// Delete entire shelf
    pub fn delete_shelf(&mut self, shelf_id: &str) -> Result<()>;

    /// Rename shelf
    pub fn rename_shelf(&mut self, shelf_id: &str, name: String) -> Result<()>;
}
```

**Helper function needed** — Detect file kind from path:
```rust
fn detect_file_kind(path: &Path) -> String {
    if path.is_dir() {
        return "directory".to_string();
    }
    match path.extension().and_then(|e| e.to_str()) {
        Some("png" | "jpg" | "jpeg" | "gif" | "webp" | "svg") => "image",
        Some("mp4" | "mov" | "avi" | "mkv" | "webm") => "video",
        Some("mp3" | "wav" | "flac" | "ogg" | "m4a") => "audio",
        Some("pdf") => "pdf",
        Some("zip" | "tar" | "gz" | "7z" | "rar") => "archive",
        _ => "file",
    }.to_string()
}
```

#### 1.4 Implement DragDropHandler (`src-tauri/src/shelf/drag_drop.rs`)

```rust
use tauri::{DragDropEvent, Emitter, Listener, Manager, WebviewWindow};
use std::sync::atomic::{AtomicU64, Ordering};

// Guard against duplicate events (Tauri bug #14134)
static LAST_EVENT_ID: AtomicU64 = AtomicU64::new(0);

pub fn setup_drag_drop_handler(window: &WebviewWindow) {
    let window_clone = window.clone();

    window.on_drag_drop_event(move |event| {
        match event {
            DragDropEvent::Enter { paths, position } => {
                // Dedupe check
                let event_hash = hash_paths_and_position(&paths, &position);
                let last = LAST_EVENT_ID.swap(event_hash, Ordering::SeqCst);
                if last == event_hash {
                    return; // Duplicate, skip
                }

                // Emit to frontend
                let _ = window_clone.emit("shelf:drag-enter", serde_json::json!({
                    "paths": paths,
                    "position": { "x": position.x, "y": position.y }
                }));
            }
            DragDropEvent::Over { position } => {
                let _ = window_clone.emit("shelf:drag-over", serde_json::json!({
                    "position": { "x": position.x, "y": position.y }
                }));
            }
            DragDropEvent::Drop { paths, position } => {
                let _ = window_clone.emit("shelf:drag-drop", serde_json::json!({
                    "paths": paths,
                    "position": { "x": position.x, "y": position.y }
                }));
            }
            DragDropEvent::Leave => {
                LAST_EVENT_ID.store(0, Ordering::SeqCst);
                let _ = window_clone.emit("shelf:drag-leave", ());
            }
        }
    });
}

fn hash_paths_and_position(paths: &[PathBuf], pos: &PhysicalPosition<f64>) -> u64 {
    use std::hash::{Hash, Hasher};
    use std::collections::hash_map::DefaultHasher;

    let mut hasher = DefaultHasher::new();
    for p in paths {
        p.hash(&mut hasher);
    }
    (pos.x as i64).hash(&mut hasher);
    (pos.y as i64).hash(&mut hasher);
    hasher.finish()
}
```

#### 1.5 Register Tauri commands (`src-tauri/src/lib.rs`)

Add to existing `lib.rs`:

```rust
mod shelf;

use shelf::{ShelfManager, ShelfStore, setup_drag_drop_handler};

#[tauri::command]
async fn list_shelves(
    state: tauri::State<'_, std::sync::Mutex<ShelfManager>>
) -> Result<Vec<shelf::Shelf>, String> {
    state.lock().unwrap().list_shelves().map_err(|e| e.to_string())
}

#[tauri::command]
async fn create_shelf(
    state: tauri::State<'_, std::sync::Mutex<ShelfManager>>,
    name: Option<String>,
    paths: Vec<std::path::PathBuf>,
) -> Result<shelf::Shelf, String> {
    let mut manager = state.lock().unwrap();
    if paths.is_empty() {
        manager.create_shelf(name).map_err(|e| e.to_string())
    } else {
        manager.create_and_add(paths).map_err(|e| e.to_string())
    }
}

#[tauri::command]
async fn add_to_shelf(
    state: tauri::State<'_, std::sync::Mutex<ShelfManager>>,
    shelf_id: String,
    paths: Vec<std::path::PathBuf>,
) -> Result<Vec<shelf::ShelfItem>, String> {
    state.lock().unwrap()
        .add_to_shelf(&shelf_id, paths)
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn remove_shelf_items(
    state: tauri::State<'_, std::sync::Mutex<ShelfManager>>,
    shelf_id: String,
    item_ids: Vec<String>,
) -> Result<(), String> {
    state.lock().unwrap()
        .remove_items(&shelf_id, item_ids)
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn delete_shelf(
    state: tauri::State<'_, std::sync::Mutex<ShelfManager>>,
    shelf_id: String,
) -> Result<(), String> {
    state.lock().unwrap()
        .delete_shelf(&shelf_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn rename_shelf(
    state: tauri::State<'_, std::sync::Mutex<ShelfManager>>,
    shelf_id: String,
    name: String,
) -> Result<(), String> {
    state.lock().unwrap()
        .rename_shelf(&shelf_id, name)
        .map_err(|e| e.to_string())
}
```

In the builder setup:
```rust
tauri::Builder::default()
    .plugin(tauri_plugin_fs::init())
    // ... existing plugins
    .manage(std::sync::Mutex::new(ShelfManager::new(store)))
    .invoke_handler(tauri::generate_handler![
        // ... existing handlers
        list_shelves,
        create_shelf,
        add_to_shelf,
        remove_shelf_items,
        delete_shelf,
        rename_shelf,
    ])
    .setup(|app| {
        // ... existing setup
        if let Some(window) = app.get_webview_window("main") {
            setup_drag_drop_handler(&window);
        }
        Ok(())
    })
```

---

### Phase 2: Frontend Foundation

#### 2.1 Create shelf store (`src/hooks/useShelfStore.ts`)

Follow the patterns in `useTabStore.ts`:

```typescript
import { createStore } from 'solid-js/store';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export interface ShelfItem {
  id: string;
  path: string;
  name: string;
  size: number;
  kind: string;
  addedAt: string;
}

export interface Shelf {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  items: ShelfItem[];
}

interface DragState {
  isDragging: boolean;
  paths: string[];
  position: { x: number; y: number };
}

interface ShelfState {
  shelves: Shelf[];
  drag: DragState;
  overlayVisible: boolean;
  hoveredShelfId: string | null;
}

const [state, setState] = createStore<ShelfState>({
  shelves: [],
  drag: { isDragging: false, paths: [], position: { x: 0, y: 0 } },
  overlayVisible: false,
  hoveredShelfId: null,
});

export function useShelfStore() {
  return {
    // Accessors
    get shelves() { return state.shelves; },
    get isDragging() { return state.drag.isDragging; },
    get draggedPaths() { return state.drag.paths; },
    get overlayVisible() { return state.overlayVisible; },
    get hoveredShelfId() { return state.hoveredShelfId; },

    // Actions
    async loadShelves() {
      const shelves = await invoke<Shelf[]>('list_shelves');
      setState('shelves', shelves);
    },

    async createShelf(paths: string[]) {
      const shelf = await invoke<Shelf>('create_shelf', { name: null, paths });
      setState('shelves', (prev) => [...prev, shelf]);
      return shelf;
    },

    async addToShelf(shelfId: string, paths: string[]) {
      const items = await invoke<ShelfItem[]>('add_to_shelf', { shelfId, paths });
      setState('shelves', (s) => s.id === shelfId, 'items', (prev) => [...prev, ...items]);
    },

    async removeItems(shelfId: string, itemIds: string[]) {
      await invoke('remove_shelf_items', { shelfId, itemIds });
      setState('shelves', (s) => s.id === shelfId, 'items', (prev) =>
        prev.filter((i) => !itemIds.includes(i.id))
      );
    },

    async deleteShelf(shelfId: string) {
      await invoke('delete_shelf', { shelfId });
      setState('shelves', (prev) => prev.filter((s) => s.id !== shelfId));
    },

    async renameShelf(shelfId: string, name: string) {
      await invoke('rename_shelf', { shelfId, name });
      setState('shelves', (s) => s.id === shelfId, 'name', name);
    },

    // Drag state management
    setDragEnter(paths: string[], position: { x: number; y: number }) {
      setState({
        drag: { isDragging: true, paths, position },
        overlayVisible: true,
      });
    },

    setDragOver(position: { x: number; y: number }) {
      setState('drag', 'position', position);
    },

    setDragLeave() {
      setState({
        drag: { isDragging: false, paths: [], position: { x: 0, y: 0 } },
        overlayVisible: false,
        hoveredShelfId: null,
      });
    },

    setHoveredShelf(shelfId: string | null) {
      setState('hoveredShelfId', shelfId);
    },

    hideOverlay() {
      setState('overlayVisible', false);
    },
  };
}

// Initialize event listeners (call once at app startup)
export async function initShelfListeners() {
  const store = useShelfStore();

  await listen<{ paths: string[]; position: { x: number; y: number } }>(
    'shelf:drag-enter',
    (event) => {
      store.setDragEnter(event.payload.paths, event.payload.position);
    }
  );

  await listen<{ position: { x: number; y: number } }>(
    'shelf:drag-over',
    (event) => {
      store.setDragOver(event.payload.position);
    }
  );

  await listen<{ paths: string[]; position: { x: number; y: number } }>(
    'shelf:drag-drop',
    async (event) => {
      const { paths } = event.payload;
      const hoveredId = store.hoveredShelfId;

      if (hoveredId) {
        await store.addToShelf(hoveredId, paths);
      } else {
        await store.createShelf(paths);
      }

      store.setDragLeave();
    }
  );

  await listen('shelf:drag-leave', () => {
    store.setDragLeave();
  });

  // Load initial shelves
  await store.loadShelves();
}
```

#### 2.2 Create ShelfOverlay component (`src/components/ShelfOverlay.tsx`)

**CRITICAL**: Follow SolidJS patterns from `CLAUDE.md`:
- Do NOT destructure props
- Use `<Key>` for lists of heavy components
- Access store values through function calls

```tsx
import { Show, For, createEffect, onCleanup } from 'solid-js';
import { useShelfStore, Shelf } from '../hooks/useShelfStore';
import './ShelfOverlay.css';

export function ShelfOverlay() {
  const store = useShelfStore();

  // Close on Escape
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      store.hideOverlay();
    }
  };

  createEffect(() => {
    if (store.overlayVisible) {
      window.addEventListener('keydown', handleKeyDown);
      onCleanup(() => window.removeEventListener('keydown', handleKeyDown));
    }
  });

  return (
    <Show when={store.overlayVisible}>
      <div class="shelf-overlay-backdrop">
        <div class="shelf-overlay">
          <div class="drag-preview">
            <span class="file-icon">📄</span>
            <span class="file-count">
              {store.draggedPaths.length} {store.draggedPaths.length === 1 ? 'file' : 'files'}
            </span>
          </div>

          <Show
            when={store.shelves.length > 0}
            fallback={<NewShelfZone />}
          >
            <div class="shelf-grid">
              <For each={store.shelves}>
                {(shelf) => (
                  <ShelfDropTarget
                    shelf={shelf}
                    isHovered={store.hoveredShelfId === shelf.id}
                  />
                )}
              </For>
              <NewShelfButton />
            </div>
          </Show>
        </div>
      </div>
    </Show>
  );
}

function ShelfDropTarget(props: { shelf: Shelf; isHovered: boolean }) {
  const store = useShelfStore();

  return (
    <div
      class="shelf-drop-target"
      classList={{ hovered: props.isHovered }}
      onMouseEnter={() => store.setHoveredShelf(props.shelf.id)}
      onMouseLeave={() => store.setHoveredShelf(null)}
    >
      <div class="shelf-icon">📁</div>
      <div class="shelf-name">{props.shelf.name}</div>
      <div class="shelf-count">{props.shelf.items.length} items</div>
    </div>
  );
}

function NewShelfZone() {
  const store = useShelfStore();

  return (
    <div
      class="new-shelf-zone"
      onMouseEnter={() => store.setHoveredShelf(null)}
    >
      <div class="new-shelf-icon">+</div>
      <p>Drop to create a new shelf</p>
    </div>
  );
}

function NewShelfButton() {
  const store = useShelfStore();

  return (
    <div
      class="new-shelf-button"
      onMouseEnter={() => store.setHoveredShelf(null)}
    >
      <div class="new-shelf-icon">+</div>
      <span>New Shelf</span>
    </div>
  );
}
```

#### 2.3 Create ShelfOverlay styles (`src/components/ShelfOverlay.css`)

```css
.shelf-overlay-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
}

.shelf-overlay {
  background: var(--bg-secondary, #1e1e2e);
  border-radius: 12px;
  padding: 24px;
  min-width: 400px;
  max-width: 600px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
}

.drag-preview {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  background: var(--bg-tertiary, #2a2a3e);
  border-radius: 8px;
  margin-bottom: 20px;
}

.file-icon {
  font-size: 20px;
}

.file-count {
  color: var(--text-primary, #cdd6f4);
  font-weight: 500;
}

.shelf-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  gap: 12px;
}

.shelf-drop-target,
.new-shelf-button {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 20px 16px;
  background: var(--bg-tertiary, #2a2a3e);
  border: 2px solid transparent;
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.shelf-drop-target:hover,
.shelf-drop-target.hovered,
.new-shelf-button:hover {
  border-color: var(--accent, #89b4fa);
  background: var(--bg-hover, #313244);
}

.shelf-icon,
.new-shelf-icon {
  font-size: 32px;
  margin-bottom: 8px;
}

.new-shelf-icon {
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--accent, #89b4fa);
  color: var(--bg-primary, #1e1e2e);
  border-radius: 50%;
  font-size: 24px;
  font-weight: bold;
}

.shelf-name {
  color: var(--text-primary, #cdd6f4);
  font-weight: 500;
  text-align: center;
}

.shelf-count {
  color: var(--text-secondary, #a6adc8);
  font-size: 12px;
  margin-top: 4px;
}

.new-shelf-zone {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 48px;
  border: 2px dashed var(--border, #45475a);
  border-radius: 12px;
  text-align: center;
}

.new-shelf-zone p {
  color: var(--text-secondary, #a6adc8);
  margin-top: 12px;
}
```

#### 2.4 Integrate into App

In your main App component or layout, add the overlay:

```tsx
import { onMount } from 'solid-js';
import { ShelfOverlay } from './components/ShelfOverlay';
import { initShelfListeners } from './hooks/useShelfStore';

function App() {
  onMount(() => {
    initShelfListeners();
  });

  return (
    <>
      {/* ... existing app content ... */}
      <ShelfOverlay />
    </>
  );
}
```

---

### Phase 3: Shelf Management Panel

#### 3.1 Create ShelfPanel component (`src/components/ShelfPanel.tsx`)

This is the persistent view for managing shelves (not just during drag):

```tsx
import { Show, For, createSignal } from 'solid-js';
import { Key } from '@solid-primitives/keyed';
import { useShelfStore, Shelf, ShelfItem } from '../hooks/useShelfStore';
import './ShelfPanel.css';

export function ShelfPanel() {
  const store = useShelfStore();
  const [selectedShelf, setSelectedShelf] = createSignal<string | null>(null);

  return (
    <div class="shelf-panel">
      <header class="shelf-panel-header">
        <h2>Shelves</h2>
        <button
          class="new-shelf-btn"
          onClick={() => store.createShelf([])}
        >
          + New
        </button>
      </header>

      <div class="shelf-list">
        <Key each={store.shelves} by={(shelf) => shelf.id}>
          {(shelf) => (
            <ShelfCard
              shelf={shelf()}
              isSelected={selectedShelf() === shelf().id}
              onSelect={() => setSelectedShelf(shelf().id)}
            />
          )}
        </Key>
      </div>

      <Show when={selectedShelf()}>
        {(id) => {
          const shelf = () => store.shelves.find((s) => s.id === id());
          return (
            <Show when={shelf()}>
              {(s) => <ShelfDetail shelf={s()} />}
            </Show>
          );
        }}
      </Show>
    </div>
  );
}

function ShelfCard(props: { shelf: Shelf; isSelected: boolean; onSelect: () => void }) {
  const store = useShelfStore();
  const [editing, setEditing] = createSignal(false);
  let inputRef: HTMLInputElement | undefined;

  const handleRename = (newName: string) => {
    if (newName.trim() && newName !== props.shelf.name) {
      store.renameShelf(props.shelf.id, newName.trim());
    }
    setEditing(false);
  };

  return (
    <div
      class="shelf-card"
      classList={{ selected: props.isSelected }}
      onClick={props.onSelect}
    >
      <div class="shelf-card-header">
        <Show
          when={editing()}
          fallback={
            <h3 onDblClick={() => {
              setEditing(true);
              setTimeout(() => inputRef?.focus(), 0);
            }}>
              {props.shelf.name}
            </h3>
          }
        >
          <input
            ref={inputRef}
            value={props.shelf.name}
            onBlur={(e) => handleRename(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleRename(e.currentTarget.value);
              if (e.key === 'Escape') setEditing(false);
            }}
          />
        </Show>

        <button
          class="delete-btn"
          onClick={(e) => {
            e.stopPropagation();
            store.deleteShelf(props.shelf.id);
          }}
        >
          ×
        </button>
      </div>

      <div class="shelf-card-preview">
        <For each={props.shelf.items.slice(0, 4)}>
          {(item) => <FileIcon kind={item.kind} />}
        </For>
        <Show when={props.shelf.items.length > 4}>
          <span class="more-count">+{props.shelf.items.length - 4}</span>
        </Show>
      </div>

      <div class="shelf-card-meta">
        {props.shelf.items.length} items
      </div>
    </div>
  );
}

function ShelfDetail(props: { shelf: Shelf }) {
  const store = useShelfStore();
  const [selectedItems, setSelectedItems] = createSignal<Set<string>>(new Set());

  const toggleItem = (id: string) => {
    setSelectedItems((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const removeSelected = () => {
    store.removeItems(props.shelf.id, [...selectedItems()]);
    setSelectedItems(new Set());
  };

  return (
    <div class="shelf-detail">
      <header>
        <h3>{props.shelf.name}</h3>
        <Show when={selectedItems().size > 0}>
          <button onClick={removeSelected}>
            Remove {selectedItems().size} items
          </button>
        </Show>
      </header>

      <div class="item-grid">
        <For each={props.shelf.items}>
          {(item) => (
            <div
              class="item-card"
              classList={{ selected: selectedItems().has(item.id) }}
              onClick={() => toggleItem(item.id)}
            >
              <FileIcon kind={item.kind} />
              <span class="item-name" title={item.path}>{item.name}</span>
              <span class="item-size">{formatSize(item.size)}</span>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}

function FileIcon(props: { kind: string }) {
  const icons: Record<string, string> = {
    directory: '📁',
    image: '🖼️',
    video: '🎬',
    audio: '🎵',
    pdf: '📕',
    archive: '📦',
    file: '📄',
  };
  return <span class="file-icon">{icons[props.kind] || '📄'}</span>;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}
```

#### 3.2 Add keyboard shortcut for shelf panel

In `src/lib/keybinds.ts`, add:

```typescript
// Add to keybind definitions
{ key: 'D', modifiers: ['cmd', 'shift'], action: 'toggleShelfPanel' }
```

---

### Phase 4: Platform-Specific Overlay (Optional Enhancement)

#### 4.1 macOS NSPanel integration

Only if you want true floating panel behavior on macOS. This is optional—the backdrop overlay works cross-platform.

Add to `Cargo.toml`:
```toml
[target.'cfg(target_os = "macos")'.dependencies]
tauri-nspanel = { git = "https://github.com/ahkohd/tauri-nspanel", branch = "v2.1" }
```

Create `src-tauri/src/shelf/overlay_macos.rs`:
```rust
#[cfg(target_os = "macos")]
use tauri_nspanel::{PanelBuilder, PanelLevel, ManagerExt, tauri_panel};

#[cfg(target_os = "macos")]
tauri_panel! {
    panel!(ShelfOverlayPanel {
        config: {
            can_become_key_window: false,
            is_floating_panel: true
        }
    })
}

#[cfg(target_os = "macos")]
pub fn show_overlay_panel(app: &tauri::AppHandle) -> Result<(), String> {
    let panel = PanelBuilder::<_, ShelfOverlayPanel>::new(app, "shelf-overlay")
        .url(tauri::WebviewUrl::App("overlay.html".into()))
        .level(PanelLevel::Floating)
        .build()
        .map_err(|e| e.to_string())?;

    panel.show();
    Ok(())
}

#[cfg(target_os = "macos")]
pub fn hide_overlay_panel(app: &tauri::AppHandle) {
    if let Ok(panel) = app.get_webview_panel("shelf-overlay") {
        panel.to_window().close().ok();
    }
}
```

---

## Testing Checklist

### Phase 1 Tests
- [ ] SQLite tables created on first run
- [ ] `list_shelves` returns empty array initially
- [ ] `create_shelf` with paths creates shelf with items
- [ ] `add_to_shelf` appends items correctly
- [ ] `delete_shelf` removes shelf and all items (CASCADE)
- [ ] Drag events emit to frontend correctly

### Phase 2 Tests
- [ ] Overlay appears on file drag into window
- [ ] Overlay disappears on drag leave
- [ ] Drop on empty state creates new shelf
- [ ] Drop on existing shelf adds items
- [ ] Escape key closes overlay

### Phase 3 Tests
- [ ] ShelfPanel shows all shelves
- [ ] Double-click to rename works
- [ ] Delete button removes shelf
- [ ] Item selection and removal works
- [ ] Keyboard shortcut toggles panel

---

## Error Handling

1. **File access errors**: If a referenced file is moved/deleted, show a "missing" indicator in the UI rather than crashing.

2. **Database errors**: Wrap all SQLite operations in proper error handling; surface user-friendly messages.

3. **Event deduplication**: The drag handler includes deduplication for Tauri bug #14134.

---

## Performance Considerations

1. **Lazy loading**: For shelves with many items, paginate or virtualize the item list.

2. **Thumbnail caching**: If adding file previews, cache thumbnails in `~/.floatty/cache/`.

3. **Debounce drag-over**: The `Over` event fires continuously; consider debouncing if doing expensive hit-testing.

---

## Future Enhancements (Out of Scope)

- Drag files OUT of shelves to other apps
- Cloud sync of shelves
- File watching for moved/deleted references
- Thumbnail previews for images
- Quick actions (share, compress, etc.)
