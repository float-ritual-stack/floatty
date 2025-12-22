# Drop Shelf Architecture

A Dropover-inspired drag-and-drop staging system for floatty.

## Executive Summary

This document outlines the architecture for a "drop shelf" feature that enables users to drag files into floatty and stage them on floating shelves. The design prioritizes zero-friction UX: shelves appear automatically during drag, require no pre-naming, and persist across sessions.

---

## Plugin Analysis

### tauri-nspanel (v2.1)

**What it does**: Creates macOS `NSPanel` windows—specialized floating windows that stay above other app windows.

**Capabilities**:
- `PanelBuilder` API for creating floating overlay windows
- `PanelLevel::Floating` keeps panel above normal windows
- Mouse tracking (enter/exit/move events)
- Can receive keyboard focus (`can_become_key_window`)
- Thread-safe operations on main thread

**Limitations**:
- **macOS only** - requires cross-platform fallback strategy
- No built-in drag-drop handling
- Must manually wire up DragDropEvent from Tauri core

**For drop shelf**: Perfect for the overlay UI that appears during drag operations on macOS. The panel floats above all windows, allowing users to see their shelves while navigating to drop targets.

### tauri-plugin-clipboard

**What it does**: Extends Tauri's clipboard API to handle rich content types.

**Capabilities**:
- Read/write files via URIs (`readFilesURIs()`, `writeFilesURIs()`)
- Image handling (base64)
- HTML/RTF support
- Clipboard change monitoring with event listeners

**Limitations**:
- Clipboard-focused, not drag-drop focused
- File URIs require platform-specific prefixes (`file://` on Linux/macOS)

**For drop shelf**: Supplements drag-drop with paste functionality. Users can:
1. Copy files to clipboard → paste to shelf
2. Copy shelf contents → paste elsewhere

### tauri-plugin-fs

**What it does**: Secure file system access with capability-based permissions.

**Capabilities**:
- CRUD operations: `readFile`, `writeFile`, `remove`, `rename`, `copyFile`
- Directory operations: `mkdir`, `readDir`
- File watching: `watch()`, `watchImmediate()`
- Security: Path traversal prevention, scope-based permissions

**Limitations**:
- Requires explicit permission scopes in capabilities
- No built-in drag-drop integration

**For drop shelf**: Handles all file operations:
- Persisting shelf metadata to disk
- Optional: copying files into managed shelf storage
- Watching shelf directories for external changes

### Tauri Core DragDropEvent (v2)

**What it does**: Native drag-drop events from the Tauri window system.

**Event variants**:
```rust
enum DragDropEvent {
    Enter { paths: Vec<PathBuf>, position: PhysicalPosition<f64> },
    Over { position: PhysicalPosition<f64> },
    Drop { paths: Vec<PathBuf>, position: PhysicalPosition<f64> },
    Leave,
}
```

**JavaScript API**:
```typescript
import { getCurrentWebview } from '@tauri-apps/api/webview';

const unlisten = await getCurrentWebview().onDragDropEvent((event) => {
  if (event.payload.type === 'enter') {
    // Show overlay, paths available at event.payload.paths
  } else if (event.payload.type === 'drop') {
    // Handle file drop
  } else if (event.payload.type === 'leave') {
    // Hide overlay
  }
});
```

