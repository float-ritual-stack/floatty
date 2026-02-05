/**
 * idbBackup - IndexedDB storage for Y.Doc backup
 *
 * Replaces localStorage backup to support larger Y.Doc sizes.
 * - localStorage limit: 5MB (hit at 5.4MB, lost data 2026-01-23)
 * - IndexedDB limit: typically 50MB+ or % of disk
 * - Binary storage: no base64 overhead
 */

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
    console.log(`[idbBackup] Namespace set to: ${dbName}`);
  }
}

function getDB(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName, DB_VERSION);
      request.onerror = () => {
        console.error('[idbBackup] Failed to open database:', request.error);
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
      console.log(`[idbBackup] Saved backup: ${state.length} bytes to ${dbName}`);
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
        console.log(`[idbBackup] Loaded backup: ${result.length} bytes from ${dbName}`);
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
 * Save last seen sequence number to IndexedDB.
 * Used for gap detection on reconnect after browser refresh/crash.
 */
export async function saveLastSeenSeq(seq: number): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(seq, 'lastSeenSeq');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Get last seen sequence number from IndexedDB.
 * Returns null if not previously saved.
 */
export async function getLastSeenSeq(): Promise<number | null> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).get('lastSeenSeq');
    request.onsuccess = () => {
      const result = request.result;
      resolve(typeof result === 'number' ? result : null);
    };
    request.onerror = () => reject(request.error);
  });
}

/**
 * Clear last seen sequence number (called on workspace switch).
 */
export async function clearLastSeenSeq(): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete('lastSeenSeq');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
