#!/usr/bin/env node
/**
 * Export floatty outline from SQLite Yjs storage
 * Usage: node export-outline.mjs
 */

import { DatabaseSync } from 'node:sqlite';
import * as Y from 'yjs';
import { homedir } from 'os';

const db = new DatabaseSync(`${homedir()}/.floatty/ctx_markers.db`);

// Get all ydoc updates
const rows = db.prepare(`
  SELECT doc_key, update_data FROM ydoc_updates
  ORDER BY doc_key, id
`).all();

// Group by doc_key
const byDoc = {};
for (const row of rows) {
  if (!byDoc[row.doc_key]) byDoc[row.doc_key] = [];
  byDoc[row.doc_key].push(row.update_data);
}

// Process each doc
for (const [docKey, updates] of Object.entries(byDoc)) {
  const ydoc = new Y.Doc();
  for (const data of updates) {
    Y.applyUpdate(ydoc, new Uint8Array(data));
  }

  // Get the blocks map
  const blocksMap = ydoc.getMap('blocks');
  const rootIds = ydoc.getArray('rootIds');

  if (blocksMap.size === 0) continue;

  console.log(`\n=== Pane: ${docKey} (${blocksMap.size} blocks) ===\n`);

  // Build blocks map (keep childIds for ordering)
  const blocks = new Map();

  for (const [id, blockMap] of blocksMap.entries()) {
    // Defensive: handle both Y.Map and legacy plain object formats during migration
    const isYMap = blockMap instanceof Y.Map;
    const block = {
      content: (isYMap ? blockMap.get('content') : blockMap.content) || '',
      parentId: (isYMap ? blockMap.get('parentId') : blockMap.parentId) || null,
      childIds: isYMap
        ? (blockMap.get('childIds')?.toArray() || [])
        : (Array.isArray(blockMap.childIds) ? blockMap.childIds : []),
    };
    blocks.set(id, block);
  }

  // Recursive print - uses block.childIds for correct sibling order
  function printBlock(id, depth = 0) {
    const block = blocks.get(id);
    if (!block) return;

    const indent = '  '.repeat(depth);
    const content = block.content || '[empty]';

    // Indent EVERY line of multi-line content (not just first)
    const lines = content.split('\n');
    for (const line of lines) {
      console.log(`${indent}${line}`);
    }

    // USE block.childIds - this preserves intentional ordering
    const kids = block.childIds || [];
    for (const kidId of kids) {
      printBlock(kidId, depth + 1);
    }
  }

  // Print from roots
  const roots = rootIds?.toArray() || children.get('ROOT') || [];
  for (const rootId of roots) {
    printBlock(rootId, 0);
  }
}

db.close();
