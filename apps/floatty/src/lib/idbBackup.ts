/**
 * idbBackup - IndexedDB storage for Y.Doc backup
 *
 * Replaces localStorage backup to support larger Y.Doc sizes.
 * - localStorage limit: 5MB (hit at 5.4MB, lost data 2026-01-23)
 * - IndexedDB limit: typically 50MB+ or % of disk
 * - Binary storage: no base64 overhead
 */

import { createLogger } from './logger';

const logger = createLogger('idbBackup');

const STORE_NAME = 'ydoc';
const DB_VERSION = 1;

// Mutable - set by initBackupNamespace before first access
let dbName = 'floatty-backup';
let dbPromise: Promise<IDBDatabase> | null = null;

/**
 * Derive a server-identity slug from the server URL (FLO-762).
 *
 * The backup AND lastContiguousSeq live in this database. Both are only
 * meaningful against the server they were recorded from: the seq baseline
 * indexes into one server's update log, and the startup reconciliation
 * diff-pushes the backup INTO the connected server. Keying the namespace by
 * server identity means flipping `remote_server_url` gets a fresh namespace —
 * no stale seq replay, no stale backup merging into the wrong outline.
 */
export function deriveServerSlug(serverUrl: string | undefined | null): string {
  if (!serverUrl) return 'local';
  try {
    const u = new URL(serverUrl);
    const port = u.port || (u.protocol === 'https:' ? '443' : '80');
    return encodeURIComponent(`${u.hostname}:${port}`);
  } catch {
    // Unparseable URL — still better to key on the raw string than to
    // collapse distinct servers into one namespace.
    return encodeURIComponent(serverUrl);
  }
}

/**
 * Initialize the backup namespace based on build environment, workspace,
 * and server identity (FLO-762).
 * MUST be called BEFORE any backup operations (getBackup, saveBackup, etc.)
 *
 * Creates isolation between dev/release builds, workspaces, and servers.
 * e.g., 'floatty-backup-dev|default|127.0.0.1%3A33333' vs
 *       'floatty-backup-release|default|float-box%3A8765'
 */
export function initBackupNamespace(workspaceName: string, serverSlug: string = 'local'): void {
  const build = import.meta.env.DEV ? 'dev' : 'release';
  // Use | as delimiter (not -) so workspace names containing hyphens don't
  // produce colliding DB names. encodeURIComponent encodes any | in the name
  // itself to %7C, keeping the delimiter unambiguous.
  const ws = encodeURIComponent(workspaceName);
  const newDbName = `floatty-backup-${build}|${ws}|${serverSlug}`;

  if (newDbName !== dbName) {
    // CRITICAL: Null the promise SYNCHRONOUSLY before async close to prevent
    // race where getDB() reuses the old promise while close is pending
    const oldPromise = dbPromise;
    dbPromise = null;
    dbName = newDbName;

    // Fire-and-forget close of old connection (best effort cleanup)
    if (oldPromise) {
      oldPromise.then(db => db.close()).catch(() => {});
    }
    logger.info(`Namespace set to: ${dbName}`);

    // ADR-006 migration: clean up the legacy `floatty-backup-{build}|{ws}|default`
    // database left behind by the retired multi-outline storage topology. The third
    // segment was the outline name (always "default" in practice). Without this,
    // stale IDBs accumulate in user storage with no path back. Idempotent: a
    // deleteDatabase() request on a non-existent name is a no-op. Best-effort —
    // failures don't block startup. Safe to delete this block once user fleet has
    // cycled past the retirement. Guarded for non-IndexedDB environments (jsdom in
    // tests, SSR contexts).
    if (typeof indexedDB !== 'undefined') {
      const legacyName = `floatty-backup-${build}|${ws}|default`;
      const req = indexedDB.deleteDatabase(legacyName);
      req.onsuccess = () => logger.info(`[ADR-006 migration] cleared legacy IDB: ${legacyName}`);
      req.onerror = () => logger.warn(`[ADR-006 migration] failed to clear legacy IDB ${legacyName}: ${req.error?.message ?? 'unknown'}`);
      req.onblocked = () => logger.warn(`[ADR-006 migration] legacy IDB ${legacyName} delete blocked (open elsewhere); will retry on next launch`);

      // FLO-762 migration: clean up the pre-server-slug 2-segment database
      // (`floatty-backup-{build}|{ws}`). Its backup + seq baseline were
      // recorded against an unidentified server, so they're not safe to carry
      // forward; the cost is one full resync on first launch after upgrade.
      // Same idempotent best-effort semantics as the ADR-006 block above.
      const preSlugName = `floatty-backup-${build}|${ws}`;
      const preSlugReq = indexedDB.deleteDatabase(preSlugName);
      preSlugReq.onsuccess = () => logger.info(`[FLO-762 migration] cleared pre-slug IDB: ${preSlugName}`);
      preSlugReq.onerror = () => logger.warn(`[FLO-762 migration] failed to clear pre-slug IDB ${preSlugName}: ${preSlugReq.error?.message ?? 'unknown'}`);
      preSlugReq.onblocked = () => logger.warn(`[FLO-762 migration] pre-slug IDB ${preSlugName} delete blocked (open elsewhere); will retry on next launch`);
    }
  }
}

