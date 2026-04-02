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
 * Initialize the backup namespace based on build environment and workspace.
 * MUST be called BEFORE any backup operations (getBackup, saveBackup, etc.)
 *
 * Creates isolation between: dev/release builds AND different workspaces
 * e.g., 'floatty-backup-dev-default' vs 'floatty-backup-release-work'
 */
export function initBackupNamespace(workspaceName: string): void {
  const build = import.meta.env.DEV ? 'dev' : 'release';
  const newDbName = `floatty-backup-${build}-${workspaceName}`;

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
