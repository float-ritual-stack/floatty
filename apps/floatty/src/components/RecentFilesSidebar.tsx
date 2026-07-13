/**
 * RecentFilesSidebar — recent agent-written files (FLO-799)
 *
 * Reads the `file_events` table the JSONL watcher fills: every Write/Edit/
 * MultiEdit an agent made to a .md/.markdown/.txt file, collapsed to one row
 * per path, newest first.
 *
 * v1.1 interaction layer:
 * - plain click      → copy `sh:: cat '<path>'` to the clipboard (v1 behavior)
 * - mod+click        → insert `read:: <path>` (rendered document)
 * - mod+shift+click  → insert `sh:: cat '<path>'` (raw text)
 * - ⌘/Meta click → insert that block into the outline, after the focused block
 * - sort toggle  → date (default) ⇄ filename
 * - fuzzy filter → client-side, reuses lib/fuzzyFilter (Fuse, same as [[ autocomplete)
 *
 * Focus contract (see SidebarDoorContainer): the panel itself takes no
 * tabIndex/onKeyDown — the outliner owns focus. The rows/controls here are real
 * <button>/<input> elements, so they're natively keyboard-reachable without the
 * panel grabbing key routing.
 */

import { createSignal, createEffect, createMemo, onCleanup, Show, For } from 'solid-js';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { createLogger } from '../lib/logger';
import { invoke, type FileEvent } from '../lib/tauriTypes';
import { emitRecentFilesChanged, onRecentFilesChanged } from '../lib/fileEvents';
import { fuzzyFilter } from '../lib/fuzzyFilter';
import { isMac } from '../lib/keybinds';
import { fireBlockHandler } from '../lib/fireBlockHandler';
import { blockStore } from '../hooks/useBlockStore';
import { paneStore } from '../hooks/usePaneStore';
import { paneLinkStore } from '../hooks/usePaneLinkStore';
import { tabStore } from '../hooks/useTabStore';

const logger = createLogger('RecentFilesSidebar');

// Check if running in Tauri environment (Tauri 2 uses '__TAURI_INTERNALS__')
const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** Tauri event pushed by the Rust watcher when new file-writes land. */
const RECENT_FILES_CHANGED_EVENT = 'recent-files-changed';

/** Single-quote a string for POSIX sh, escaping embedded single quotes. */
function singleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Quote a path for the shell, preserving `~` expansion.
 *
 * A `sh:: cat <path>` block is run through `$SHELL -lc` by
 * `execute_shell_command`, so an unquoted path with spaces reads the wrong
 * args, and one containing `$(...)`, backticks, `;`, or quotes could execute
 * arbitrary shell code. Single quotes disable every shell metacharacter.
 *
 * `~` is the exception: inside quotes it does NOT expand, so the tilde stays
 * bare and only the remainder is quoted (`~/'my notes.md'`). Agent-written
 * paths from the JSONL are always absolute, so this is belt-and-braces — but it
 * keeps this function semantically identical to the reader's `shellQuotePath`
 * (`doors/read/readDoc.ts`), so two same-named helpers can't quietly disagree.
 * They stay separate because doors are dynamically-loaded plugins outside the
 * app's compile unit (`tsconfig.app.json` includes only `src`); core importing
 * door internals would invert that dependency.
 */
export function shellQuotePath(path: string): string {
  if (path === '~') return '~';
  if (path.startsWith('~/')) return `~/${singleQuote(path.slice(2))}`;
  return singleQuote(path);
}

/**
 * `sh:: cat '<path>'` — raw text, for grep/edit/pipe cases. Always quoted.
 * This is also the clipboard shape: it's what you paste into a terminal.
 */
export function catCommand(filePath: string): string {
  return `sh:: cat ${shellQuotePath(filePath)}`;
}

/**
 * `read:: <path>` — the rendered-document form (v0.21.0 reader door).
 *
 * The DEFAULT insert: the whole point of finding an agent-written doc is to
 * read it, and the reader is what renders it.
 *
 * Passed raw, deliberately. No shell is involved, so there is nothing to quote
 * — and `parseReadPath` (`doors/read/readDoc.ts`) takes the rest of the line
 * and trims it, so spaces survive unquoted. It strips a surrounding quote pair
 * if one is present and handles `~` itself. Quoting here would be redundant at
 * best, and could make the quotes part of the filename at worst.
 */
