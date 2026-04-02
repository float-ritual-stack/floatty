/**
 * useExecutionAction - Block handler execution (sh::, ai::, daily::, etc.)
 *
 * Handles: execute_block
 */

import { createLogger } from '../../lib/logger';
import { registry, executeHandler, createHookBlockStore } from '../../lib/handlers';

const logger = createLogger('useExecutionAction');
import type { BlockStoreInterface, PaneStoreInterface } from '../../context/WorkspaceContext';
import type { Block } from '../../lib/blockTypes';

export interface ExecutionActionDeps {
  getBlockId: () => string;
  paneId: string;
  paneStore: Pick<PaneStoreInterface, 'getZoomedRootId'>;
  blockStore: BlockStoreInterface;
  getBlock: () => Block | undefined;
  onFocus: (id: string) => void;
  flushContentUpdate: () => void;
}

export function useExecutionAction(deps: ExecutionActionDeps) {
  const handle = (e: KeyboardEvent): void => {
    const block = deps.getBlock();
    if (!block) return;

    e.preventDefault();
    // Flush pending content before execute (debounced updates can race with store operations)
    deps.flushContentUpdate();

    const handler = registry.findHandler(block.content);
    if (!handler) return;

    // Create hook-compatible block store adapter (with zoom scope)
    const hookStore = createHookBlockStore(
      deps.blockStore.getBlock,
      deps.blockStore.blocks,
      deps.blockStore.rootIds,
      deps.paneStore.getZoomedRootId(deps.paneId)
    );

    // Execute through hook-aware executor
    executeHandler(handler, deps.getBlockId(), block.content, {
      createBlockInside: deps.blockStore.createBlockInside,
      createBlockInsideAtTop: deps.blockStore.createBlockInsideAtTop,
      createBlockAfter: deps.blockStore.createBlockAfter,
      updateBlockContent: deps.blockStore.updateBlockContent,
      updateBlockContentFromExecutor: deps.blockStore.updateBlockContentFromExecutor,
      deleteBlock: deps.blockStore.deleteBlock,
      setBlockOutput: deps.blockStore.setBlockOutput,
      setBlockStatus: deps.blockStore.setBlockStatus,
      getBlock: deps.blockStore.getBlock,
      getParentId: (id) => deps.blockStore.getBlock(id)?.parentId ?? undefined,
      getChildren: (id) => deps.blockStore.getBlock(id)?.childIds ?? [],
      rootIds: deps.blockStore.rootIds,
      paneId: deps.paneId,
      focusBlock: deps.onFocus,
      // FLO-322: Batch block creation for bulk output
      batchCreateBlocksAfter: deps.blockStore.batchCreateBlocksAfter,
      batchCreateBlocksInside: deps.blockStore.batchCreateBlocksInside,
      batchCreateBlocksInsideAtTop: deps.blockStore.batchCreateBlocksInsideAtTop,
      moveBlock: (blockId, targetParentId, targetIndex) =>
        deps.blockStore.moveBlock(blockId, targetParentId, targetIndex, { origin: 'user' }),
    }, hookStore).catch(err => {
      logger.error('Handler execution failed', { err });
    });
  };

  return { handle };
}
