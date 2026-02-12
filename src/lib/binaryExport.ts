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
import { save } from '@tauri-apps/plugin-dialog';
import { writeFile } from '@tauri-apps/plugin-fs';

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
 * Uses Tauri save dialog to avoid Downloads folder permission issues.
 *
 * File can be restored later via Y.applyUpdate(doc, bytes)
 */
export async function downloadBinary(doc: Y.Doc, filename?: string): Promise<void> {
  const state = Y.encodeStateAsUpdate(doc);

  // Generate default filename with timestamp
  const iso = new Date().toISOString();
  const date = iso.slice(0, 10);
  const time = iso.slice(11, 19).replace(/:/g, '');
  const defaultFilename = filename || `floatty-${date}-${time}.ydoc`;

  // Use Tauri save dialog
  const filePath = await save({
    defaultPath: defaultFilename,
    filters: [{
      name: 'Y.Doc Binary',
      extensions: ['ydoc']
    }]
  });

  if (!filePath) {
    console.log('[binaryExport] User cancelled save dialog');
    return;
  }

  // Write file via Tauri fs
  await writeFile(filePath, state);
  console.log(`[binaryExport] Saved ${state.length} bytes to:`, filePath);
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
