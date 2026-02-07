import { onMount, onCleanup, createSignal, Show, createEffect, on } from 'solid-js';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { confirm } from '@tauri-apps/plugin-dialog';
import { Terminal } from './components/Terminal';
import { WorkspaceProvider } from './context/WorkspaceContext';
import { themeStore } from './hooks/useThemeStore';
import { tabStore } from './hooks/useTabStore';
import { layoutStore } from './hooks/useLayoutStore';
import { paneStore } from './hooks/usePaneStore';
import { getWorkspacePersistence } from './hooks/useWorkspacePersistence';
import { initHttpClient } from './lib/httpClient';
import { hasPendingUpdates, forceSyncNow, getSyncStatus } from './hooks/useSyncedYDoc';
import { useSyncHealth } from './hooks/useSyncHealth';
import { registerHandlers } from './lib/handlers';
// Initialize logger early - intercepts console.* calls and forwards to Rust log files
import './lib/logger';
import './App.css';

// Type for Tauri drag-drop event payload
interface DragDropPayload {
  paths: string[];
  position: { x: number; y: number };
}

function App() {
  let unlistenDragDrop: UnlistenFn | undefined;
  const [serverConnected, setServerConnected] = createSignal(false);
  const [serverError, setServerError] = createSignal<string | null>(null);
  const [workspaceLoaded, setWorkspaceLoaded] = createSignal(false);
  const [workspaceError, setWorkspaceError] = createSignal<string | null>(null);
  const persistence = getWorkspacePersistence();
  let workspaceLoadStarted = false;
  let workspaceLoadInFlight = false;

  // Phase 3: Initialize HTTP client before loading workspace
  // The HTTP client connects to floatty-server (spawned by Tauri)
  onMount(async () => {
    try {
      await initHttpClient();
      console.log('[App] HTTP client connected to floatty-server');
      setServerConnected(true);
    } catch (err) {
      console.error('[App] Failed to connect to floatty-server:', err);
      setServerError(String(err));
    }
  });

  // Register block handlers (sh::, ai::, daily::)
  onMount(() => {
    registerHandlers();
  });

  // Start sync health checking (polls every 30s, detects WS drift)
  useSyncHealth();

  // Load saved theme and terminal config on startup (after server connected)
  onMount(async () => {
    // Config loading moved to terminalManager.attach() to fix race condition
    themeStore.loadTheme();
  });

  // Load workspace once server is connected
  createEffect(
    on(
      serverConnected,
      (connected) => {
        if (!connected) return;
        if (workspaceLoadStarted || workspaceLoadInFlight) return;

        workspaceLoadStarted = true;
        workspaceLoadInFlight = true;

        // Load workspace layout state (FLO-81)
        // This must happen before Terminal component renders to avoid flickering.
        void (async () => {
          try {
            await persistence.loadWorkspace();
            setWorkspaceLoaded(true);
          } catch (err) {
            console.error('[App] Failed to load workspace:', err);
            setWorkspaceError(String(err));
            // Still mark loaded so app isn't permanently stuck, but error is visible
            setWorkspaceLoaded(true);
          } finally {
            workspaceLoadInFlight = false;
          }
        })();
      },
      { defer: true }
    )
  );

  // Listen for file drag-drop from Finder
  onMount(async () => {
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
  // Includes sync gate to prevent data loss
  onMount(async () => {
    const currentWindow = getCurrentWindow();
    const unlisten = await currentWindow.onCloseRequested(async (event) => {
      console.log('[App] onCloseRequested triggered');
      event.preventDefault(); // Block default close

      // Check for pending Y.Doc updates - prevent data loss
      const pending = hasPendingUpdates();
      console.log('[App] hasPendingUpdates:', pending);
      if (pending) {
        const syncStatus = getSyncStatus();
        console.log('[App] syncStatus:', syncStatus);
        const message = syncStatus === 'error'
          ? 'Sync is failing. Changes are saved locally but won\'t appear on other devices until sync recovers.'
          : 'Changes haven\'t synced to the server yet. They\'re safe locally, but wait to ensure they reach other devices.';

        console.log('[App] About to show confirm dialog...');
        // Use Tauri native dialog (window.confirm fails silently in Tauri webview)
        const proceed = await confirm(message, {
          title: 'Unsynced Changes',
          kind: 'warning',
          okLabel: 'Close Anyway',
          cancelLabel: 'Wait',
        });
        console.log('[App] User response:', proceed);
        if (!proceed) {
          return; // User cancelled close
        }

        // If not in error state, try one final sync (with timeout)
        if (syncStatus !== 'error') {
          try {
            console.log('[App] Attempting final sync before close...');
            // 3 second timeout - don't hang forever if server is dead
            const syncPromise = forceSyncNow();
            const timeoutPromise = new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('Sync timeout')), 3000)
            );
            await Promise.race([syncPromise, timeoutPromise]);
            console.log('[App] Final sync completed');
          } catch (err) {
            console.error('[App] Final sync failed:', err);
            // Ask user again since sync failed
            const closeAnyway = await confirm(
              'Couldn\'t sync before closing. Changes are safe locally and will sync when the server is back.',
              {
                title: 'Sync Failed',
                kind: 'warning',
                okLabel: 'Close Anyway',
                cancelLabel: 'Keep Trying',
              }
            );
            if (!closeAnyway) {
              return; // User cancelled
            }
          }
        }
      }

      // Kill all PTY processes to prevent zombies
      try {
        const count = await invoke<number>('plugin:pty|kill_all');
        console.log(`[App] Killed ${count} PTY sessions on close`);
      } catch (e) {
        console.warn('[App] Failed to kill PTY sessions:', e);
      }

      // Save workspace (best effort - don't block close if it fails)
      try {
        await persistence.saveWorkspace();
      } catch (e) {
        console.warn('[App] Failed to save workspace on close:', e);
      }

      // Always destroy - don't let anything block the close
      await currentWindow.destroy();
    });
    onCleanup(() => unlisten());
  });

  // Kill PTY processes on browser refresh (Cmd+R) - beforeunload fires before Tauri close
  // Also warn about unsaved changes
  onMount(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      // Warn user about pending updates
      if (hasPendingUpdates()) {
        e.preventDefault();
        e.returnValue = 'You have unsaved changes.';
        return e.returnValue;
      }
      // Synchronous invoke isn't possible, but we can fire-and-forget
      // The process cleanup is best-effort for reload scenarios
      invoke('plugin:pty|kill_all').catch(() => {});
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    onCleanup(() => window.removeEventListener('beforeunload', handleBeforeUnload));
  });

  onCleanup(() => {
    unlistenDragDrop?.();
  });

  return (
    <Show
      when={!serverError()}
      fallback={
        <div class="error-screen">
          <h2>Failed to connect to floatty-server</h2>
          <pre>{serverError()}</pre>
          <p>Check the logs and restart the application.</p>
        </div>
      }
    >
      <Show when={workspaceLoaded()} fallback={<div class="loading">Loading...</div>}>
        <Show when={workspaceError()}>
          <div class="workspace-error-banner" style="background: var(--color-ansi-yellow, #b58900); color: #000; padding: 4px 12px; font-size: 12px;">
            ⚠ Workspace layout failed to load: {workspaceError()} — using defaults
          </div>
        </Show>
        <WorkspaceProvider>
          <Terminal />
        </WorkspaceProvider>
      </Show>
    </Show>
  );
}

export default App;
