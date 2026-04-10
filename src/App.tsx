import { onMount, onCleanup, createSignal, Show, createEffect, on } from 'solid-js';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { confirm } from '@tauri-apps/plugin-dialog';
import { Terminal } from './components/Terminal';
import { WorkspaceProvider } from './context/WorkspaceContext';
import { ConfigProvider } from './context/ConfigContext';
import { themeStore } from './hooks/useThemeStore';
import { tabStore } from './hooks/useTabStore';
import { layoutStore } from './hooks/useLayoutStore';
import { paneStore } from './hooks/usePaneStore';
import { getWorkspacePersistence } from './hooks/useWorkspacePersistence';
import { initHttpClient } from './lib/httpClient';
import { hasPendingUpdates, forceSyncNow, getSyncStatus } from './hooks/useSyncedYDoc';
import * as navigationLib from './lib/navigation';
import { paneLinkStore } from './hooks/usePaneLinkStore';
import { useSyncHealth } from './hooks/useSyncHealth';
import { registerHandlers, registry, executeHandler, createHookBlockStore } from './lib/handlers';
import { blockStore } from './hooks/useBlockStore';
import { recordOrphansDetected } from './lib/syncDiagnostics';
import type { ExecutorActions } from './lib/handlers/types';
// Initialize logger early - intercepts console.* calls and forwards to Rust log files
import { createLogger } from './lib/logger';
import './App.css';

const logger = createLogger('App');
const deepLinkLogger = createLogger('deep-link');

// Type for Tauri drag-drop event payload
interface DragDropPayload {
  paths: string[];
  position: { x: number; y: number };
}

// Orphan info payload from Rust orphan detector (FLO-350)
interface OrphanInfo {
  blockId: string;
  missingParentId: string;
  contentPreview: string;
}

