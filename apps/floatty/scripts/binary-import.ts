#!/usr/bin/env npx tsx
/**
 * Binary Import - Load .ydoc file and restore to server
 *
 * FLO-247: Uses /api/v1/restore to completely replace server state.
 * For incremental sync, use /api/v1/update instead.
 *
 * Usage:
 *   npx tsx scripts/binary-import.ts <file.ydoc>
 *   npx tsx scripts/binary-import.ts ~/float-hub/inbox/floatty-2026-02-02.ydoc
 *
 *   # Seed a remote authority (FLO-762) — point at any server + any config:
 *   npx tsx scripts/binary-import.ts <file.ydoc> --url http://float-box:8765
 *   npx tsx scripts/binary-import.ts <file.ydoc> --config /opt/float/floatty-data/config.toml
 *
 * Resolution:
 *   - URL: --url flag > http://127.0.0.1:{server_port from config}
 *   - Key: --key flag > api_key from config (--config flag > ~/.floatty-dev/config.toml)
 */
import * as fs from 'fs';
import * as path from 'path';
import * as Y from 'yjs';

// ── Arg parsing: positional .ydoc file + --url/--config/--key overrides ──
const args = process.argv.slice(2);
const positional: string[] = [];
const flags: Record<string, string> = {};
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--url' || a === '--config' || a === '--key') {
    const v = args[++i];
    if (!v) {
      console.error(`Missing value for ${a}`);
      process.exit(1);
    }
    flags[a.slice(2)] = v;
  } else {
    positional.push(a);
  }
}

// Config is only required when a flag doesn't already supply the value
// (FLO-762: the script used to hardcode ~/.floatty-dev/config.toml +
// 127.0.0.1:{port}, which path-locked it to the local dev server and made
// remote seeding impossible without config gymnastics).
const configPath = flags.config ?? path.join(process.env.HOME!, '.floatty-dev/config.toml');
let configContent = '';
if (!flags.key || !flags.url) {
  try {
    configContent = fs.readFileSync(configPath, 'utf-8');
  } catch {
    console.error(
      `Cannot read config at ${configPath} — pass --url and --key, or --config <path>`
    );
    process.exit(1);
  }
}

const keyMatch = configContent.match(/api_key\s*=\s*"([^"]+)"/);
const portMatch = configContent.match(/server_port\s*=\s*(\d+)/);

const API_KEY = flags.key ?? keyMatch?.[1] ?? '';
const BASE_URL = (flags.url ?? `http://127.0.0.1:${Number(portMatch?.[1] ?? 33333)}`).replace(
  /\/$/,
  ''
);

if (!API_KEY) {
  console.error('Missing API key (no --key flag and no api_key in config.toml)');
  process.exit(1);
}

async function main() {
  const file = positional[0];
  if (!file) {
    console.error(
      'Usage: npx tsx scripts/binary-import.ts <file.ydoc> [--url http://host:port] [--config path] [--key apikey]'
    );
    process.exit(1);
  }

  console.log(`Loading ${file}...`);
  console.log(`Target server: ${BASE_URL}`);

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
  const beforeResponse = await fetch(`${BASE_URL}/api/v1/blocks`, {
    headers: { 'Authorization': `Bearer ${API_KEY}` }
  });
  if (!beforeResponse.ok) {
    console.error(`Server unavailable: ${beforeResponse.status}`);
    process.exit(1);
  }
  const beforeData = await beforeResponse.json() as { blocks?: unknown[] };
  console.log(`\nServer BEFORE: ${beforeData.blocks?.length ?? 0} blocks`);

  // Send to /api/v1/restore (replaces state completely)
  const base64 = Buffer.from(state).toString('base64');
  console.log(`\nRestoring ${base64.length} base64 chars...`);

  const response = await fetch(`${BASE_URL}/api/v1/restore`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
      'X-Floatty-Confirm-Destructive': 'true'
    },
    body: JSON.stringify({ state: base64 })
  });

  if (!response.ok) {
    const text = await response.text();
    console.error(`Server error: ${response.status} ${text}`);
    process.exit(1);
  }

  const result = await response.json() as { block_count: number; root_count: number };
  console.log(`\n✅ Restore complete!`);
  console.log(`   Blocks: ${result.block_count}`);
  console.log(`   Roots: ${result.root_count}`);

  // Verify server state AFTER restore
  const afterResponse = await fetch(`${BASE_URL}/api/v1/blocks`, {
    headers: { 'Authorization': `Bearer ${API_KEY}` }
  });
  if (!afterResponse.ok) {
    console.error(`Server unavailable after restore: ${afterResponse.status}`);
    process.exit(1);
  }
  const afterData = await afterResponse.json() as { blocks?: unknown[] };
  console.log(`\nServer AFTER: ${afterData.blocks?.length ?? 0} blocks`);

  // Final verification
  if (afterData.blocks?.length === blocksMap.size) {
    console.log(`\n🎉 Verification PASSED: ${afterData.blocks.length} blocks match export`);
  } else {
    console.error(`\n❌ Verification FAILED: expected ${blocksMap.size}, got ${afterData.blocks?.length}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
