/**
 * jsonExport.ts - JSON export types and file save utility
 *
 * FLO-247: Insurance against another 9-hour hell loop.
 * FLO-393: Single export path — server is the sole producer of export JSON.
 *          This file provides types (for consumers that parse exports) and
 *          the save-to-disk utility. No local serialization.
 *
 * IMPORTANT: This is a LOSSY export - CRDT metadata (vector clocks,
 * tombstones, operation ordering) is NOT preserved. For perfect restore,
 * use binaryExport.ts which exports the full Y.Doc state.
 *
 * Use this for:
 * - Human-readable inspection
 * - Disaster recovery when binary fails
 * - Debugging structural issues
 */

import { save } from '@tauri-apps/plugin-dialog';
import { writeTextFile } from '@tauri-apps/plugin-fs';
import { createLogger } from './logger';

const logger = createLogger('jsonExport');

export interface ExportedBlock {
  content: string;
  parentId: string | null;
  childIds: string[];
  type: string;
  collapsed: boolean;
  createdAt: number;
  updatedAt: number;
  metadata: Record<string, unknown>;
}

export interface ExportedOutline {
  version: number;
  exported: string;
  blockCount: number;
  rootIds: string[];
  blocks: Record<string, ExportedBlock>;
}

/**
 * Save JSON export string to user's filesystem.
 * Uses Tauri save dialog to avoid Downloads folder permission issues.
 *
 * Accepts a pre-serialized JSON string (from server via httpClient.exportJSON()).
 */
export async function downloadJSON(json: string, filename?: string): Promise<void> {
  try {
    // Generate default filename with timestamp
    const iso = new Date().toISOString();
    const date = iso.slice(0, 10);
    const time = iso.slice(11, 19).replace(/:/g, '');
    const defaultFilename = filename || `floatty-${date}-${time}.json`;

    // Use Tauri save dialog
    const filePath = await save({
      defaultPath: defaultFilename,
      filters: [{
        name: 'JSON',
        extensions: ['json']
      }]
    });

    if (!filePath) {
      logger.info('User cancelled save dialog');
      return;
    }

    // Write file via Tauri fs
    await writeTextFile(filePath, json);
    logger.info(`Saved to: ${filePath}`);
  } catch (err) {
    logger.error('Failed to export', { err });
    throw err;
  }
}