function App() {
  let unlistenDragDrop: UnlistenFn | undefined;
  let unlistenOrphans: UnlistenFn | undefined;
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
      const client = await initHttpClient();
      // Restore outline from localStorage (persists across reloads)
      const savedOutline = localStorage.getItem('floatty-outline') || 'default';
      if (savedOutline !== 'default') {
        client.setOutline(savedOutline);
        logger.info(`Restored outline '${savedOutline}' from localStorage`);
      }
      logger.info('HTTP client connected to floatty-server');
      setServerConnected(true);
    } catch (err) {
      logger.error(`Failed to connect to floatty-server: ${err}`);
      setServerError(String(err));
    }
  });

  // Register block handlers (sh::, ai::, daily::)
  onMount(() => {
    registerHandlers();
  });

  // Listen for outline switch events (dispatched by outline:: handler).
  // Strategy: save to localStorage then reload. Clean re-init avoids SolidJS store reset issues.
  onMount(() => {
    const handler = async (e: Event) => {
      const { name } = (e as CustomEvent).detail;
      const current = localStorage.getItem('floatty-outline') || 'default';
      if (name === current) return;

      logger.info(`Outline switch: ${current} → ${name}`);

      // Create outline if it doesn't exist — abort if we can't confirm
      const serverUrl = window.__FLOATTY_SERVER_URL__;
      const apiKey = window.__FLOATTY_API_KEY__;
      if (serverUrl && apiKey) {
        try {
          const listResp = await fetch(`${serverUrl}/api/v1/outlines`, {
            headers: { 'Authorization': `Bearer ${apiKey}` },
          });
          if (!listResp.ok) {
            logger.error(`Outline switch aborted: could not list outlines (${listResp.status})`);
            return;
          }
          const outlines: { name: string }[] = await listResp.json();
          if (!outlines.some(o => o.name === name)) {
            const createResp = await fetch(`${serverUrl}/api/v1/outlines`, {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ name }),
            });
            if (!createResp.ok) {
              logger.error(`Outline switch aborted: could not create outline '${name}' (${createResp.status})`);
              return;
            }
          }
        } catch (err) {
          logger.error(`Outline switch aborted: fetch error: ${err}`);
          return;
        }
      }

      // Save + reload — cleanest path, all singletons re-init from scratch
      localStorage.setItem('floatty-outline', name);
      window.location.reload();
    };
    window.addEventListener('floatty:switch-outline', handler);
    onCleanup(() => window.removeEventListener('floatty:switch-outline', handler));
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
            logger.error(`Failed to load workspace: ${err}`);
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
        logger.warn('No active terminal for drag-drop');
        return;
      }

      // Format paths: quote if spaces, space-separated
      const formattedPaths = paths.map(p =>
        p.includes(' ') ? `"${p}"` : p
      ).join(' ');

      logger.info(`Drag-drop: pasting ${paths.length} path(s) to terminal`);
      invoke('plugin:pty|write', {
        pid: activeTab.ptyPid,
        data: formattedPaths
      }).catch(err => logger.error(`PTY write failed: ${err}`));
    });
  });

  // Deep link handler: floatty://<verb>/... (release) or floatty-dev://<verb>/... (dev)
  // Scheme isolation via tauri.dev.conf.json — both builds can run simultaneously.
  //
  // Verbs:
  //   navigate/<page>?pane=<uuid>           — navigate to page
  //   block/<id>?pane=<uuid>                — navigate to block (supports short hash)
  //   execute?content=<>&parent=<id>&pane=  — create block + fire handler
  //   upsert?parent=<id>&content=<>&match=  — find-or-create child by prefix
  //
  // Routing priority:
  //   1. ?pane=<uuid> present → resolveLink(pane) → linked outliner
  //   2. No pane hint → active tab's focused/first outliner pane
  //   3. No outliner open → log and skip
  onMount(async () => {
    /** Resolve source pane to target pane via link store + navigation lib */
    const resolvePane = (sourcePaneId: string): string | null => {
      const { resolveTargetPane } = navigationLib;
      return sourcePaneId
        ? (paneLinkStore.resolveLink(sourcePaneId) ?? resolveTargetPane(sourcePaneId))
        : resolveTargetPane('');
    };

    /** Build ExecutorActions for deep link handler execution.
     *  Runs outside any pane context — paneId is empty and focusBlock is a no-op.
     *  Navigation happens separately via the verb's ?pane param.
     *  Handlers that need pane awareness should check paneId before using it. */
    const buildExecutorActions = (): ExecutorActions => ({
      createBlockInside: blockStore.createBlockInside,
      createBlockInsideAtTop: blockStore.createBlockInsideAtTop,
      createBlockAfter: blockStore.createBlockAfter,
      updateBlockContent: blockStore.updateBlockContent,
      updateBlockContentFromExecutor: blockStore.updateBlockContentFromExecutor,
      deleteBlock: blockStore.deleteBlock,
      setBlockOutput: blockStore.setBlockOutput,
      setBlockStatus: blockStore.setBlockStatus,
      getBlock: blockStore.getBlock,
      getParentId: (id) => blockStore.getBlock(id)?.parentId ?? undefined,
      getChildren: (id) => blockStore.getBlock(id)?.childIds ?? [],
      rootIds: blockStore.rootIds,
      paneId: '',
      focusBlock: () => {},
      batchCreateBlocksAfter: blockStore.batchCreateBlocksAfter,
      batchCreateBlocksInside: blockStore.batchCreateBlocksInside,
      batchCreateBlocksInsideAtTop: blockStore.batchCreateBlocksInsideAtTop,
      moveBlock: (blockId, targetParentId, targetIndex) =>
        blockStore.moveBlock(blockId, targetParentId, targetIndex, { origin: 'system' }),
    });

    /** Fire handler for content if a matching prefix is registered */
    const fireHandler = (blockId: string, content: string) => {
      const handler = registry.findHandler(content);
      if (!handler) return;
      const hookStore = createHookBlockStore(
        blockStore.getBlock,
        blockStore.blocks,
        blockStore.rootIds,
        null
      );
      executeHandler(handler, blockId, content, buildExecutorActions(), hookStore)
        .catch(err => {
          deepLinkLogger.error(`handler failed: ${err}`);
          blockStore.setBlockStatus(blockId, 'error');
        });
    };

    const unlistenDeepLink = await listen<string>('deep-link', (event) => {
      try {
        const url = new URL(event.payload);
        const verb = url.hostname;

        switch (verb) {
          case 'navigate': {
            const target = decodeURIComponent(url.pathname.replace(/^\//, ''));
            if (!target) break;
            const sourcePaneId = url.searchParams.get('pane') ?? '';
            const targetPaneId = resolvePane(sourcePaneId);
            if (!targetPaneId) {
              deepLinkLogger.warn('no outliner pane available');
              break;
            }
            deepLinkLogger.info('navigate', { target, targetPaneId });
            // handleChirpNavigate: block ID resolution, hex guard, page fallback
            // Pane pre-resolved — resolvePane handles empty string correctly
            navigationLib.handleChirpNavigate(target, {
              type: undefined,
              sourcePaneId: targetPaneId,
            });
            break;
          }

          case 'block': {
            const blockIdOrHash = decodeURIComponent(url.pathname.replace(/^\//, ''));
            if (!blockIdOrHash) break;
            const sourcePaneId = url.searchParams.get('pane') ?? '';
            const targetPaneId = resolvePane(sourcePaneId);
            if (!targetPaneId) {
              deepLinkLogger.warn('no outliner pane available');
              break;
            }
            deepLinkLogger.info('block', { blockIdOrHash, targetPaneId });
            navigationLib.handleChirpNavigate(blockIdOrHash, {
              type: 'block',
              sourcePaneId: targetPaneId,
            });
            break;
          }

          case 'execute': {
            // floatty://execute?content=<encoded>&parent=<id>&pane=<uuid>
            const content = url.searchParams.get('content');
            const parentId = url.searchParams.get('parent');
            if (!content) {
              deepLinkLogger.error('execute: missing content param');
              break;
            }
            if (!parentId) {
              deepLinkLogger.error('execute: missing parent param');
              break;
            }
            deepLinkLogger.info('execute', { parentId, contentLength: content.length });
            const newId = blockStore.createBlockInside(parentId);
            if (!newId) {
              deepLinkLogger.error(`execute: failed to create block inside ${parentId}`);
              break;
            }
            blockStore.updateBlockContent(newId, content);
            fireHandler(newId, content);

            // Navigate unless explicitly disabled
            if (url.searchParams.get('navigate') !== 'false') {
              const sourcePaneId = url.searchParams.get('pane') ?? '';
              const targetPaneId = resolvePane(sourcePaneId);
              if (targetPaneId) {
                navigationLib.navigateToBlock(newId, { paneId: targetPaneId, highlight: true });
              }
            }
            break;
          }

          case 'upsert': {
            // floatty://upsert?parent=<id>&content=<encoded>&match=<prefix>&pane=<uuid>
            const parentId = url.searchParams.get('parent');
            const content = url.searchParams.get('content');
            const match = url.searchParams.get('match');
            if (!parentId || !content || !match) {
              deepLinkLogger.error('upsert: missing required params (parent, content, match)');
              break;
            }
            deepLinkLogger.info('upsert', { parentId, match, content: content.slice(0, 40) });
            const resultId = blockStore.upsertChildByPrefix(parentId, match, content);
            if (!resultId) {
              deepLinkLogger.error('upsert: failed to upsert child', { parentId, match });
              break;
            }

            // Fire handler if requested — use existing block content (upsert may have
            // found an existing block whose content differs from the URL's content param)
            if (url.searchParams.get('execute') === 'true') {
              const existingBlock = blockStore.blocks[resultId];
              fireHandler(resultId, existingBlock?.content ?? content);
            }

            // Navigate unless explicitly disabled
            if (url.searchParams.get('navigate') !== 'false') {
              const sourcePaneId = url.searchParams.get('pane') ?? '';
              const targetPaneId = resolvePane(sourcePaneId);
              if (targetPaneId) {
                navigationLib.navigateToBlock(resultId, { paneId: targetPaneId, highlight: true });
              }
            }
            break;
          }

          default:
            deepLinkLogger.warn(`unknown verb: ${verb}`);
        }
      } catch (e) {
        deepLinkLogger.warn(`failed to handle event ${event.payload}: ${e}`);
      }
    });
    onCleanup(() => unlistenDeepLink());
  });

  // Listen for outline switch from native macOS menu (Rust → frontend)
  onMount(async () => {
    const unlistenOutlineSwitch = await listen<string>('switch-outline', (event) => {
      const name = event.payload;
      const current = localStorage.getItem('floatty-outline') || 'default';
      if (name === current) return;
      logger.info(`Menu: switching to outline '${name}'`);
      localStorage.setItem('floatty-outline', name);
      window.location.reload();
    });
    onCleanup(() => unlistenOutlineSwitch());
  });

  // FLO-350: Listen for orphan detection events from Rust background worker
  onMount(async () => {
    unlistenOrphans = await listen<OrphanInfo[]>('orphans-detected', (event) => {
      const orphans = event.payload;
      if (!orphans || orphans.length === 0) return;

      logger.warn(`Orphan detector found ${orphans.length} orphaned blocks`);
      recordOrphansDetected(orphans.length);
      const orphanIds = orphans.map(o => o.blockId);
      blockStore.quarantineOrphans(orphanIds);
    });
  });

  // Save workspace on state changes (debounced)
  // Track persisted-state changes via explicit version signals
  let isFirstEffectRun = true;
  createEffect(() => {
    // Skip until workspace is loaded
    if (!workspaceLoaded()) return;

    // Access version signals to trigger effect on persisted-state changes.
    // This avoids deep JSON.stringify reads on large layout/pane trees.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const _ = [
      tabStore.persistenceVersion(),
      layoutStore.persistenceVersion(),
      paneStore.persistenceVersion(),
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
      logger.info('onCloseRequested triggered');
      event.preventDefault(); // Block default close

      // Check for pending Y.Doc updates - prevent data loss
      const pending = hasPendingUpdates();
      logger.info(`hasPendingUpdates: ${pending}`);
      if (pending) {
        const syncStatus = getSyncStatus();
        logger.info(`syncStatus: ${syncStatus}`);
        const message = syncStatus === 'error'
          ? 'Sync is failing. Changes are saved locally but won\'t appear on other devices until sync recovers.'
          : 'Changes haven\'t synced to the server yet. They\'re safe locally, but wait to ensure they reach other devices.';

        logger.info('About to show confirm dialog...');
        // Use Tauri native dialog (window.confirm fails silently in Tauri webview)
        const proceed = await confirm(message, {
          title: 'Unsynced Changes',
          kind: 'warning',
          okLabel: 'Close Anyway',
          cancelLabel: 'Wait',
        });
        logger.info(`User response: ${proceed}`);
        if (!proceed) {
          return; // User cancelled close
        }

        // If not in error state, try one final sync (with timeout)
        if (syncStatus !== 'error') {
          try {
            logger.info('Attempting final sync before close...');
            // 3 second timeout - don't hang forever if server is dead
            const syncPromise = forceSyncNow();
            const timeoutPromise = new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('Sync timeout')), 3000)
            );
            await Promise.race([syncPromise, timeoutPromise]);
            logger.info('Final sync completed');
          } catch (err) {
            logger.error(`Final sync failed: ${err}`);
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
        logger.info(`Killed ${count} PTY sessions on close`);
      } catch (e) {
        logger.warn(`Failed to kill PTY sessions: ${e}`);
      }

      // Save workspace (best effort - don't block close if it fails)
      try {
        await persistence.saveWorkspace();
      } catch (e) {
        logger.warn(`Failed to save workspace on close: ${e}`);
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
    unlistenOrphans?.();
  });

  return (
    <Show
      when={!serverError()}
      fallback={
        <div class="error-screen">
          <h2>Failed to connect to floatty-server</h2>
          <pre>{serverError()}</pre>
          <div style={{ display: 'flex', gap: '8px', 'margin-top': '12px' }}>
            <button
              style={{ background: '#3c3836', color: '#ebdbb2', border: '1px solid #665c54', 'border-radius': '4px', padding: '6px 16px', cursor: 'pointer', 'font-family': 'JetBrains Mono, monospace', 'font-size': '13px' }}
              onClick={async () => {
                setServerError(null);
                try {
                  await initHttpClient();
                  setServerConnected(true);
                } catch (err) {
                  setServerError(String(err));
                }
              }}
            >
              Try Again
            </button>
          </div>
          <p style={{ color: '#928374', 'font-size': '11px', 'margin-top': '8px' }}>
            Server may still be starting. Try again in a few seconds.
          </p>
        </div>
      }
    >
      <ConfigProvider>
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
      </ConfigProvider>
    </Show>
  );
}

export default App;
