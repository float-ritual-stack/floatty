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
 *
 * NOTE: Chunked encoding to avoid stack overflow on large docs.
 * String.fromCharCode(...array) spreads can exceed call stack limits.
 */
export function exportBinaryBase64(doc: Y.Doc): string {
  const state = Y.encodeStateAsUpdate(doc);

  // Build binary string in chunks to avoid "Maximum call stack size exceeded"
  // for large Y.Doc states (can be MB+ for real outlines)
  const CHUNK_SIZE = 8192;
  let binary = '';
  for (let i = 0; i < state.length; i += CHUNK_SIZE) {
    const chunk = state.subarray(i, Math.min(i + CHUNK_SIZE, state.length));
    binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
  }
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
  // Include time (HHmmss) to avoid (1) (2) (3) collisions and match API format
  // Use UTC consistently (toTimeString returns local time, which mismatches date from ISO)
  const iso = new Date().toISOString();
  const date = iso.slice(0, 10);
  const time = iso.slice(11, 19).replace(/:/g, '');
  a.download = filename || `floatty-${date}-${time}.ydoc`;
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
