#!/usr/bin/env node
// Migration: legacy `render:: {full JSON}` content → projection-contract shape.
//
// Walks every block in the floatty outline, finds blocks where:
//   - outputType === "door"
//   - content starts with "render::" (case-insensitive)
//   - output.data.spec is set (so the rendered view exists)
//
// For each matched block, PATCHes:
//   - content = derived title (output.data.title || output.data.spec.title)
//
// Output (`outputType` / `output` / `outputStatus`) is left untouched —
// the spec keeps rendering exactly as before. ContentEditable now shows
// a clean semantic title instead of the JSON wall.
//
// SAFETY:
//   --dry-run     Print proposed changes; don't PATCH. Default off.
//   --confirm     Required for non-dry-run mutations. Hard-stop if absent.
//   --port=N      Override server port (default: read from ~/.floatty/config.toml).
//   --backup=PATH Write a JSON backup of (id, original_content) for every
//                 block we touched, so a future un-migrate is a one-liner.
//
// Usage:
//   node scripts/migrate-render-projection-contract.mjs --dry-run
//   node scripts/migrate-render-projection-contract.mjs --confirm --backup=/tmp/floatty-render-migration-2026-05-08.json
//
// Resolution rules in `deriveDoorTitle()` (apps/floatty/src/lib/blockItemHelpers.ts)
// are the canonical source — this script mirrors their logic so the migration
// produces blocks that the v0.14.4 frontend would derive the same title for.

import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ─────────────────────────────────────────────────────────────────────
// CLI parsing
// ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flags = {
  dryRun: args.includes('--dry-run'),
  confirm: args.includes('--confirm'),
  port: null,
  backup: null,
};
for (const a of args) {
  if (a.startsWith('--port=')) flags.port = parseInt(a.slice(7), 10);
  if (a.startsWith('--backup=')) flags.backup = a.slice(9);
}

if (!flags.dryRun && !flags.confirm) {
  console.error('REFUSING TO RUN — pass --dry-run to preview, or --confirm to mutate.');
  console.error('Strongly suggest: --confirm --backup=/tmp/floatty-render-migration-$(date +%F).json');
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────
// Server config
// ─────────────────────────────────────────────────────────────────────

const configPath = join(homedir(), '.floatty', 'config.toml');
let apiKey;
let port;
try {
  const conf = readFileSync(configPath, 'utf8');
  apiKey = conf.match(/^api_key\s*=\s*"([^"]+)"/m)?.[1];
  port = flags.port ?? parseInt(conf.match(/^server_port\s*=\s*(\d+)/m)?.[1] ?? '8765', 10);
} catch (err) {
  console.error(`Failed to read ${configPath}: ${err.message}`);
  process.exit(1);
}
if (!apiKey) {
  console.error('No api_key found in config.toml');
  process.exit(1);
}

const base = `http://127.0.0.1:${port}`;
const headers = {
  'Authorization': `Bearer ${apiKey}`,
  'Content-Type': 'application/json',
};

// ─────────────────────────────────────────────────────────────────────
// Title derivation — mirrors deriveDoorTitle() in blockItemHelpers.ts
// ─────────────────────────────────────────────────────────────────────

function isCleanTitle(s) {
  if (typeof s !== 'string') return false;
  const t = s.trim();
  return t.length > 0 && t.length <= 120 && !t.startsWith('{') && !t.startsWith('[');
}

function deriveDoorTitle(block) {
  if (!block || block.outputType !== 'door' || !block.output) return null;
  const content = block.content ?? '';
  const isLegacy = content.toLowerCase().startsWith('render::');

  // (1) New projection-contract path — content already IS the title.
  if (!isLegacy && isCleanTitle(content)) return content.trim();

  // (2) output.data.title — preferred for legacy render:: blocks.
  const data = block.output?.data;
  if (isCleanTitle(data?.title)) return data.title.trim();

  // (3) output.data.spec.title — synchronous fallback.
  if (isCleanTitle(data?.spec?.title)) return data.spec.title.trim();

  return null;
}

