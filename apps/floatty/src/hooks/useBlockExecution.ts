/**
 * useBlockExecution — programmatic block-execution dispatch.
 *
 * The Enter-key path in useBlockInput's `execute_block` case calls
 * `executeHandler(handler, blockId, content, actions, hookStore)`. That same
 * dispatch needs to fire from non-keyboard sources too — most importantly
 * from chirp `create-child` / `upsert-child` so agent-created handler-prefixed
 * blocks (e.g. `render:: { json }`) auto-execute the same way user-typed
 * blocks do, instead of sitting as raw text until the user opens them and
 * presses Enter.
 *
 * This hook factors out the wiring (executor actions + hookBlockStore +
 * paneId scoping) so a single `executeBlock(blockId)` callable surfaces.
 *
 * Intentionally narrower than the Enter-key path: no flushContentUpdate
 * (caller already wrote content via store.updateBlockContent before calling),
 * no advanceCursorOnExecute (focus stays where the chirp emitted from). If
 * a future caller needs those, accept them as opts rather than forking.
 *
 * Usage (BlockOutputView, DoorPaneView):
 *   const { executeBlock } = useBlockExecution(() => props.paneId);
 *   // pass into chirpWriteHandler via store.executeBlockIfHandler
 */
import { useWorkspace } from '../context/WorkspaceContext';
import {
  registry,
  executeHandler,
  createHookBlockStore,
} from '../lib/handlers';
import { createLogger } from '../lib/logger';

const logger = createLogger('useBlockExecution');

export interface BlockExecutionApi {
  /**
   * Execute the handler matching this block's content prefix, if any.
   * No-op when:
   *   - block doesn't exist
   *   - content has no matching handler in the registry
   *   - block is currently executing (dedup via outputStatus 'running')
   *
   * Errors during execution are logged; the promise never rejects.
   */
  executeBlock: (blockId: string) => void;
}

export function useBlockExecution(getPaneId: () => string): BlockExecutionApi {
  const { blockStore, paneStore } = useWorkspace();
  const store = blockStore;

  const executeBlock = (blockId: string): void => {
    const block = store.getBlock(blockId);
    if (!block) {
      logger.debug('executeBlock: block not found', { blockId });
      return;
    }
    const content = block.content ?? '';
    const handler = registry.findHandler(content);
    if (!handler) {
      // Not a handler-prefixed block — nothing to do. Silent no-op so this
      // is safe to call on every newly-created block.
      return;
    }

    // Dedup: don't re-trigger a block that's already executing. The
    // outputStatus transition is set inside executeHandler; we read the
    // pre-trigger value here.
    if (block.outputStatus === 'running') {
      logger.debug('executeBlock: already running, skipping', { blockId });
      return;
    }

    const paneId = getPaneId();
    const hookStore = createHookBlockStore(
      store.getBlock,
      store.blocks,
      store.rootIds,
      paneStore.getZoomedRootId(paneId),
    );

    logger.info('executeBlock: dispatching', {
      blockId,
      paneId,
      contentPrefix: content.slice(0, 32),
      handler: handler.prefixes,
    });

    executeHandler(
      handler,
      blockId,
      content,
      {
        createBlockInside: store.createBlockInside,
        createBlockInsideAtTop: store.createBlockInsideAtTop,
        createBlockAfter: store.createBlockAfter,
        updateBlockContent: store.updateBlockContent,
        updateBlockContentFromExecutor: store.updateBlockContentFromExecutor,
        deleteBlock: store.deleteBlock,
        setBlockOutput: store.setBlockOutput,
        setBlockStatus: store.setBlockStatus,
        getBlock: store.getBlock,
        getParentId: (id) => store.getBlock(id)?.parentId ?? undefined,
        getChildren: (id) => store.getBlock(id)?.childIds ?? [],
        rootIds: store.rootIds,
        paneId,
        // No focusBlock here: programmatic execution should not steal focus.
        batchCreateBlocksAfter: store.batchCreateBlocksAfter,
        batchCreateBlocksInside: store.batchCreateBlocksInside,
        batchCreateBlocksInsideAtTop: store.batchCreateBlocksInsideAtTop,
        moveBlock: (blockId, targetParentId, targetIndex) =>
          store.moveBlock(blockId, targetParentId, targetIndex, { origin: 'user' }),
      },
      hookStore,
    ).catch((err) => {
      logger.error('Programmatic handler execution failed', { blockId, err });
    });
  };

  return { executeBlock };
}
