#!/usr/bin/env npx tsx
/**
 * Binary Import - Load .ydoc file and restore to server
 *
 * FLO-247: Uses /api/v1/restore to completely replace server state.
 * For incremental sync, use /api/v1/update instead.
 *
 * Usage:
 *   npx tsx scripts/binary-import.ts [file.ydoc]
 *   npx tsx scripts/binary-import.ts ~/float-hub/inbox/floatty-2026-02-02.ydoc
 */
import * as fs from 'fs';
import * as path from 'path';
import * as Y from 'yjs';

const configPath = path.join(process.env.HOME!, '.floatty-dev/config.toml');
const content = fs.readFileSync(configPath, 'utf-8');
const match = content.match(/api_key\s*=\s*"([^"]+)"/);
const API_KEY = match?.[1] || '';
const PORT = 33333;

function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK_SIZE = 8192;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    const chunk = bytes.subarray(i, Math.min(i + CHUNK_SIZE, bytes.length));
    binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
  }
  return btoa(binary);
}

async function main() {
  const file = process.argv[2] || '/Users/evan/float-hub/inbox/floatty-2026-02-02.ydoc';
  console.log(`Loading ${file}...`);

  const buffer = fs.readFileSync(file);
  const state = new Uint8Array(buffer);
  console.log(`Read ${state.length} bytes`);

  // Verify it's a valid Y.Doc update
  const testDoc = new Y.Doc();
  Y.applyUpdate(testDoc, state);

  const blocksMap = testDoc.getMap('blocks');
  const rootIds = testDoc.getArray('rootIds');
  console.log(`Verified: ${blocksMap.size} blocks, ${rootIds.length} roots`);

  // Check server state BEFORE restore
  const beforeResponse = await fetch(`http://127.0.0.1:${PORT}/api/v1/blocks`, {
    headers: { 'Authorization': `Bearer ${API_KEY}` }
  });
  const beforeData = await beforeResponse.json();
  console.log(`\nServer BEFORE: ${beforeData.blocks?.length || 0} blocks`);

  // Send to /api/v1/restore (replaces state completely)
  const base64 = bytesToBase64(state);
  console.log(`\nRestoring ${base64.length} base64 chars...`);

  const response = await fetch(`http://127.0.0.1:${PORT}/api/v1/restore`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ state: base64 })
  });

  if (!response.ok) {
    const text = await response.text();
    console.error(`Server error: ${response.status} ${text}`);
    process.exit(1);
  }

  const result = await response.json();
  console.log(`\n✅ Restore complete!`);
  console.log(`   Blocks: ${result.block_count}`);
  console.log(`   Roots: ${result.root_count}`);

  // Verify server state AFTER restore
  const afterResponse = await fetch(`http://127.0.0.1:${PORT}/api/v1/blocks`, {
    headers: { 'Authorization': `Bearer ${API_KEY}` }
  });
  const afterData = await afterResponse.json();
  console.log(`\nServer AFTER: ${afterData.blocks?.length || 0} blocks`);

  // Final verification
  if (afterData.blocks?.length === blocksMap.size) {
    console.log(`\n🎉 Verification PASSED: ${afterData.blocks.length} blocks match export`);
  } else {
    console.error(`\n❌ Verification FAILED: expected ${blocksMap.size}, got ${afterData.blocks?.length}`);
    process.exit(1);
  }
}

main().catch(console.error);
