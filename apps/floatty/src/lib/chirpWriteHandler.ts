/**
 * Chirp write verb handler — shared logic for block mutation verbs emitted
 * from doors (SolidJS inline, full-pane, and artifact iframes).
 *
 * Called from 3 chirp sites:
 *   1. EvalOutput onChirp in BlockItem (artifact:: iframes)
 *   2. DoorHost onChirp in BlockItem (render:: SolidJS doors, inline)
 *   3. DoorPaneView chirp listener (render:: doors, full-pane)
 *
 * Verb map:
 *   create-child  — create a new child of the emitting block (scoped write)
 *   upsert-child  — upsert child of emitting block by prefix (scoped write)
 *   update-block  — update content of any block by id (FLO-587 two-way binding)
 *   move-block    — move any block to target parent + index (FLO-587)
 *
 * create-child/upsert-child are scoped to the emitting block (parent). update-block
 * and move-block accept an explicit blockId in the data payload; they're scoped
 * by the door's own spec (the door only emits ids it put in its projection).
 */

import { createLogger } from './logger';

const logger = createLogger('chirp-write');

export interface ChirpWriteData {
  content?: string;
  match?: string;
  execute?: boolean;
  navigate?: boolean;
  // FLO-587 — update-block / move-block
  blockId?: string;
  targetParentId?: string | null;
  targetIndex?: number;
}

export interface ChirpWriteStore {
  createBlockInside: (parentId: string) => string;
  updateBlockContent: (id: string, content: string) => void;
  upsertChildByPrefix: (parentId: string, prefix: string, content: string) => string | null;
  moveBlock: (blockId: string, targetParentId: string | null, targetIndex: number) => boolean;
}

export interface ChirpWriteResult {
  success: boolean;
  blockId?: string;
}

/**
 * Handle chirp write verbs. Returns result for ack poke-back.
 */
export function handleChirpWrite(
  message: string,
  data: ChirpWriteData | undefined,
  parentBlockId: string,
  store: ChirpWriteStore,
): ChirpWriteResult {
  switch (message) {
    case 'create-child': {
      const content = data?.content;
      if (!content) {
        logger.warn('create-child: missing content');
        return { success: false };
      }
      const newId = store.createBlockInside(parentBlockId);
      if (!newId) {
        logger.warn(`create-child: failed to create block inside ${parentBlockId}`);
        return { success: false };
      }
      store.updateBlockContent(newId, content);
      logger.info('create-child', { parentBlockId, content: content.slice(0, 40), newId });
      return { success: true, blockId: newId };
    }

    case 'upsert-child': {
      const content = data?.content;
      const match = data?.match;
      if (!content || !match) {
        logger.warn('upsert-child: missing content or match');
        return { success: false };
      }
      const resultId = store.upsertChildByPrefix(parentBlockId, match, content);
      if (!resultId) {
        logger.warn('upsert-child: failed', { parentBlockId, match });
        return { success: false };
      }
      logger.info('upsert-child', { parentBlockId, match, resultId });
      return { success: true, blockId: resultId };
    }

    case 'update-block': {
      const blockId = data?.blockId;
      const content = data?.content;
      if (!blockId || content === undefined) {
        logger.warn('update-block: missing blockId or content');
        return { success: false };
      }
      store.updateBlockContent(blockId, content);
      return { success: true, blockId };
    }

    case 'move-block': {
      const blockId = data?.blockId;
      const targetParentId = data?.targetParentId;
      const targetIndex = data?.targetIndex;
      if (!blockId || targetParentId === undefined || typeof targetIndex !== 'number') {
        logger.warn('move-block: missing blockId, targetParentId, or targetIndex');
        return { success: false };
      }
      const ok = store.moveBlock(blockId, targetParentId ?? null, targetIndex);
      if (!ok) {
        logger.warn('move-block: store rejected move', { blockId, targetParentId, targetIndex });
        return { success: false };
      }
      logger.info('move-block', { blockId, targetParentId, targetIndex });
      return { success: true, blockId };
    }

    default:
      return { success: false };
  }
}

/** Check if a chirp message is a write verb handled by this module. */
export function isChirpWriteVerb(message: string): boolean {
  return (
    message === 'create-child' ||
    message === 'upsert-child' ||
    message === 'update-block' ||
    message === 'move-block'
  );
}
