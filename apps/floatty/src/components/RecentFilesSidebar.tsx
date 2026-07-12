/**
 * RecentFilesSidebar — recent agent-written files (FLO-799)
 *
 * Reads the `file_events` table the JSONL watcher fills: every Write/Edit/
 * MultiEdit an agent made to a .md/.markdown/.txt file, collapsed to one row
 * per path, newest first.
 *
 * Clicking a row copies `sh:: cat <path>` — paste it into the outline and the
 * file renders. That's the whole loop: agent writes a doc somewhere, you find
 * it here, you read it in floatty.
 *
 * Focus contract (see SidebarDoorContainer): the sidebar is display-only. Rows
 * are real <button>s, so they're keyboard-reachable, but the panel takes no
 * tabIndex/onKeyDown of its own.
 */

import { createSignal, createEffect, onCleanup, Show, For } from 'solid-js';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { createLogger } from '../lib/logger';
import { invoke, type FileEvent } from '../lib/tauriTypes';
import { emitRecentFilesChanged, onRecentFilesChanged } from '../lib/fileEvents';

const logger = createLogger('RecentFilesSidebar');

// Check if running in Tauri environment (Tauri 2 uses '__TAURI_INTERNALS__')
const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** Tauri event pushed by the Rust watcher when new file-writes land. */
const RECENT_FILES_CHANGED_EVENT = 'recent-files-changed';

/** How long the "copied" affordance sticks around. */
const COPIED_FEEDBACK_MS = 1500;

