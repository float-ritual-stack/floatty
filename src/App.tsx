import { onMount, onCleanup, createSignal, Show, createEffect } from 'solid-js';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Terminal } from './components/Terminal';
import { WorkspaceProvider } from './context/WorkspaceContext';
import { themeStore } from './hooks/useThemeStore';
import { tabStore } from './hooks/useTabStore';
import { layoutStore } from './hooks/useLayoutStore';
import { paneStore } from './hooks/usePaneStore';
import { getWorkspacePersistence } from './hooks/useWorkspacePersistence';
import './App.css';

// Type for Tauri drag-drop event payload
interface DragDropPayload {
  paths: string[];
  position: { x: number; y: number };
}

function App() {
  let unlistenDragDrop: UnlistenFn | undefined;
  const [workspaceLoaded, setWorkspaceLoaded] = createSignal(false);
  const persistence = getWorkspacePersistence();

  // Load saved theme and terminal config on startup
  onMount(async () => {
    // Config loading moved to terminalManager.attach() to fix race condition
    themeStore.loadTheme();

    // Load workspace layout state (FLO-81)
    // This must happen before Terminal component renders to avoid flickering
    try {
      await persistence.loadWorkspace();
    } catch (err) {
      console.error('[App] Failed to load workspace:', err);
    }
    setWorkspaceLoaded(true);

    // Listen for file drag-drop from Finder
    // When files are dropped, paste their paths into the active terminal
    unlistenDragDrop = await listen<DragDropPayload>('tauri://drag-drop', (event) => {
      const paths = event.payload.paths;
      if (!paths || paths.length === 0) return;

      // Get active terminal's PTY PID
      const activeTab = tabStore.getActiveTab();
      if (!activeTab || !activeTab.ptyPid) {
        console.warn('[App] No active terminal for drag-drop');
        return;
      }

      // Format paths: quote if spaces, space-separated
      const formattedPaths = paths.map(p =>
        p.includes(' ') ? `"${p}"` : p
      ).join(' ');

      console.log(`[App] Drag-drop: pasting ${paths.length} path(s) to terminal`);
      invoke('plugin:pty|write', {
        pid: activeTab.ptyPid,
        data: formattedPaths
      }).catch(console.error);
    });
  });

  // Save workspace on state changes (debounced)
  // Track changes to tabs, layouts, and pane state
  let isFirstEffectRun = true;
  createEffect(() => {
    // Skip until workspace is loaded
    if (!workspaceLoaded()) return;

    // Access reactive state to trigger effect on changes
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const _ = [
      tabStore.tabs.length,
      tabStore.activeTabId(),
      JSON.stringify(layoutStore.layouts),  // Deep track layout changes
      JSON.stringify(paneStore.getPaneStateForPersistence()),  // Track pane state changes
    ];

    // Skip the first run (immediately after hydration) - nothing changed yet
    if (isFirstEffectRun) {
      isFirstEffectRun = false;
      return;
    }

    persistence.scheduleSave();
  });

  // Save workspace on window close (Tauri's onCloseRequested properly awaits async)
  onMount(async () => {
    const currentWindow = getCurrentWindow();
    const unlisten = await currentWindow.onCloseRequested(async (event) => {
      event.preventDefault(); // Block default close
      await persistence.saveWorkspace();
      await currentWindow.destroy(); // Now close after save completes
    });
    onCleanup(() => unlisten());
  });

  onCleanup(() => {
    unlistenDragDrop?.();
  });

  return (
    <Show when={workspaceLoaded()} fallback={<div class="loading">Loading...</div>}>
      <WorkspaceProvider>
        <Terminal />
      </WorkspaceProvider>
    </Show>
  );
}

export default App;
