import { onMount, onCleanup } from 'solid-js';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { Terminal } from './components/Terminal';
import { themeStore } from './hooks/useThemeStore';
import { terminalManager } from './lib/terminalManager';
import { tabStore } from './hooks/useTabStore';
import './App.css';

// Type for Tauri drag-drop event payload
interface DragDropPayload {
  paths: string[];
  position: { x: number; y: number };
}

function App() {
  let unlistenDragDrop: UnlistenFn | undefined;

  // Load saved theme and terminal config on startup
  onMount(async () => {
    await terminalManager.loadConfig();
    themeStore.loadTheme();

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

  onCleanup(() => {
    unlistenDragDrop?.();
  });

  return <Terminal />;
}

export default App;