function getDB(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName, DB_VERSION);
      request.onerror = () => {
        logger.error('Failed to open database', { err: request.error });
        reject(request.error);
      };
      request.onsuccess = () => resolve(request.result);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
    });
  }
  return dbPromise;
}

/**
 * Save Y.Doc state to IndexedDB backup.
 */
export async function saveBackup(state: Uint8Array): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(state, 'current');
    tx.oncomplete = () => {
      logger.info(`Saved backup: ${state.length} bytes to ${dbName}`);
      resolve();
    };
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Get Y.Doc state from IndexedDB backup.
 */
export async function getBackup(): Promise<Uint8Array | null> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).get('current');
    request.onsuccess = () => {
      const result = request.result ?? null;
      if (result) {
        logger.info(`Loaded backup: ${result.length} bytes from ${dbName}`);
      }
      resolve(result);
    };
    request.onerror = () => reject(request.error);
  });
}

/**
 * Clear the IndexedDB backup (called when sync completes).
 */
export async function clearBackup(): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete('current');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Check if an IndexedDB backup exists.
 */
export async function hasBackup(): Promise<boolean> {
  const backup = await getBackup();
  return backup !== null;
}

/**
 * Save last contiguous sequence number to IndexedDB.
 * Used for incremental sync on reconnect after browser refresh/crash.
 *
 * IMPORTANT: We persist lastContiguousSeq, NOT lastSeenSeq!
 * - lastSeenSeq may jump if we receive out-of-order messages (e.g., see seq 419 but missed 418)
 * - lastContiguousSeq only advances when ALL prior seqs have been received
 * - On reload, we fetch "since lastContiguousSeq" to get any gaps + new updates
 */
export async function saveLastContiguousSeq(seq: number): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(seq, 'lastContiguousSeq');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Get last contiguous sequence number from IndexedDB.
 * Returns null if not previously saved.
 */
export async function getLastContiguousSeq(): Promise<number | null> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).get('lastContiguousSeq');
    request.onsuccess = () => {
      const result = request.result;
      // Migration: also check for old 'lastSeenSeq' key if no contiguous found
      if (typeof result === 'number') {
        resolve(result);
      } else {
        // Try legacy key migration
        const legacyRequest = tx.objectStore(STORE_NAME).get('lastSeenSeq');
        legacyRequest.onsuccess = () => {
          const legacyResult = legacyRequest.result;
          resolve(typeof legacyResult === 'number' ? legacyResult : null);
        };
        legacyRequest.onerror = () => resolve(null);
      }
    };
    request.onerror = () => reject(request.error);
  });
}

/**
 * Persist the server doc epoch this client last synced against.
 *
 * The epoch increments on every destructive server restore. On mismatch the
 * client must hard-reset (adopt the server's state fresh) — CRDT-merging or
 * diff-pushing across an epoch boundary resurrects deleted content
 * (quirk-audit 2026-07-09, sync cluster).
 */
export async function saveKnownEpoch(epoch: number): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(epoch, 'knownEpoch');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Get the persisted server doc epoch. Null if never synced. */
export async function getKnownEpoch(): Promise<number | null> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).get('knownEpoch');
    request.onsuccess = () => {
      const result = request.result;
      resolve(typeof result === 'number' ? result : null);
    };
    request.onerror = () => reject(request.error);
  });
}

/** Clear the persisted epoch (pre-epoch server reset — lineage unknowable). */
export async function clearKnownEpoch(): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete('knownEpoch');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Clear last contiguous sequence number (called on workspace switch).
 */
export async function clearLastContiguousSeq(): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    // Clear both new and legacy keys
    tx.objectStore(STORE_NAME).delete('lastContiguousSeq');
    tx.objectStore(STORE_NAME).delete('lastSeenSeq');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    if (dbPromise) {
      dbPromise.then(db => db.close()).catch(() => {});
      dbPromise = null;
    }
  });
}