export function readCommand(filePath: string): string {
  return `read:: ${filePath}`;
}

/** How long success feedback sticks around. */
const FLASH_OK_MS = 1500;
/** Errors linger longer — the user needs time to read why nothing happened. */
const FLASH_ERROR_MS = 2600;

/** Filter input debounce. Long enough to skip mid-word churn, short enough to feel live. */
const FILTER_DEBOUNCE_MS = 120;

/**
 * Everything on a row is filterable — not just the name.
 *
 * Evan asked to "filter based on metadata, not just name", so the query runs
 * over the path, the tool that wrote it, which session/branch/cwd it came from,
 * and the provenance snippet. `filePath` subsumes the filename (a basename is
 * a substring of its path), so it doesn't need its own key.
 */
export const FILTER_KEYS = ['filePath', 'toolName', 'sessionId', 'cwd', 'gitBranch', 'snippet'];

export type SortMode = 'date' | 'name';

type RowFlashKind = 'copied' | 'inserted' | 'error';

interface RowFlash {
  id: string;
  kind: RowFlashKind;
  message: string;
}

// ═══════════════════════════════════════════════════════════════
// PURE HELPERS (exported for tests)
// ═══════════════════════════════════════════════════════════════

/** Where a ⌘-click insert would land. */
export interface InsertTarget {
  paneId: string;
  focusedBlockId: string;
}

/**
 * Resolve the outline destination for an insert, or null if there isn't one.
 *
 * Three ways this legitimately comes back null: no active tab, no outliner pane
 * in that tab, or an outliner with nothing focused. All three mean "the user
 * hasn't told us where to put it" — the caller surfaces that on the row rather
 * than guessing a destination.
 *
 * Deps are injected so this is testable without a live workspace.
 */
export function resolveInsertTarget(deps: {
  activeTabId: () => string | null;
  resolveSidebarTarget: (tabId: string) => string | null;
  getFocusedBlockId: (paneId: string) => string | null;
}): InsertTarget | null {
  const tabId = deps.activeTabId();
  if (!tabId) return null;

  const paneId = deps.resolveSidebarTarget(tabId);
  if (!paneId) return null;

  const focusedBlockId = deps.getFocusedBlockId(paneId);
  if (!focusedBlockId) return null;

  return { paneId, focusedBlockId };
}

/** Minimal shape of the block-store surface the insert needs. */
export interface InsertStore {
  getBlock: (id: string) => { content: string } | undefined;
  createBlockAfter: (afterId: string) => string;
  updateBlockContent: (id: string, content: string) => void;
}

/**
 * Put an already-built command (`read::` or `sh:: cat`) into the outline at the
 * focused block. The caller decides the shape; this only decides *where*.
 *
 * If the focused block is EMPTY, fill it in place — the common case is "user
 * hits Enter for a fresh block, then mod-clicks a file", and creating a sibling
 * there would strand an empty block above the result.
 *
 * If it has content, insert a new sibling BELOW instead. Never clobber text the
 * user already typed.
 *
 * Returns the id of the block now holding the command, or null when the write
 * did not land — the caller must surface that rather than claim success.
 *
 * ## Why the in-place write is verified
 *
 * `getBlock` reads the SolidJS reactive projection, not Y.Doc, and per
 * ydoc-patterns.md #14 that projection can be STALE — a block deleted remotely
 * may still be present in `state.blocks`. `updateBlockContent` → `setValueOnYMap`
 * then *silently no-ops* when the id is absent from the Y.Map (no throw). So a
 * naive "write, return the id" would focus a dead block and report "inserted"
 * while nothing was written (Greptile P1 on PR #339).
 *
 * Reading back through the same projection is safe here: yjs observers fire
 * synchronously at the end of `transact()`, so a write that landed is visible
 * immediately. If the read-back doesn't show our command, the block is gone from
 * Y.Doc — fall through to `createBlockAfter`, which validates against Y.Doc
 * inside its own transaction and returns '' on failure.
 */
