#!/usr/bin/env npx tsx
/**
 * Staged Import - Import backup in batches with verification
 *
 * Usage:
 *   npx tsx scripts/staged-import.ts /tmp/llm-fixed-backup.md --batch=50 --port=8766
 *   npx tsx scripts/staged-import.ts /tmp/llm-fixed-backup.md --continue --port=8766
 */

import * as fs from 'fs';
import * as path from 'path';

export interface Block {
  content: string;
  depth: number;
  lineNumber: number;
}

// State file to track progress
const stateFile = '/tmp/staged-import-state.json';

interface ImportState {
  file: string;
  blocksImported: number;
  lastLineNumber: number;
  parentStack: (string | null)[];
}

function loadState(): ImportState | null {
  if (!fs.existsSync(stateFile)) return null;
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
  } catch {
    return null;
  }
}

function saveState(state: ImportState) {
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

function getApiKey(): string {
  const configPath = path.join(process.env.HOME!, '.floatty-dev/config.toml');
  if (fs.existsSync(configPath)) {
    const content = fs.readFileSync(configPath, 'utf-8');
    const match = content.match(/api_key\s*=\s*"([^"]+)"/);
    if (match) return match[1];
  }
  throw new Error('Could not find API key');
}

/**
 * Detect if a line is a continuation of the previous block.
 * Now includes fence tracking - lines inside code fences are continuations.
 */
let inCodeFence = false;

/** Reset fence state - exported for testing */
export function resetFenceState() {
  inCodeFence = false;
}

/** Check if currently inside a code fence - exported for testing */
export function isInCodeFence(): boolean {
  return inCodeFence;
}

export function isContinuationLine(trimmed: string): boolean {
  // Empty line = not continuation (but doesn't exit fence)
  if (trimmed === '') return false;

  // Check for fence toggle FIRST
  if (trimmed.startsWith('```')) {
    if (!inCodeFence) {
      // Opening fence - this line starts a NEW block (the code block)
      inCodeFence = true;
      return false; // New block starts here
    } else {
      // Closing fence - this is the LAST line of the code block, still continuation
      inCodeFence = false;
      return true; // Part of current block
    }
  }

  // Inside fence = always continuation
  if (inCodeFence) {
    return true;
  }

  // Table continuation: starts with │ but NOT with date pattern
  // "Jan 19 │" = new block, "│ continued text" = continuation
  if (trimmed.startsWith('│')) {
    // Check if it's a date line: "Mon DD │" pattern
    const datePattern = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d+\s*│/;
    return !datePattern.test(trimmed);
  }

  // Pure box drawing lines (table borders)
  if (/^[├└┌┐┘┬┴┼─═║╔╗╚╝╠╣╦╩╬]+$/.test(trimmed)) {
    return true;
  }

  return false;
}

// TRUE ROOTS - only these patterns are allowed at depth 0
const TRUE_ROOT_PATTERNS = [
  /^## here be dragons/,
  /^## Weekly notes/,
  /^pages::$/,
];

function isTrueRoot(content: string): boolean {
  return TRUE_ROOT_PATTERNS.some(p => p.test(content));
}

export function parseBackup(content: string): Block[] {
  const lines = content.split('\n');
  const blocks: Block[] = [];
  let inHeader = true;
  let currentBlock: Block | null = null;
  let lastValidDepth = 0; // Track depth of last properly-nested block
  inCodeFence = false; // Reset fence state at start of parse

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('=== Pane:')) { inHeader = false; continue; }
    if (inHeader) continue;

    const trimmed = line.trim();

    // Empty lines: inside code fence = append to block, outside = end block
    if (trimmed === '') {
      if (inCodeFence && currentBlock) {
        // Preserve empty lines inside code fences
        currentBlock.content += '\n';
      } else {
        currentBlock = null;
      }
      continue;
    }

    const leadingSpaces = line.match(/^(\s*)/)?.[1].length ?? 0;

    // TRUE ROOTS always start new blocks, even inside broken fences
    if (leadingSpaces === 0 && isTrueRoot(trimmed)) {
      // Reset fence state at true roots (fixes unbalanced fence issues)
      inCodeFence = false;
      currentBlock = {
        content: trimmed,
        depth: 0,
        lineNumber: i + 1,
      };
      blocks.push(currentBlock);
      lastValidDepth = 0;
      continue;
    }

    // Calculate depth and handle orphans
    let depth = Math.floor(leadingSpaces / 2);

    // ORPHAN DETECTION: col0 lines that aren't true roots get re-parented
    if (depth === 0 && !isTrueRoot(trimmed) && blocks.length > 0) {
      depth = lastValidDepth + 1;
    }

    // ALWAYS call isContinuationLine to track fence state (it has side effects!)
    const isContinuation = isContinuationLine(trimmed);

    if (currentBlock && isContinuation) {
      // Append to previous block
      currentBlock.content += '\n' + trimmed;
    } else {
      // New block
      currentBlock = {
        content: trimmed,
        depth,
        lineNumber: i + 1,
      };
      blocks.push(currentBlock);

      // Update last valid depth for non-orphan blocks
      if (leadingSpaces > 0 || isTrueRoot(trimmed)) {
        lastValidDepth = depth;
      }
    }
  }
  return blocks;
}

// ============================================================================
// CLI-only code below - only executes when run directly
// ============================================================================