// ─────────────────────────────────────────────────────────────────────
// Walk + classify
// ─────────────────────────────────────────────────────────────────────

console.log(`Connecting to ${base} ...`);
const blocksRes = await fetch(`${base}/api/v1/blocks`, { headers });
if (!blocksRes.ok) {
  console.error(`GET /api/v1/blocks → ${blocksRes.status} ${blocksRes.statusText}`);
  process.exit(1);
}
const { blocks: blockList } = await blocksRes.json();
console.log(`Outline has ${blockList.length} blocks.`);

// Bulk endpoint doesn't include output by default. Re-fetch each render::
// candidate via per-block GET (which DOES surface output) so we can derive
// titles.
const renderCandidates = blockList.filter(b =>
  b.outputType === 'door'
  && typeof b.content === 'string'
  && b.content.toLowerCase().startsWith('render::')
);
console.log(`Found ${renderCandidates.length} legacy \`render:: {json}\` candidates.`);

const migrations = [];
const skipped = [];

for (const b of renderCandidates) {
  const fullRes = await fetch(`${base}/api/v1/blocks/${b.id}`, { headers });
  if (!fullRes.ok) {
    skipped.push({ id: b.id, reason: `GET failed: ${fullRes.status}`, content: b.content.slice(0, 80) });
    continue;
  }
  const full = await fullRes.json();
  const title = deriveDoorTitle(full);
  // Defensive against a malformed API response that omits/nulls `content`:
  // a TypeError on .slice/.trim mid-loop would abort migration after the
  // backup is already written, leaving skipped/failed counts wrong.
  const safeContent = full.content ?? '';
  if (!title) {
    skipped.push({ id: b.id, reason: 'no clean title derivable', content: safeContent.slice(0, 80) });
    continue;
  }
  if (title === safeContent.trim()) {
    skipped.push({ id: b.id, reason: 'content already matches title (no-op)', content: safeContent.slice(0, 80) });
    continue;
  }
  migrations.push({
    id: b.id,
    originalContent: safeContent,
    newContent: title,
    contentLen: safeContent.length,
    titleLen: title.length,
  });
}

console.log('');
console.log(`═══ MIGRATION PLAN — ${migrations.length} block(s) to PATCH ═══`);
for (const m of migrations) {
  console.log(`  ${m.id.slice(0, 8)}  [${m.contentLen} → ${m.titleLen}]  "${m.newContent}"`);
}
console.log('');
console.log(`═══ SKIPPED — ${skipped.length} candidate(s) NOT touched ═══`);
for (const s of skipped) {
  console.log(`  ${s.id.slice(0, 8)}  ${s.reason}  "${s.content}"`);
}
console.log('');

if (flags.dryRun) {
  console.log('--dry-run set; no mutations performed.');
  process.exit(0);
}

// ─────────────────────────────────────────────────────────────────────
// Backup, then mutate
// ─────────────────────────────────────────────────────────────────────

if (flags.backup) {
  writeFileSync(
    flags.backup,
    JSON.stringify(migrations.map(m => ({ id: m.id, originalContent: m.originalContent, newContent: m.newContent })), null, 2),
  );
  console.log(`Backup written: ${flags.backup}`);
}

console.log('Applying PATCHes ...');
let succeeded = 0;
let failed = 0;
for (const m of migrations) {
  const res = await fetch(`${base}/api/v1/blocks/${m.id}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ content: m.newContent }),
  });
  if (res.ok) {
    succeeded++;
    console.log(`  ✓ ${m.id.slice(0, 8)}  "${m.newContent}"`);
  } else {
    failed++;
    const body = await res.text();
    console.log(`  ✗ ${m.id.slice(0, 8)}  PATCH ${res.status}: ${body.slice(0, 200)}`);
  }
}

console.log('');
console.log(`═══ DONE — ${succeeded} succeeded / ${failed} failed / ${skipped.length} skipped ═══`);
if (failed > 0) process.exit(2);