export function insertBlockAt(
  target: InsertTarget,
  command: string,
  store: InsertStore
): string | null {
  const focused = store.getBlock(target.focusedBlockId);

  if (focused && focused.content.trim() === '') {
    store.updateBlockContent(target.focusedBlockId, command);

    if (store.getBlock(target.focusedBlockId)?.content === command) {
      return target.focusedBlockId;
    }
    // Write didn't land — the block isn't in Y.Doc. Fall through and make a
    // real one rather than report a phantom success.
  }

  const newId = store.createBlockAfter(target.focusedBlockId);
  if (!newId) return null;

  store.updateBlockContent(newId, command);
  return newId;
}

/**
 * Sort is authoritative over fuzzy match-rank.
 *
 * `fuzzyFilter` returns hits ordered by Fuse score, which would silently
 * override the user's chosen sort while a query is active. Sorting *after*
 * filtering keeps the toggle meaning what it says. Both orders tie-break on
 * `id` so the list never reshuffles between renders (same reasoning as the
 * `id DESC` tie-breaker in the SQL).
 */
export function sortFiles(files: FileEvent[], mode: SortMode): FileEvent[] {
  const sorted = [...files];

  if (mode === 'name') {
    sorted.sort((a, b) => {
      const cmp = basename(a.filePath).localeCompare(basename(b.filePath), undefined, {
        sensitivity: 'base',
      });
      return cmp !== 0 ? cmp : a.id.localeCompare(b.id);
    });
    return sorted;
  }

  sorted.sort((a, b) => {
    const at = parseTimestamp(a);
    const bt = parseTimestamp(b);
    if (at !== bt) return bt - at; // newest first
    return b.id.localeCompare(a.id);
  });
  return sorted;
}

function parseTimestamp(file: FileEvent): number {
  const raw = timestampOf(file);
  if (!raw) return 0;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? 0 : parsed;
}

// ═══════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════