async function createBlock(port: number, apiKey: string, content: string, parentId?: string): Promise<string> {
  const body: { content: string; parentId?: string } = { content };
  if (parentId) body.parentId = parentId;

  const response = await fetch(`http://127.0.0.1:${port}/api/v1/blocks`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API error ${response.status}: ${text}`);
  }

  const result = await response.json() as { id: string };
  return result.id;
}

async function getBlockCount(port: number, apiKey: string): Promise<number> {
  const response = await fetch(`http://127.0.0.1:${port}/api/v1/blocks`, {
    headers: { 'Authorization': `Bearer ${apiKey}` },
  });
  if (!response.ok) throw new Error('Failed to get blocks');
  const data = await response.json() as { blocks: Record<string, unknown> };
  return Object.keys(data.blocks).length;
}

async function main(filePath: string, port: number, batchSize: number, continueFlag: boolean) {
  const apiKey = getApiKey();

  // Check server
  try {
    const count = await getBlockCount(port, apiKey);
    console.log(`Server responding. Current blocks: ${count}`);
  } catch {
    console.error('❌ Server not responding on port ' + port);
    console.error('Start floatty first: npm run tauri dev');
    process.exit(1);
  }

  // Parse backup
  console.log(`Reading: ${filePath}`);
  const content = fs.readFileSync(filePath, 'utf-8');
  const allBlocks = parseBackup(content);
  console.log(`Total blocks in file: ${allBlocks.length}`);

  // Load or init state
  let state = continueFlag ? loadState() : null;
  if (state && state.file !== filePath) {
    console.log('State file is for different backup, starting fresh');
    state = null;
  }

  if (!state) {
    state = {
      file: filePath,
      blocksImported: 0,
      lastLineNumber: 0,
      parentStack: [null],
    };
  }

  console.log(`\nStarting from block ${state.blocksImported}`);
  console.log(`Importing batch of ${batchSize} blocks...`);

  // Find starting index
  const startIdx = allBlocks.findIndex(b => b.lineNumber > state!.lastLineNumber);
  if (startIdx === -1) {
    console.log('✓ All blocks already imported!');
    return;
  }

  const endIdx = Math.min(startIdx + batchSize, allBlocks.length);
  const batch = allBlocks.slice(startIdx, endIdx);

  console.log(`Batch: blocks ${startIdx + 1} to ${endIdx} (lines ${batch[0].lineNumber}-${batch[batch.length-1].lineNumber})`);

  let created = 0;
  let errors = 0;
  const parentStack = state.parentStack;

  for (const block of batch) {
    try {
      // Handle depth jumps: if parent doesn't exist, use closest ancestor
      let effectiveDepth = block.depth;
      let parentId: string | undefined = undefined;

      if (effectiveDepth > 0) {
        // Walk back to find valid parent
        for (let d = effectiveDepth - 1; d >= 0; d--) {
          if (parentStack[d]) {
            parentId = parentStack[d] as string;
            break;
          }
        }
        // If no parent found and depth > 0, this is an error in the source file
        // but we'll attach it to the last known block at any depth
        if (!parentId && parentStack.length > 0) {
          for (let d = parentStack.length - 1; d >= 0; d--) {
            if (parentStack[d]) {
              parentId = parentStack[d] as string;
              break;
            }
          }
        }
      }

      const id = await createBlock(port, apiKey, block.content, parentId);

      parentStack[block.depth] = id;
      // Don't truncate - keep parent references valid for depth jumps

      created++;
      state.blocksImported++;
      state.lastLineNumber = block.lineNumber;
      state.parentStack = parentStack;

      if (created % 10 === 0) {
        process.stdout.write(`\r  Created ${created}/${batch.length}...`);
      }
    } catch (err) {
      console.error(`\nError at line ${block.lineNumber}: ${err}`);
      errors++;
      if (errors > 3) {
        console.error('Too many errors, stopping');
        break;
      }
    }
  }

  // Save state
  saveState(state);

  console.log(`\n\n✓ Batch complete: ${created} blocks created`);
  console.log(`Total imported: ${state.blocksImported}/${allBlocks.length}`);

  // Verify
  const finalCount = await getBlockCount(port, apiKey);
  console.log(`Server now has: ${finalCount} blocks`);

  if (state.blocksImported < allBlocks.length) {
    console.log(`\nTo continue: npx tsx scripts/staged-import.ts ${filePath} --continue --port=${port}`);
    console.log(`To import all remaining: add --batch=${allBlocks.length - state.blocksImported}`);
  } else {
    console.log('\n🎉 Import complete!');
    fs.unlinkSync(stateFile);
  }
}

// Only run CLI when executed directly (not imported)
const isMainModule = process.argv[1] && (
  process.argv[1].endsWith('staged-import.ts') ||
  process.argv[1].includes('staged-import')
);

if (isMainModule) {
  // Parse args
  const args = process.argv.slice(2);
  const filePath = args.find(a => !a.startsWith('--'));
  const batchArg = args.find(a => a.startsWith('--batch='));
  const portArg = args.find(a => a.startsWith('--port='));
  const continueFlag = args.includes('--continue');

  const batchSize = batchArg ? parseInt(batchArg.split('=')[1]) : 50;
  const port = portArg ? parseInt(portArg.split('=')[1]) : 8766;

  if (!filePath) {
    console.error('Usage: npx tsx scripts/staged-import.ts <backup-file> [--batch=50] [--port=8766] [--continue]');
    process.exit(1);
  }

  main(filePath, port, batchSize, continueFlag).catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}
