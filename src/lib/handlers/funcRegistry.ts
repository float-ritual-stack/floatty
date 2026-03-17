/**
 * func:: Meta-Handler Registry
 *
 * Enables outline-defined handlers: a `func:: issue` block with
 * `input::` and `body::` children teaches floatty a new `issue::` prefix
 * at runtime, from blocks, no .js files needed.
 *
 * Two pieces:
 * 1. Prefix index (Set<string>) — tracks which prefixes have func:: definitions.
 *    Updated on block changes. Makes isExecutableBlock() fast.
 * 2. funcMetaHandler — generic handler returned by findHandler() when prefix
 *    matches the index. Reads func block children at execute time.
 */

import type { BlockHandler, ExecutorActions } from './types';
import { evaluate } from '../evalEngine';
import { buildEvalScope } from './evalScope';
import { blockEventBus } from '../events';
import { blockStore } from '../../hooks/useBlockStore';
import { registry } from './registry';

// ═══════════════════════════════════════════════════════════════
// PREFIX SCANNING
// ═══════════════════════════════════════════════════════════════

const FUNC_PREFIX_RE = /^func::\s*(\S+)/i;

interface BlockLike {
  id: string;
  content?: string;
  childIds?: string[];
}

/**
 * Scan all blocks for `func:: name` content, return Set of defined prefixes.
 * Each prefix includes the `::` suffix (e.g., "issue::").
 */
export function scanFuncPrefixes(blocks: Iterable<{ content?: string }>): Set<string> {
  const prefixes = new Set<string>();
  for (const block of blocks) {
    const match = block.content?.match(FUNC_PREFIX_RE);
    if (match) {
      prefixes.add(match[1].toLowerCase() + '::');
    }
  }
  return prefixes;
}

/**
 * Find the block ID of the `func:: name` definition block.
 */