export function RecentFilesSidebar(props: { visible: boolean }) {
  const [files, setFiles] = createSignal<FileEvent[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  const [flash, setFlash] = createSignal<RowFlash | null>(null);
  const [sortMode, setSortMode] = createSignal<SortMode>('date');
  // Two signals: `filterInput` drives the controlled <input> (must update on
  // every keystroke), `filterQuery` drives the actual filtering (debounced, so
  // Fuse doesn't re-search on every character).
  const [filterInput, setFilterInput] = createSignal('');
  const [filterQuery, setFilterQuery] = createSignal('');

  let fetchInFlight = false;
  let fetchQueued = false;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let flashTimer: ReturnType<typeof setTimeout> | null = null;
  let filterTimer: ReturnType<typeof setTimeout> | null = null;

  const onFilterInput = (value: string) => {
    setFilterInput(value);
    if (filterTimer) clearTimeout(filterTimer);
    filterTimer = setTimeout(() => {
      filterTimer = null;
      setFilterQuery(value.trim());
    }, FILTER_DEBOUNCE_MS);
  };

  // Filter first, then sort. `fuzzyFilter` caches its Fuse index by array
  // IDENTITY, so it must receive the raw signal array — never a copy.
  const filtered = createMemo(() =>
    fuzzyFilter(files(), filterQuery(), { keys: FILTER_KEYS })
  );
  const visibleFiles = createMemo(() => sortFiles(filtered(), sortMode()));

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

  const flashRow = (id: string, kind: RowFlashKind, message: string) => {
    setFlash({ id, kind, message });
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(
      () => {
        flashTimer = null;
        setFlash(null);
      },
      kind === 'error' ? FLASH_ERROR_MS : FLASH_OK_MS
    );
  };

  const copyCatCommand = async (file: FileEvent) => {
    try {
      await navigator.clipboard.writeText(catCommand(file.filePath));
      flashRow(file.id, 'copied', 'copied sh:: cat');
    } catch (e) {
      logger.error(`Failed to copy command to clipboard: ${e}`);
      flashRow(file.id, 'error', "couldn't copy to clipboard");
    }
  };

  const insertIntoOutline = (file: FileEvent, build: (p: string) => string) => {
    const target = resolveInsertTarget({
      activeTabId: () => tabStore.activeTabId(),
      resolveSidebarTarget: (tabId) => paneLinkStore.resolveSidebarTarget(tabId),
      getFocusedBlockId: (paneId) => paneStore.getFocusedBlockId(paneId),
    });

    if (!target) {
      // Not a silent no-op and not a modal — say what's missing, on the row.
      flashRow(file.id, 'error', 'select a destination block first');
      return;
    }

    const command = build(file.filePath);
    const newId = insertBlockAt(target, command, blockStore);
    if (!newId) {
      logger.warn(`Insert refused for ${file.filePath} — anchor block likely gone`);
      flashRow(file.id, 'error', "couldn't insert — try again");
      return;
    }

    // Advance focus to the block we just made. Without this, ⌘-clicking three
    // files in a row inserts all three after the SAME anchor, landing them in
    // reverse click order. Advancing makes them stack in the order clicked.
    paneStore.setFocusedBlockId(target.paneId, newId);

    // Run it. Inserting a `read::`/`sh:: cat` and then making the user hit
    // Enter is a gesture with a mandatory second half — the click already said
    // "show me this file". Same executor the keyboard path uses.
    fireBlockHandler(newId, command);
    flashRow(
      file.id,
      'inserted',
      build === readCommand ? 'inserted read::' : 'inserted sh:: cat'
    );
  };

  const activateRow = (file: FileEvent, event: MouseEvent) => {
    // "mod" click → insert; plain click keeps v1 clipboard behavior.
    //
    // Same platform idiom as every other mod+click in the app (BlockItem,
    // LinkedReferences, BlockOutputView all do `isMac ? metaKey : ctrlKey`),
    // so this is ⌘-click on macOS and Ctrl-click elsewhere. No conflict: the
    // existing mod+click handlers are all bound to wikilink targets inside
    // outliner surfaces, and keybinds.ts / the Outliner tinykeys map are
    // keyboard-only — nothing listens for mod+click on a sidebar row.
    const modKey = isMac ? event.metaKey : event.ctrlKey;

    // Three destinations, one per gesture:
    //   plain      → clipboard (sh:: cat — what you paste into a terminal)
    //   mod        → read::    (renders the doc — the reason the reader exists)
    //   mod+shift  → sh:: cat  (raw text in the outline, for grep/edit/pipe)
    if (modKey && event.shiftKey) {
      insertIntoOutline(file, catCommand);
    } else if (modKey) {
      insertIntoOutline(file, readCommand);
    } else {
      void copyCatCommand(file);
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
      // Cancelling a timer must also settle the state it was going to settle.
      // This cleanup runs on HIDE (⌘\) as well as unmount, and the component
      // survives a hide — so a bare clearTimeout would strand whatever the
      // timer was mid-way through.
      if (flashTimer) {
        clearTimeout(flashTimer);
        flashTimer = null;
        // Otherwise the row stays lit "inserted" forever: the timer that would
        // have cleared it is gone, and the signal outlives the hide.
        setFlash(null);
      }
      if (filterTimer) {
        clearTimeout(filterTimer);
        filterTimer = null;
        // Flush rather than drop: the input still shows what was typed, so the
        // applied query has to catch up or the list contradicts the box.
        setFilterQuery(filterInput().trim());
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
                <button type="button" class="files-retry-button" onClick={() => queueFetch(0)}>
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
              <div class="files-sidebar-header">
                <div class="files-header-top">
                  <span>Recent Files ({visibleFiles().length})</span>
                  <div class="files-sort" role="group" aria-label="Sort recent files">
                    <button
                      type="button"
                      class="files-sort-button"
                      aria-pressed={sortMode() === 'date'}
                      onClick={() => setSortMode('date')}
                    >
                      date
                    </button>
                    <button
                      type="button"
                      class="files-sort-button"
                      aria-pressed={sortMode() === 'name'}
                      onClick={() => setSortMode('name')}
                    >
                      name
                    </button>
                  </div>
                </div>

                <input
                  class="files-filter-input"
                  type="text"
                  placeholder="filter name, path, tool, session…"
                  aria-label="Filter recent files by name, path, tool, session, or snippet"
                  value={filterInput()}
                  onInput={(e) => onFilterInput(e.currentTarget.value)}
                />

                <div class="files-hint-inline">
                  click copies · {isMac ? '⌘' : 'ctrl'}-click reads · +⇧ cats
                </div>
              </div>

              {/* Header stays mounted when the filter matches nothing — otherwise
                * there'd be no way to clear the query that emptied the list. */}
              <Show
                when={visibleFiles().length > 0}
                fallback={
                  <div class="files-empty-state files-no-matches">
                    No files match “{filterQuery()}”
                  </div>
                }
              >
                <div class="files-list">
                  <For each={visibleFiles()}>
                    {(file) => {
                      const rowFlash = () => {
                        const f = flash();
                        return f && f.id === file.id ? f : null;
                      };
                      return <FileRow file={file} flash={rowFlash()} onActivate={activateRow} />;
                    }}
                  </For>
                </div>
              </Show>
            </aside>
          </Show>
        </Show>
      </Show>
    </Show>
  );
}

function FileRow(props: {
  file: FileEvent;
  flash: RowFlash | null;
  onActivate: (file: FileEvent, event: MouseEvent) => void;
}) {
  const name = () => basename(props.file.filePath);
  const when = () => formatRelativeTime(timestampOf(props.file));

  // Provenance as hover text — cheap, no extra state, no layout cost.
  // Spells out all three gestures with the EXACT string each one produces, so
  // the tooltip can never diverge from what actually lands.
  const modLabel = isMac ? '⌘' : 'Ctrl';
  const modWord = isMac ? 'Command' : 'Control';

  const title = () => {
    const lines = [
      `Click — copy to clipboard: ${catCommand(props.file.filePath)}`,
      `${modLabel}-click — insert: ${readCommand(props.file.filePath)}`,
      `${modLabel}⇧-click — insert: ${catCommand(props.file.filePath)}`,
    ];
    if (props.file.snippet) lines.push('', props.file.snippet);
    return lines.join('\n');
  };

  return (
    <button
      type="button"
      class={`files-row ${props.flash ? `files-row-${props.flash.kind}` : ''}`}
      title={title()}
      aria-label={
        `${name()} — click to copy the shell command, ` +
        `${modWord}-click to insert it as a rendered read:: block, ` +
        `${modWord}-Shift-click to insert it as a raw sh:: cat block`
      }
      onClick={(e) => props.onActivate(props.file, e)}
    >
      <div class="files-row-top">
        <span class="files-row-name">{name()}</span>
        <span class="files-row-time">{when()}</span>
      </div>
      <div class="files-row-path">{props.file.filePath}</div>
      <Show when={props.file.snippet}>
        <div class="files-row-snippet">{props.file.snippet}</div>
      </Show>
      <span
        class={`files-row-flash ${props.flash?.kind === 'error' ? 'files-row-flash-error' : ''}`}
        aria-live="polite"
      >
        {props.flash?.message ?? ''}
      </span>
    </button>
  );
}

/**
 * Last path segment — the part you actually recognize. Drives the row label and
 * the name-sort key.
 *
 * Splits on BOTH separators. floatty is cross-platform (CLAUDE.md: "Cmd on
 * macOS, Ctrl on Windows/Linux"), and an agent running on Windows writes
 * `C:\work\notes.md` — splitting on `/` alone would leave the whole path as the
 * "filename", so every row would show its full path and name-sort would key on
 * the drive letter.
 *
 * Tradeoff, deliberately taken: a POSIX filename may legally contain a literal
 * backslash (`a\b.md`), and this would render it as `b.md`. That's a display/sort
 * nit on a pathological name; showing a full Windows path on every row is a
 * visible bug on a supported platform.
 */
export function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
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
