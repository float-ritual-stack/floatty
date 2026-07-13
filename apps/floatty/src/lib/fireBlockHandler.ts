/**
 * Execute a block's handler from OUTSIDE the keyboard path.
 *
 * Enter-on-a-command-block runs through `useBlockInput`'s `execute_block`
 * action, which builds its executor actions from the pane it is focused in.
 * Callers that have no keyboard event — the `floatty://…/execute` deep-link
 * verb, the FILES sidebar's insert-and-run — need the same execution with a
 * pane-less adapter. This is that adapter, in one place, so the two callers
 * cannot drift.
 *
 * `paneId: ''` and a no-op `focusBlock` are deliberate: a handler invoked
 * this way renders its output into the block, and focus is the caller's
 * business (the sidebar has already put the cursor where it wants it).
 */
import { registry, executeHandler, createHookBlockStore } from './handlers';
import type { ExecutorActions } from './handlers/types';
import { blockStore } from '../hooks/useBlockStore';
import { createLogger } from './logger';

const logger = createLogger('fireBlockHandler');

function buildExecutorActions(): ExecutorActions {
  return {
    createBlockInside: blockStore.createBlockInside,
    createBlockInsideAtTop: blockStore.createBlockInsideAtTop,
    createBlockAfter: blockStore.createBlockAfter,
    updateBlockContent: blockStore.updateBlockContent,
    updateBlockContentFromExecutor: blockStore.updateBlockContentFromExecutor,
    deleteBlock: blockStore.deleteBlock,
    setBlockOutput: blockStore.setBlockOutput,
    setBlockStatus: blockStore.setBlockStatus,
    getBlock: blockStore.getBlock,
    getParentId: (id) => blockStore.getBlock(id)?.parentId ?? undefined,
    getChildren: (id) => blockStore.getBlock(id)?.childIds ?? [],
    rootIds: blockStore.rootIds,
    paneId: '',
    focusBlock: () => {},
    batchCreateBlocksAfter: blockStore.batchCreateBlocksAfter,
    batchCreateBlocksInside: blockStore.batchCreateBlocksInside,
    batchCreateBlocksInsideAtTop: blockStore.batchCreateBlocksInsideAtTop,
    moveBlock: (blockId, targetParentId, targetIndex) =>
      blockStore.moveBlock(blockId, targetParentId, targetIndex, { origin: 'system' }),
  };
}

/**
 * Run the handler registered for `content`, if any.
 *
 * Returns true when a handler was found and dispatched (the run itself is
 * async and reports failure by marking the block `error`), false when the
 * content has no registered prefix — a plain-text block is not a failure.
 */
export function fireBlockHandler(blockId: string, content: string): boolean {
  const handler = registry.findHandler(content);
  if (!handler) return false;

  const hookStore = createHookBlockStore(
    blockStore.getBlock,
    blockStore.blocks,
    blockStore.rootIds,
    null
  );

  executeHandler(handler, blockId, content, buildExecutorActions(), hookStore).catch((err) => {
    logger.error(`handler failed for ${blockId}: ${err}`);
    blockStore.setBlockStatus(blockId, 'error');
  });

  return true;
}