export function findFuncBlock(
  prefix: string,
  blocks: Iterable<{ id: string; content?: string }>,
): string | null {
  const target = prefix.replace(/::$/, '').toLowerCase();
  for (const block of blocks) {
    const match = block.content?.match(FUNC_PREFIX_RE);
    if (match && match[1].toLowerCase() === target) {
      return block.id;
    }
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════
// FUNC DEFINITION PARSING
// ═══════════════════════════════════════════════════════════════

export interface FuncDef {
  inputs: string[];
  body: string;
}

/**
 * Read input:: and body:: children of a func:: block.
 */
export function parseFuncChildren(
  funcBlockId: string,
  actions: ExecutorActions,
): FuncDef {
  const childIds = actions.getChildren?.(funcBlockId) ?? [];
  let inputs: string[] = [];
  let body = '';

  for (const childId of childIds) {
    const child = actions.getBlock?.(childId) as BlockLike | null;
    if (!child?.content) continue;

    const trimmed = child.content.trim();
    const lower = trimmed.toLowerCase();

    if (lower.startsWith('input::')) {
      const raw = trimmed.slice('input::'.length).trim();
      inputs = raw.split(',').map(s => s.trim()).filter(Boolean);
    } else if (lower.startsWith('body::')) {
      body = trimmed.slice('body::'.length).trim();
    }
  }

  return { inputs, body };
}

/**
 * Parse arguments from invocation content after the prefix.
 * `issue:: FLO-316, FLO-380` → ["FLO-316", "FLO-380"]
 */
export function parseFuncArgs(content: string, prefix: string): string[] {
  const after = content.trim().slice(prefix.length).trim();
  if (!after) return [];
  return after.split(',').map(s => s.trim()).filter(Boolean);
}

// ═══════════════════════════════════════════════════════════════
// FUNC META-HANDLER
// ═══════════════════════════════════════════════════════════════

/**
 * Generic handler returned by findHandler for func-defined prefixes.
 * At execute time, finds the func:: block, reads children, evaluates body.
 */
export const funcMetaHandler: BlockHandler = {
  prefixes: [], // matched via index, not static prefixes

  async execute(blockId: string, content: string, actions: ExecutorActions): Promise<void> {
    if (actions.setBlockStatus) {
      actions.setBlockStatus(blockId, 'running');
    }

    // 1. Extract prefix from content
    const colonIdx = content.indexOf('::');
    if (colonIdx === -1) {
      setError(blockId, 'No prefix found', actions);
      return;
    }
    const prefix = content.slice(0, colonIdx + 2).trim().toLowerCase();

    // 2. Find func:: definition block by scanning all blocks
    const allBlocks = getAllBlocks(actions);
    const funcBlockId = findFuncBlock(prefix, allBlocks);
    if (!funcBlockId) {
      setError(blockId, `No func:: definition found for "${prefix}"`, actions);
      return;
    }

    // 3. Read input::/body:: children
    const def = parseFuncChildren(funcBlockId, actions);
    if (!def.body) {
      setError(blockId, `func:: ${prefix} has no body:: child`, actions);
      return;
    }

    // 4. Parse args from content after prefix
    const args = parseFuncArgs(content, prefix);

    // 5. Build scope: eval scope + input vars bound to args
    const scope = buildEvalScope(blockId, actions);

    // Build body expression that binds input vars then evaluates
    // Single input → receives full args array (e.g., input:: ids → ids = ["a", "b"])
    // Multiple inputs → positional (e.g., input:: a, b → a = "first", b = "second")
    const bindings = def.inputs.length === 1
      ? `const ${def.inputs[0]} = ${JSON.stringify(args)};`
      : def.inputs.map((name, i) => {
          const val = JSON.stringify(args[i] ?? null);
          return `const ${name} = ${val};`;
        }).join(' ');

    const wrappedBody = def.inputs.length > 0
      ? `(() => { ${bindings} return (${def.body}); })()`
      : def.body;

    // 6. Evaluate with full outline scope
    const result = evaluate(wrappedBody, scope);

    // 7. Set output (reuses eval-result type)
    if (actions.setBlockOutput) {
      actions.setBlockOutput(blockId, result, 'eval-result');
    }
    if (actions.setBlockStatus) {
      actions.setBlockStatus(blockId, result.type === 'error' ? 'error' : 'complete');
    }
  },
};

function setError(blockId: string, message: string, actions: ExecutorActions): void {
  if (actions.setBlockOutput) {
    actions.setBlockOutput(blockId, { type: 'error', data: message }, 'eval-result');
  }
  if (actions.setBlockStatus) {
    actions.setBlockStatus(blockId, 'error');
  }
}

// ═══════════════════════════════════════════════════════════════
// FUNC INDEX HOOK (EventBus subscription)
// ═══════════════════════════════════════════════════════════════

let funcIndexSubId: string | null = null;
let rebuildTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Rebuild the func prefix index from the block store.
 * Debounced — called on block create/update/delete events.
 */
function rebuildFuncIndex(): void {
  const blocks = Object.values(blockStore.blocks) as Array<{ content?: string }>;
  const prefixes = scanFuncPrefixes(blocks);
  registry.updateFuncPrefixes(prefixes);
}

/**
 * Register the EventBus subscription that keeps the func prefix index
 * in sync with block changes. Call once during handler registration.
 */
export function registerFuncIndexHook(): void {
  if (funcIndexSubId) return;

  // Initial scan
  rebuildFuncIndex();

  funcIndexSubId = blockEventBus.subscribe(
    (envelope) => {
      // Rebuild on any content change if func:: definitions exist,
      // or if a block matches func::. Handles both new definitions
      // and editing away from func:: content (stale prefix cleanup).
      const hasFuncDefs = registry.getFuncPrefixes().size > 0;
      const relevant = envelope.events.some(e => {
        if (e.type === 'block:delete') return true;
        if (e.type === 'block:create' || e.type === 'block:update') {
          const block = blockStore.getBlock(e.blockId);
          const content = block?.content ?? '';
          return FUNC_PREFIX_RE.test(content) || (e.type === 'block:update' && hasFuncDefs);
        }
        return false;
      });

      if (!relevant) return;

      // Debounce rebuild (500ms — func definitions change rarely)
      if (rebuildTimer) clearTimeout(rebuildTimer);
      rebuildTimer = setTimeout(rebuildFuncIndex, 500);
    },
    {
      priority: 60, // After standard processing
      name: 'func-index',
    }
  );
}

/**
 * Collect all blocks from actions for scanning.
 * Uses rootIds + recursive getChildren to walk the tree.
 */
function getAllBlocks(actions: ExecutorActions): BlockLike[] {
  if (!actions.getBlock || !actions.getChildren || !actions.rootIds) return [];

  const result: BlockLike[] = [];
  const visited = new Set<string>();

  function walk(id: string): void {
    if (visited.has(id)) return;
    visited.add(id);

    const block = actions.getBlock!(id) as BlockLike | null;
    if (!block) return;
    result.push({ ...block, id });

    const childIds = actions.getChildren!(id);
    for (const childId of childIds) {
      walk(childId);
    }
  }

  for (const rootId of actions.rootIds) {
    walk(rootId);
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════
// HMR CLEANUP
// ═══════════════════════════════════════════════════════════════

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    if (funcIndexSubId) {
      blockEventBus.unsubscribe(funcIndexSubId);
      funcIndexSubId = null;
    }
    if (rebuildTimer) {
      clearTimeout(rebuildTimer);
      rebuildTimer = null;
    }
  });
}
