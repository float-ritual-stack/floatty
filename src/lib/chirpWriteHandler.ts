/**
 * Chirp write verb handler — shared logic for create-child and upsert-child.
 *
 * Called from 3 chirp sites:
 *   1. EvalOutput onChirp in BlockItem (artifact:: iframes)
 *   2. DoorHost onChirp in BlockItem (render:: SolidJS doors, inline)
 *   3. DoorPaneView chirp listener (render:: doors, full-pane)
 *
 * Parent is always the emitting block (scoped writes).
 */

import { createLogger } from './logger';

const logger = createLogger('chirp-write');

export interface ChirpWriteData {
  content?: string;
  match?: string;
  execute?: boolean;
  navigate?: boolean;
}

export interface ChirpWriteStore {
  createBlockInside: (parentId: string) => string;
  updateBlockContent: (id: string, content: string) => void;
  upsertChildByPrefix: (parentId: string, prefix: string, content: string) => string | null;
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

    default:
      return { success: false };
  }
}

/** Check if a chirp message is a write verb handled by this module. */
export function isChirpWriteVerb(message: string): boolean {
  return message === 'create-child' || message === 'upsert-child';
}