**Known issues**:
- Events may fire twice with different IDs ([#14134](https://github.com/tauri-apps/tauri/issues/14134))
- Y coordinates can be incorrect when devtools is open ([#11141](https://github.com/tauri-apps/tauri/discussions/11141))

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              User Drag Operation                            │
└─────────────────────────────────────────────────────────────────────────────┘
                                        │
                                        ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  DragDropEvent::Enter                                                       │
│  ┌────────────────────┐    ┌────────────────────┐    ┌──────────────────┐   │
│  │  Event Handler     │───▶│  OverlayController │───▶│  Panel/Window    │   │
│  │  (Rust)            │    │  (show/position)   │    │  (UI)            │   │
│  └────────────────────┘    └────────────────────┘    └──────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
                                        │
                                        ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  Overlay UI (during drag)                                                   │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                         ┌─────────────────┐                          │   │
│  │  ┌───────────────┐      │  + New Shelf    │      ┌───────────────┐   │   │
│  │  │ Shelf "Alpha" │      │  (appears if    │      │ Shelf "Beta"  │   │   │
│  │  │ 3 files       │      │   no shelves)   │      │ 7 files       │   │   │
│  │  └───────────────┘      └─────────────────┘      └───────────────┘   │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
                                        │
                                        ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  DragDropEvent::Drop                                                        │
│  ┌────────────────────┐    ┌────────────────────┐    ┌──────────────────┐   │
│  │  Drop Handler      │───▶│  ShelfManager      │───▶│  SQLite/FS       │   │
│  │  (determine target)│    │  (add files)       │    │  (persist)       │   │
│  └────────────────────┘    └────────────────────┘    └──────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Component Design

### 1. DragDropHandler (Rust: `src-tauri/src/drag_drop.rs`)

Listens to Tauri window events and coordinates the overlay/drop workflow.

```rust
use tauri::{DragDropEvent, Manager, WebviewWindow};

pub fn setup_drag_drop_handler(window: &WebviewWindow) {
    window.on_drag_drop_event(|event| {
        match event {
            DragDropEvent::Enter { paths, position } => {
                // Emit to frontend: show overlay with file preview
                // Dedupe: track event to avoid double-handling
            }
            DragDropEvent::Over { position } => {
                // Update cursor position for hover detection
            }
            DragDropEvent::Drop { paths, position } => {
                // Determine target shelf from position
                // Add files to shelf or create new shelf
            }
            DragDropEvent::Leave => {
                // Hide overlay
            }
        }
    });
}
```

**Key responsibilities**:
- Event deduplication (guard against [#14134](https://github.com/tauri-apps/tauri/issues/14134))
- Coordinate translation (handle devtools offset issue)
- Emit structured events to frontend

### 2. OverlayController (Rust: `src-tauri/src/shelf_overlay.rs`)

Manages the floating overlay window lifecycle.

```rust
#[cfg(target_os = "macos")]
mod macos {
    use tauri_nspanel::{PanelBuilder, PanelLevel, ManagerExt};

    pub fn show_overlay(app: &AppHandle, shelves: &[Shelf]) -> Result<()> {
        let panel = PanelBuilder::<_, DropShelfPanel>::new(app, "drop-shelf-overlay")
            .url(WebviewUrl::App("overlay.html".into()))
            .level(PanelLevel::Floating)
            .build()?;

        // Position near cursor or center of screen
        panel.show();
        Ok(())
    }
}

#[cfg(not(target_os = "macos"))]
mod fallback {
    // Use a regular Tauri window with:
    // - always_on_top: true
    // - decorations: false
    // - transparent: true
    // - skip_taskbar: true

    pub fn show_overlay(app: &AppHandle, shelves: &[Shelf]) -> Result<()> {
        let window = WebviewWindowBuilder::new(app, "drop-shelf-overlay", /* ... */)
            .always_on_top(true)
            .decorations(false)
            .transparent(true)
            .skip_taskbar(true)
            .build()?;
        Ok(())
    }
}
```

**Platform strategy**:
| Platform | Implementation | Notes |
|----------|----------------|-------|
| macOS | `tauri-nspanel` | True floating panel, best UX |
| Windows/Linux | Always-on-top window | Decorations disabled, transparent |

### 3. ShelfManager (Rust: `src-tauri/src/shelf_manager.rs`)

Core business logic for shelf operations.

```rust
pub struct Shelf {
    pub id: String,           // UUID
    pub name: Option<String>, // Auto-generated if None (e.g., "Shelf 1")
    pub created_at: DateTime<Utc>,
    pub items: Vec<ShelfItem>,
}

pub struct ShelfItem {
    pub id: String,
    pub path: PathBuf,        // Original file location
    pub name: String,         // Display name
    pub size: u64,
    pub kind: FileKind,       // File, Directory, Image, etc.
    pub added_at: DateTime<Utc>,
}

impl ShelfManager {
    /// Create a new shelf with optional name
    /// If name is None, auto-generates "Shelf N"
    pub fn create_shelf(&mut self, name: Option<String>) -> Shelf;

    /// Add files to existing shelf
    pub fn add_to_shelf(&mut self, shelf_id: &str, paths: Vec<PathBuf>) -> Result<()>;

    /// Create new shelf AND add files in one operation (for first drop)
    pub fn create_and_add(&mut self, paths: Vec<PathBuf>) -> Shelf;

    /// Remove files from shelf
    pub fn remove_from_shelf(&mut self, shelf_id: &str, item_ids: Vec<String>) -> Result<()>;

    /// Get all shelves for overlay display
    pub fn list_shelves(&self) -> Vec<Shelf>;

    /// Delete entire shelf
    pub fn delete_shelf(&mut self, shelf_id: &str) -> Result<()>;
}
```

### 4. ShelfStore (Rust: `src-tauri/src/shelf_store.rs`)

Persistence layer using SQLite (same DB as ctx_markers).

```sql
-- Schema
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
    kind TEXT NOT NULL,
    added_at TEXT NOT NULL
);

CREATE INDEX idx_shelf_items_shelf ON shelf_items(shelf_id);
```

**Storage strategy**:
- **Reference mode** (default): Store paths only, files stay in original location
- **Copy mode** (optional): Copy files to `~/.floatty/shelves/{shelf_id}/`

### 5. Overlay UI (SolidJS: `src/components/ShelfOverlay.tsx`)

The visual interface shown during drag operations.

```tsx
import { createSignal, For, Show } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';

interface OverlayProps {
  draggedFiles: string[];
  onDrop: (shelfId: string | null) => void;
}

export function ShelfOverlay(props: OverlayProps) {
  const [shelves, setShelves] = createSignal<Shelf[]>([]);
  const [hoveredShelf, setHoveredShelf] = createSignal<string | null>(null);

  // Load shelves on mount
  onMount(async () => {
    const data = await invoke<Shelf[]>('list_shelves');
    setShelves(data);
  });

  return (
    <div class="shelf-overlay">
      <div class="drop-preview">
        <span class="file-count">{props.draggedFiles.length} files</span>
      </div>

      <Show
        when={shelves().length > 0}
        fallback={<NewShelfZone onDrop={() => props.onDrop(null)} />}
      >
        <div class="shelf-grid">
          <For each={shelves()}>
            {(shelf) => (
              <ShelfDropTarget
                shelf={shelf}
                isHovered={hoveredShelf() === shelf.id}
                onHover={setHoveredShelf}
                onDrop={() => props.onDrop(shelf.id)}
              />
            )}
          </For>
          <NewShelfButton onDrop={() => props.onDrop(null)} />
        </div>
      </Show>
    </div>
  );
}

function NewShelfZone(props: { onDrop: () => void }) {
  return (
    <div class="new-shelf-zone" onDrop={props.onDrop}>
      <div class="icon">📁+</div>
      <p>Drop here to create a new shelf</p>
    </div>
  );
}
```

### 6. Tauri Commands (Rust: `src-tauri/src/lib.rs`)

```rust
#[tauri::command]
async fn list_shelves(state: State<'_, ShelfManager>) -> Result<Vec<Shelf>, String> {
    Ok(state.list_shelves())
}

#[tauri::command]
async fn create_shelf(
    state: State<'_, ShelfManager>,
    name: Option<String>,
    paths: Vec<PathBuf>,
) -> Result<Shelf, String> {
    let shelf = if paths.is_empty() {
        state.create_shelf(name)
    } else {
        state.create_and_add(paths)
    };
    Ok(shelf)
}

#[tauri::command]
async fn add_to_shelf(
    state: State<'_, ShelfManager>,
    shelf_id: String,
    paths: Vec<PathBuf>,
) -> Result<(), String> {
    state.add_to_shelf(&shelf_id, paths).map_err(|e| e.to_string())
}

#[tauri::command]
async fn remove_from_shelf(
    state: State<'_, ShelfManager>,
    shelf_id: String,
    item_ids: Vec<String>,
) -> Result<(), String> {
    state.remove_from_shelf(&shelf_id, item_ids).map_err(|e| e.to_string())
}

#[tauri::command]
async fn delete_shelf(
    state: State<'_, ShelfManager>,
    shelf_id: String,
) -> Result<(), String> {
    state.delete_shelf(&shelf_id).map_err(|e| e.to_string())
}

#[tauri::command]
async fn rename_shelf(
    state: State<'_, ShelfManager>,
    shelf_id: String,
    name: String,
) -> Result<(), String> {
    state.rename_shelf(&shelf_id, name).map_err(|e| e.to_string())
}
```

---

## Data Flow

### Flow 1: First Drop (No Shelves Exist)

```
User drags files over window
         │
         ▼
DragDropEvent::Enter { paths: [...] }
         │
         ▼
OverlayController::show_overlay()
         │
         ├── macOS: Create NSPanel (floating)
         └── Other: Create always-on-top window
         │
         ▼
┌─────────────────────────────────┐
│  Overlay shows:                 │
│  ┌───────────────────────────┐  │
│  │  + Drop to create shelf   │  │
│  │                           │  │
│  └───────────────────────────┘  │
└─────────────────────────────────┘
         │
         ▼
DragDropEvent::Drop { paths: [...], position }
         │
         ▼
ShelfManager::create_and_add(paths)
         │
         ├── Generate UUID for shelf
         ├── Auto-name: "Shelf 1"
         ├── Create ShelfItem for each path
         └── Persist to SQLite
         │
         ▼
Hide overlay, emit "shelf-created" event
```

### Flow 2: Drop on Existing Shelf

```
User drags files over window
         │
         ▼
DragDropEvent::Enter { paths: [...] }
         │
         ▼
OverlayController::show_overlay()
         │
         ▼
┌─────────────────────────────────────────────┐
│  Overlay shows:                             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────┐  │
│  │ "Project A" │  │ "Downloads" │  │  +  │  │
│  │   5 files   │  │   12 files  │  │     │  │
│  └─────────────┘  └─────────────┘  └─────┘  │
└─────────────────────────────────────────────┘
         │
         ▼
DragDropEvent::Over { position }  (continuously)
         │
         ▼
Frontend: Highlight shelf under cursor
         │
         ▼
DragDropEvent::Drop { paths, position }
         │
         ▼
Determine target shelf from position (hit test)
         │
         ▼
ShelfManager::add_to_shelf(shelf_id, paths)
         │
         ▼
Hide overlay, update shelf view
```

### Flow 3: Clipboard Paste to Shelf

```
User copies files (Cmd+C / Ctrl+C)
         │
         ▼
User opens shelf panel (via UI or keyboard shortcut)
         │
         ▼
User pastes (Cmd+V / Ctrl+V)
         │
         ▼
Frontend: invoke('paste_to_shelf', { shelf_id })
         │
         ▼
Rust: clipboard.read_files_uris()
         │
         ▼
ShelfManager::add_to_shelf(shelf_id, paths)
```

---

## User Interactions

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `⌘⇧D` / `Ctrl+Shift+D` | Toggle shelf panel visibility |
| `Delete` / `Backspace` | Remove selected items from shelf |
| `⌘V` / `Ctrl+V` | Paste clipboard to active shelf |
| `Escape` | Close shelf panel / cancel drag |

### Shelf Panel (Persistent View)

Beyond the drag overlay, users need a way to manage shelves when not dragging:

```tsx
// src/components/ShelfPanel.tsx
export function ShelfPanel() {
  return (
    <div class="shelf-panel">
      <header>
        <h2>Shelves</h2>
        <button onClick={createShelf}>+ New</button>
      </header>

      <For each={shelves()}>
        {(shelf) => (
          <ShelfCard
            shelf={shelf}
            onRename={handleRename}
            onDelete={handleDelete}
            onDragStart={handleDragOut}
          />
        )}
      </For>
    </div>
  );
}
```

### Inline Rename (Low-Friction)

When a shelf is created, it gets an auto-generated name. Users can click to rename inline:

```tsx
function ShelfCard(props: { shelf: Shelf }) {
  const [editing, setEditing] = createSignal(false);

  return (
    <div class="shelf-card">
      <Show when={editing()} fallback={
        <h3 onClick={() => setEditing(true)}>{props.shelf.name}</h3>
      }>
        <input
          value={props.shelf.name}
          onBlur={(e) => {
            invoke('rename_shelf', { shelfId: props.shelf.id, name: e.target.value });
            setEditing(false);
          }}
          onKeyDown={(e) => e.key === 'Enter' && e.target.blur()}
        />
      </Show>

      <div class="item-grid">
        <For each={props.shelf.items.slice(0, 4)}>
          {(item) => <FileThumb item={item} />}
        </For>
        <Show when={props.shelf.items.length > 4}>
          <div class="more">+{props.shelf.items.length - 4}</div>
        </Show>
      </div>
    </div>
  );
}
```

---

## Configuration

Add to `~/.floatty/config.toml`:

```toml
[shelf]
enabled = true
storage_mode = "reference"  # "reference" | "copy"
storage_path = "~/.floatty/shelves"  # Only used if storage_mode = "copy"
auto_cleanup_days = 30  # Delete shelves older than N days (0 = never)
overlay_position = "center"  # "center" | "cursor" | "bottom"
```

---

## File Structure

```
src-tauri/src/
├── lib.rs                 # Add shelf commands
├── shelf/
│   ├── mod.rs             # Module exports
│   ├── manager.rs         # ShelfManager business logic
│   ├── store.rs           # SQLite persistence
│   ├── overlay.rs         # OverlayController (platform-specific)
│   └── drag_drop.rs       # DragDropEvent handling

src/
├── components/
│   ├── ShelfOverlay.tsx   # Drag overlay UI
│   ├── ShelfPanel.tsx     # Persistent shelf management view
│   ├── ShelfCard.tsx      # Individual shelf display
│   └── FileThumb.tsx      # File thumbnail/icon
├── hooks/
│   └── useShelfStore.ts   # SolidJS store for shelf state
└── lib/
    └── shelfManager.ts    # Frontend shelf utilities
```

---

## Dependencies to Add

```toml
# Cargo.toml
[target.'cfg(target_os = "macos")'.dependencies]
tauri-nspanel = { git = "https://github.com/ahkohd/tauri-nspanel", branch = "v2.1" }

[dependencies]
tauri-plugin-clipboard = "2"
tauri-plugin-fs = "2"
```

```json
// package.json
{
  "dependencies": {
    "tauri-plugin-clipboard-api": "^2.0.0",
    "@tauri-apps/plugin-fs": "^2.0.0"
  }
}
```

---

## Implementation Phases

### Phase 1: Core Drop Flow
1. Set up DragDropEvent handler in Rust
2. Implement ShelfManager and ShelfStore
3. Create basic overlay window (non-floating initially)
4. Wire up drop → create shelf flow

### Phase 2: Overlay Polish
1. Integrate tauri-nspanel for macOS
2. Implement fallback for Windows/Linux
3. Add hover detection and visual feedback
4. Animate overlay appearance

### Phase 3: Shelf Management
1. Build ShelfPanel component
2. Implement inline rename
3. Add drag-out from shelf
4. Keyboard shortcuts

### Phase 4: Enhancements
1. Clipboard paste support
2. File previews/thumbnails
3. Auto-cleanup of old shelves
4. Optional copy-to-storage mode

---

## Open Questions

1. **Drag out of shelf**: Should files be draggable FROM shelves to other apps?
   - Requires implementing drag source, not just drop target

2. **Terminal integration**: Should dropping files onto terminal paste paths?
   - Could integrate with existing TerminalPane

3. **Cloud sync**: Should shelves sync across devices?
   - Would require cloud backend, out of initial scope

4. **File watching**: Should shelf detect if referenced files are moved/deleted?
   - Could use `tauri-plugin-fs` watch functionality

---

## Sources

- [tauri-nspanel (v2.1)](https://github.com/ahkohd/tauri-nspanel/tree/v2.1)
- [tauri-plugin-clipboard](https://crosscopy.github.io/tauri-plugin-clipboard/)
- [tauri-plugin-fs](https://v2.tauri.app/plugin/file-system/)
- [DragDropEvent API](https://docs.rs/tauri/latest/tauri/enum.DragDropEvent.html)
- [Dropover App](https://dropoverapp.com/)
- [Tauri Drag/Drop Discussion](https://github.com/tauri-apps/tauri/discussions/9696)
