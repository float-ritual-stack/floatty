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

  // Build parent->children map
  const children = new Map();
  const blocks = new Map();

  for (const [id, block] of blocksMap.entries()) {
    blocks.set(id, block);
    const parentId = block.parentId || 'ROOT';
    if (!children.has(parentId)) children.set(parentId, []);
    children.get(parentId).push(id);
  }

  // Recursive print
  function printBlock(id, depth = 0) {
    const block = blocks.get(id);
    if (!block) return;

    const indent = '  '.repeat(depth);
    const content = block.content || '[empty]';
    console.log(`${indent}${content}`);

    const kids = children.get(id) || [];
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