export function RecentFilesSidebar(props: { visible: boolean }) {
  const [files, setFiles] = createSignal<FileEvent[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  const [copiedId, setCopiedId] = createSignal<string | null>(null);

  let fetchInFlight = false;
  let fetchQueued = false;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let copiedTimer: ReturnType<typeof setTimeout> | null = null;

  const queueFetch = (delayMs = 0) => {
    if (refreshTimer) {
      clearTimeout(refreshTimer);
    }
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      fetchFiles();
    }, delayMs);
  };

  const fetchFiles = async () => {
    if (fetchInFlight) {
      fetchQueued = true;
      return;
    }
    fetchInFlight = true;

    try {
      if (!isTauri) {
        // Mock data for browser mode (mirrors ContextSidebar).
        setFiles([
          {
            id: 'mock-1',
            filePath: '/path/to/project/docs/design.md',
            toolName: 'Write',
            sessionFile: '/path/to/session.jsonl',
            snippet: 'Writing the widget pipeline design doc now.',
            eventTime: new Date().toISOString(),
            createdAt: new Date().toISOString(),
          },
        ]);
        setLoading(false);
        return;
      }

      const recent = await invoke('get_recent_files', { limit: 50 });
      setFiles(recent);
      setError(null);
      setLoading(false);
    } catch (e) {
      logger.error(`Failed to fetch recent files: ${e}`);
      setError(String(e));
      setLoading(false);
    } finally {
      fetchInFlight = false;
      if (fetchQueued) {
        fetchQueued = false;
        queueFetch(0);
      }
    }
  };

  const copyCatCommand = async (file: FileEvent) => {
    const command = `sh:: cat ${file.filePath}`;
    try {
      await navigator.clipboard.writeText(command);

      setCopiedId(file.id);
      if (copiedTimer) clearTimeout(copiedTimer);
      copiedTimer = setTimeout(() => {
        copiedTimer = null;
        setCopiedId(null);
      }, COPIED_FEEDBACK_MS);
    } catch (e) {
      logger.error(`Failed to copy command to clipboard: ${e}`);
    }
  };

  // Refresh lifecycle (visible only): initial load + watcher push + focus/visibility.
  createEffect(() => {
    if (!props.visible) return;

    queueFetch(0);

    const unsubscribeFiles = onRecentFilesChanged(() => queueFetch(150));
    const onFocus = () => queueFetch(0);
    const onVisibilityChange = () => {
      if (!document.hidden) {
        queueFetch(0);
      }
    };

    // Bridge the Rust watcher's push into the frontend bus. listen() is async,
    // so the unlisten handle may land after cleanup — guard with `disposed`.
    let disposed = false;
    let unlistenTauri: UnlistenFn | null = null;

    if (isTauri) {
      listen(RECENT_FILES_CHANGED_EVENT, () => emitRecentFilesChanged('watcher'))
        .then((unlisten) => {
          if (disposed) {
            unlisten();
            return;
          }
          unlistenTauri = unlisten;
        })
        .catch((e) => logger.error(`Failed to listen for file events: ${e}`));
    }

    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibilityChange);

    onCleanup(() => {
      disposed = true;
      unlistenTauri?.();
      unsubscribeFiles();
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (refreshTimer) {
        clearTimeout(refreshTimer);
        refreshTimer = null;
      }
      if (copiedTimer) {
        clearTimeout(copiedTimer);
        copiedTimer = null;
      }
      fetchQueued = false;
    });
  });

  return (
    <Show when={props.visible}>
      <Show
        when={!loading()}
        fallback={
          <aside class="files-sidebar" role="complementary" aria-label="Recent files">
            <div class="files-sidebar-header">Recent Files</div>
            <div class="files-empty-state">Loading...</div>
          </aside>
        }
      >
        <Show
          when={!error()}
          fallback={
            <aside
              class="files-sidebar files-sidebar-error"
              role="complementary"
              aria-label="Recent files"
            >
              <div class="files-sidebar-header">Recent Files</div>
              <div class="files-error-state">
                <div class="files-error-message" role="alert">{error()}</div>
                <button class="files-retry-button" onClick={() => queueFetch(0)}>
                  Retry
                </button>
              </div>
            </aside>
          }
        >
          <Show
            when={files().length > 0}
            fallback={
              <aside
                class="files-sidebar files-sidebar-empty"
                role="complementary"
                aria-label="Recent files"
              >
                <div class="files-sidebar-header">Recent Files</div>
                <div class="files-empty-state">
                  No agent file writes yet
                  <div class="files-hint">
                    Watching ~/.claude/projects/*.jsonl for .md / .txt writes
                  </div>
                </div>
              </aside>
            }
          >
            <aside class="files-sidebar" role="complementary" aria-label="Recent files">
              <div class="files-sidebar-header">Recent Files ({files().length})</div>
              <div class="files-list">
                <For each={files()}>
                  {(file) => (
                    <FileRow
                      file={file}
                      copied={copiedId() === file.id}
                      onCopy={copyCatCommand}
                    />
                  )}
                </For>
              </div>
            </aside>
          </Show>
        </Show>
      </Show>
    </Show>
  );
}

function FileRow(props: {
  file: FileEvent;
  copied: boolean;
  onCopy: (file: FileEvent) => void;
}) {
  const name = () => basename(props.file.filePath);
  const when = () => formatRelativeTime(timestampOf(props.file));

  // Provenance as hover text — cheap, no extra state, no layout cost.
  const title = () => {
    const lines = [`Copy: sh:: cat ${props.file.filePath}`];
    if (props.file.snippet) lines.push('', props.file.snippet);
    return lines.join('\n');
  };

  return (
    <button
      class={`files-row ${props.copied ? 'files-row-copied' : ''}`}
      title={title()}
      aria-label={`Copy shell command to read ${name()}`}
      onClick={() => props.onCopy(props.file)}
    >
      <div class="files-row-top">
        <span class="files-row-name">{name()}</span>
        <span class="files-row-time">{when()}</span>
      </div>
      <div class="files-row-path">{props.file.filePath}</div>
      <Show when={props.file.snippet}>
        <div class="files-row-snippet">{props.file.snippet}</div>
      </Show>
      <span class="files-row-copied-badge" aria-live="polite">
        {props.copied ? 'copied sh:: cat' : ''}
      </span>
    </button>
  );
}

/** Last path segment — the part you actually recognize. */
function basename(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] || path;
}

/**
 * Prefer the JSONL timestamp; fall back to the row's insert time.
 *
 * SQLite's CURRENT_TIMESTAMP is UTC but renders without a zone marker
 * ("2026-07-12 20:15:30"), which Date.parse would otherwise read as local time.
 */
function timestampOf(file: FileEvent): string | undefined {
  if (file.eventTime) return file.eventTime;
  if (!file.createdAt) return undefined;

  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(file.createdAt)
    ? `${file.createdAt.replace(' ', 'T')}Z`
    : file.createdAt;
}

/** "3m ago" / "2h ago" / "5d ago", falling back to a date past a week. */
export function formatRelativeTime(iso: string | undefined, now = Date.now()): string {
  if (!iso) return '';

  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';

  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return 'just now';

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;

  return new Date(then).toLocaleDateString();
}
