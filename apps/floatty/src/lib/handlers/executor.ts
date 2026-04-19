/**
 * Handler Executor
 *
 * Central execution layer that wraps handler.execute() with hook lifecycle.
 * This is the "nervous system" - all handler execution flows through here.
 *
 * Flow:
 * 1. Build hook context
 * 2. Run execute:before hooks (can abort, modify content, inject context)
 * 3. Execute handler with hook-injected context
 * 4. Run execute:after hooks (can post-process)
 *
 * @see docs/architecture/FLOATTY_HOOK_SYSTEM.md
 */

import type { BlockHandler, ExecutorActions } from './types';
import type { HookBlockStore, HookContext, HookResult } from '../hooks/types';
import { hookRegistry } from '../hooks/hookRegistry';
import { createLogger } from '../logger';

const logger = createLogger('executor');

// ═══════════════════════════════════════════════════════════════
// EXECUTOR
// ═══════════════════════════════════════════════════════════════

/**
 * Execute a handler with full hook lifecycle.
 *
 * All handler execution should go through this function to ensure
 * hooks run consistently across all entry points (keyboard, click, API).
 *
 * @param handler - The handler to execute
 * @param blockId - Block being executed
 * @param content - Block content
 * @param actions - Executor actions for block manipulation
 * @param store - Read-only block store for hook context
 */
export async function executeHandler(
  handler: BlockHandler,
  blockId: string,
  content: string,
  actions: ExecutorActions,
  store: HookBlockStore
): Promise<void> {
  // 1. Get block for context
  const block = store.getBlock(blockId);
  if (!block) {
    logger.warn(`Block not found: ${blockId}`);
    return;
  }

  // 2. Build hook context for execute:before
  const beforeCtx: HookContext = {
    block,
    content,
    event: 'execute:before',
    store,
  };

  // 3. Run execute:before hooks
  let hookResult: HookResult = {};
  try {
    hookResult = await hookRegistry.run('execute:before', beforeCtx);
  } catch (err) {
    logger.error('execute:before hooks failed', { err });
    // Continue with execution even if hooks fail
  }

  // 4. Check for abort
  if (hookResult.abort) {
    logger.info(`Execution aborted by hook: ${hookResult.reason}`);
    if (actions.updateBlockContent) {
      actions.updateBlockContent(blockId, `blocked:: ${hookResult.reason ?? 'Blocked by hook'}`);
    }
    return;
  }

  // 5. Use modified content if hooks changed it
  const finalContent = hookResult.content ?? content;

  // 6. Extend actions with hook context
  const extendedActions: ExecutorActions = {
    ...actions,
    // Pass hook-injected context through to handler
    // Handler can access via: (actions as any).hookContext
  };

  // Type assertion for hook context injection
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (extendedActions as any).hookContext = hookResult.context;

  // 7. Execute the handler
  // Set 'running' status SYNCHRONOUSLY before awaiting the handler. Handlers
  // that set status inside their async execute (e.g. render door) race with
  // SolidJS reconciliation — the DOM can paint once between flush and
  // status-set, showing no indicator on first Enter press. Setting here
  // guarantees the indicator lights up in the same microtask as Enter.
  actions.setBlockStatus?.(blockId, 'running');
  try {
    await handler.execute(blockId, finalContent, extendedActions);
  } catch (err) {
    logger.error('Handler execution failed', { err });

    // 8. Run execute:after with error
    const afterCtx: HookContext = {
      block,
      content: finalContent,
      event: 'execute:after',
      store,
      error: String(err),
    };

    try {
      await hookRegistry.run('execute:after', afterCtx);
    } catch (afterErr) {
      logger.error('execute:after hooks failed', { err: afterErr });
    }

    throw err; // Re-throw to let caller handle
  }

  // 9. Run execute:after hooks (success case)
  const afterCtx: HookContext = {
    block,
    content: finalContent,
    event: 'execute:after',
    store,
  };

  try {
    await hookRegistry.run('execute:after', afterCtx);
  } catch (err) {
    logger.error('execute:after hooks failed', { err });
    // Don't throw - execution already succeeded
  }
}

// ═══════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════

/**
 * Create a HookBlockStore adapter from a block store interface.
 *
 * This bridges the gap between the application's block store
 * and the read-only interface hooks expect.
 *
 * @param zoomedRootId - If set, hooks can scope operations to this subtree
 */
export function createHookBlockStore(
  getBlock: (id: string) => unknown,
  blocks: Record<string, unknown>,
  rootIds: string[],
  zoomedRootId?: string | null
): HookBlockStore {
  return {
    getBlock: getBlock as HookBlockStore['getBlock'],
    blocks: blocks as HookBlockStore['blocks'],
    rootIds,
    zoomedRootId: zoomedRootId ?? undefined,
  };
}
