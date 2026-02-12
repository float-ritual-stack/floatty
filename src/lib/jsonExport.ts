/**
 * jsonExport.ts - Human-readable JSON export with validation
 *
 * FLO-247: Insurance against another 9-hour hell loop.
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

import type { Block } from '../hooks/useBlockStore';
import { save } from '@tauri-apps/plugin-dialog';
import { writeTextFile } from '@tauri-apps/plugin-fs';

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
  version: 1;
  exported: string;
  blockCount: number;
  rootIds: string[];
  blocks: Record<string, ExportedBlock>;
}

/**
 * Convert block store state to exportable JSON structure.
 */
export function exportOutlineToJSON(
  blocksRecord: Record<string, Block>,
  rootIds: string[]
): ExportedOutline {
  const blocks: ExportedOutline['blocks'] = {};

  for (const [id, block] of Object.entries(blocksRecord)) {
    // Clone arrays/objects to detach from SolidJS store proxies
    blocks[id] = {
      content: block.content,
      parentId: block.parentId || null,
      childIds: block.childIds ? [...block.childIds] : [],
      type: block.type || 'text',
      collapsed: block.collapsed || false,
      createdAt: block.createdAt || 0,
      updatedAt: block.updatedAt || 0,
      metadata: block.metadata ? { ...block.metadata } : {},
    };
  }

  return {
    version: 1,
    exported: new Date().toISOString(),
    blockCount: Object.keys(blocks).length,
    rootIds: [...rootIds], // Clone to detach from store
    blocks,
  };
}

/**
 * Validate export integrity before download.
 *
 * CRITICAL: Prevents exporting garbage that can't be restored.
 */
export function validateExport(exported: ExportedOutline): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // 1. All childIds must exist
  for (const [id, block] of Object.entries(exported.blocks)) {
    for (const childId of block.childIds) {
      if (!exported.blocks[childId]) {
        errors.push(`Block ${id} has childId ${childId} that doesn't exist`);
      }
    }
  }

  // 2. All parentIds must exist (or be null)
  for (const [id, block] of Object.entries(exported.blocks)) {
    if (block.parentId && !exported.blocks[block.parentId]) {
      errors.push(`Block ${id} has parentId ${block.parentId} that doesn't exist`);
    }
  }

  // 3. rootIds must exist
  for (const rootId of exported.rootIds) {
    if (!exported.blocks[rootId]) {
      errors.push(`Root ${rootId} doesn't exist in blocks`);
    }
  }

  // 4. Block count must match
  const actualCount = Object.keys(exported.blocks).length;
  if (actualCount !== exported.blockCount) {
    errors.push(`blockCount ${exported.blockCount} doesn't match actual ${actualCount}`);
  }

  // 5. Root blocks should have null parentId
  for (const rootId of exported.rootIds) {
    const block = exported.blocks[rootId];
    if (block && block.parentId !== null) {
      errors.push(`Root ${rootId} has non-null parentId: ${block.parentId}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Download validated JSON export to user's filesystem.
 * Uses Tauri save dialog to avoid Downloads folder permission issues.
 */
export async function downloadJSON(data: ExportedOutline, filename?: string): Promise<void> {
  try {
    const json = JSON.stringify(data, null, 2);

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
      console.log('[jsonExport] User cancelled save dialog');
      return;
    }

    // Write file via Tauri fs
    await writeTextFile(filePath, json);
    console.log('[jsonExport] Saved to:', filePath);
  } catch (err) {
    console.error('[jsonExport] Failed to export:', err);
    throw err;
  }
}
