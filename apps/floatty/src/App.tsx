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
import { initHttpClient, probeServerHealth, isClientInitialized } from './lib/httpClient';
import { hasPendingUpdates, forceSyncNow, getSyncStatus, resumeSyncAfterReconnect, getInitialLoadState } from './hooks/useSyncedYDoc';
import * as navigationLib from './lib/navigation';
import { paneLinkStore } from './hooks/usePaneLinkStore';
import { useSyncHealth } from './hooks/useSyncHealth';
import { registerHandlers } from './lib/handlers';
import { fireBlockHandler } from './lib/fireBlockHandler';
import { blockStore } from './hooks/useBlockStore';
import { recordOrphansDetected } from './lib/syncDiagnostics';
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
  const [serverError, setServerError] = createSignal<string | null>(null);
  // The connect attempt has SETTLED (success or failure). Workspace layout
  // load keys on this, not on success: the layout lives in local SQLite via
  // Tauri IPC — terminals and panes must come up even when float-box is down.
  const [connectSettled, setConnectSettled] = createSignal(false);
  const [retrying, setRetrying] = createSignal(false);
  const [workspaceLoaded, setWorkspaceLoaded] = createSignal(false);
  const [workspaceError, setWorkspaceError] = createSignal<string | null>(null);
  const persistence = getWorkspacePersistence();
  let workspaceLoadStarted = false;
  let workspaceLoadInFlight = false;
  let reconnectPollTimer: number | null = null;
  const RECONNECT_POLL_MS = 15_000;

  // Shared connect helper — called on first mount AND on retry paths.
  const connectServer = async () => {
    // ADR-006: defensive removal of the retired multi-outline localStorage key.
    // No code reads it after the retirement; this keeps stale boot-state from
    // accumulating. Idempotent — safe to delete this line once the user fleet has
    // cycled past the retirement.
    localStorage.removeItem('floatty-outline');
    await initHttpClient();
    logger.info('HTTP client connected to floatty-server');
  };

  const stopReconnectPoll = () => {
    if (reconnectPollTimer !== null) {
      clearInterval(reconnectPollTimer);
      reconnectPollTimer = null;
    }
  };

  // One attempt to bring the connection (and then sync) back up. Shared by
  // the banner's Retry button and the background poll. The banner clears and
  // the poll stops ONLY after sync is actually restored — a connect that
  // succeeds but a resync that fails must keep recovery running.
  const attemptReconnect = async (): Promise<boolean> => {
    if (retrying()) return false;
    setRetrying(true);
    try {
      await connectServer();
      const recovered = await resumeSyncAfterReconnect();
      if (recovered) {
        setServerError(null);
        stopReconnectPoll();
      }
      return recovered;
    } catch (err) {
      setServerError(String(err));
      return false;
    } finally {
      setRetrying(false);
    }
  };

  // Background reconnect: one cheap live health probe per tick (NOT
  // get_server_status — that's a boot-time snapshot and can never flip back
  // to reachable). Only attempt the full connect once the probe passes, so
  // a down server costs one 2s-timeout fetch per 15s, not a retry ladder.
  const startReconnectPoll = () => {
    if (reconnectPollTimer !== null) return;
    reconnectPollTimer = window.setInterval(() => {
      void (async () => {
        if (retrying()) return;
        if (!(await probeServerHealth())) return;
        await attemptReconnect();
      })();
    }, RECONNECT_POLL_MS);
  };

  onCleanup(stopReconnectPoll);

  // The Outliner's Retry button can complete the load out-of-band (it runs
  // initHttpClient itself). When that happens the connection is back — clear
  // the banner and stop the poll instead of waiting for the next 15s tick.
  // Guarded on isClientInitialized(): an offline-cache boot ALSO flips
  // loaded=true, but its client is still down and the banner must stay.
  createEffect(
    on(getInitialLoadState, (loaded) => {
      if (loaded && serverError() && isClientInitialized()) {
        setServerError(null);
        stopReconnectPoll();
      }
    })
  );

  // Phase 3: Initialize HTTP client before loading workspace
  // The HTTP client connects to floatty-server (spawned by Tauri)
  onMount(async () => {
    try {
      await connectServer();
    } catch (err) {
      logger.error(`Failed to connect to floatty-server: ${err}`);
      setServerError(String(err));
      startReconnectPoll();
    } finally {
      setConnectSettled(true);
    }
  });

  // Register block handlers (sh::, daily::, doors)
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

  // Load workspace once the connect attempt settles — success OR failure.
  // get_workspace_state is local Tauri IPC (SQLite); gating it on server
  // SUCCESS was one of the three gates that bricked the whole app (terminals
  // included) when float-box was unreachable.
  createEffect(
    on(
      connectSettled,
      (settled) => {
        if (!settled) return;
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
      if (!activeTab || activeTab.ptyPid == null || activeTab.ptyPid < 0) {
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
    /**
     * Fire the handler for content if a matching prefix is registered.
     * Shared with the FILES sidebar's insert-and-run — see fireBlockHandler.ts.
     */
    const fireHandler = (blockId: string, content: string) => {
      fireBlockHandler(blockId, content);
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

  // NOTE the absence of a serverError() gate around the tree: a connection
  // failure is a status banner, not a death screen. Terminals are local PTYs
  // with zero float-box dependency, and the outline can hydrate from the
  // IndexedDB cache — gating everything on server reachability was the app's
  // single worst failure mode (boot-sequence audit §3.2, a 53-minute outage
  // meant 53 minutes of no floatty at all).
  return (
    <ConfigProvider>
      <Show when={serverError()}>
        <div class="server-status-banner" role="alert">
          <span class="server-status-banner-text">⚠ {serverError()}</span>
          <button
            type="button"
            class="server-status-banner-retry"
            disabled={retrying()}
            onClick={() => void attemptReconnect()}
          >
            {retrying() ? 'Retrying…' : 'Retry now'}
          </button>
        </div>
      </Show>
      <Show when={workspaceLoaded()} fallback={<div class="loading">Loading…</div>}>
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
  );
}

export default App;
