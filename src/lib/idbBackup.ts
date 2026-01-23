/**
 * idbBackup - IndexedDB storage for Y.Doc backup
 *
 * Replaces localStorage backup to support larger Y.Doc sizes.
 * - localStorage limit: 5MB (hit at 5.4MB, lost data 2026-01-23)
 * - IndexedDB limit: typically 50MB+ or % of disk
 * - Binary storage: no base64 overhead
 */

const DB_NAME = 'floatty-backup';
const STORE_NAME = 'ydoc';
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function getDB(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(STORE_NAME);
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
    tx.oncomplete = () => resolve();
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
    request.onsuccess = () => resolve(request.result ?? null);
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
