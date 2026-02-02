/**
 * binaryExport.ts - Perfect Y.Doc binary export
 *
 * FLO-247: Primary restore method. Preserves full CRDT state including
 * vector clocks, tombstones, and operation ordering.
 *
 * Use this for:
 * - Perfect restore (no data loss)
 * - Migration between instances
 * - Backup before risky operations
 *
 * Format: Raw Y.Doc state update (Uint8Array)
 */

import * as Y from 'yjs';

/**
 * Export Y.Doc state as Uint8Array for direct restore.
 */
export function exportBinary(doc: Y.Doc): Uint8Array {
  return Y.encodeStateAsUpdate(doc);
}

/**
 * Export Y.Doc state as base64 string.
 */
export function exportBinaryBase64(doc: Y.Doc): string {
  const state = Y.encodeStateAsUpdate(doc);
  // Use built-in btoa with a workaround for binary data
  const binary = String.fromCharCode(...state);
  return btoa(binary);
}

/**
 * Download Y.Doc binary state to user's filesystem.
 *
 * File can be restored later via Y.applyUpdate(doc, bytes)
 */
export function downloadBinary(doc: Y.Doc, filename?: string): void {
  const state = Y.encodeStateAsUpdate(doc);
  const blob = new Blob([state], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || `floatty-${new Date().toISOString().slice(0, 10)}.ydoc`;
  a.click();
  URL.revokeObjectURL(url);
  console.log(`[binaryExport] Downloaded ${state.length} bytes`);
}

/**
 * Restore Y.Doc from binary state.
 *
 * NOTE: This applies the state to an existing doc. Changes are merged,
 * not replaced. For a fresh restore, create a new Y.Doc first.
 */
export function restoreBinary(doc: Y.Doc, state: Uint8Array): void {
  Y.applyUpdate(doc, state, 'binary-restore');
}

/**
 * Load a .ydoc file and return the Uint8Array state.
 *
 * Usage:
 * ```
 * const input = document.createElement('input');
 * input.type = 'file';
 * input.accept = '.ydoc';
 * input.onchange = async () => {
 *   const state = await loadBinaryFile(input.files[0]);
 *   restoreBinary(doc, state);
 * };
 * input.click();
 * ```
 */
export async function loadBinaryFile(file: File): Promise<Uint8Array> {
  const buffer = await file.arrayBuffer();
  return new Uint8Array(buffer);
}
