/**
 * fileEvents — refresh bus for the "recent files" sidebar (FLO-799)
 *
 * Mirrors ctxEvents.ts. The Rust watcher pushes a `recent-files-changed` Tauri
 * event when new agent file-writes land; RecentFilesSidebar bridges that into
 * this bus so any frontend code can also request a refresh without reaching
 * for Tauri.
 */

const RECENT_FILES_CHANGED_EVENT = 'files:recent-changed';

export type RecentFilesChangedReason =
  | 'watcher'
  | 'focus'
  | 'visibility'
  | 'manual'
  | 'external';

const fileEventsTarget = new EventTarget();

/** Emit when file-event data may have changed and the sidebar should refresh. */
export function emitRecentFilesChanged(
  reason: RecentFilesChangedReason = 'external'
): void {
  fileEventsTarget.dispatchEvent(
    new CustomEvent<RecentFilesChangedReason>(RECENT_FILES_CHANGED_EVENT, { detail: reason })
  );
}

/** Subscribe to recent-files refresh events. Returns cleanup function. */
export function onRecentFilesChanged(
  handler: (reason: RecentFilesChangedReason) => void
): () => void {
  const listener = (event: Event) => {
    const customEvent = event as CustomEvent<RecentFilesChangedReason>;
    handler(customEvent.detail ?? 'external');
  };

  fileEventsTarget.addEventListener(RECENT_FILES_CHANGED_EVENT, listener);
  return () => fileEventsTarget.removeEventListener(RECENT_FILES_CHANGED_EVENT, listener);
}
