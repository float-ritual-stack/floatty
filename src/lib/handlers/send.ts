/**
 * Send Handler
 *
 * Explicit turn-based conversation trigger.
 * Pattern:
 *   ## user
 *   - thought 1
 *   - thought 2
 *
 *   /send
 *   → creates ## assistant block with response
 */

import { invoke } from '@tauri-apps/api/core';
import type { BlockHandler, ExecutorActions } from './types';
import type { Block } from '../blockTypes';

// ═══════════════════════════════════════════════════════════════
// TURN MARKERS
// ═══════════════════════════════════════════════════════════════

const USER_MARKER = '## user';
const ASSISTANT_MARKER = '## assistant';

function isUserMarker(content: string): boolean {
  return content.trim().toLowerCase().startsWith(USER_MARKER.toLowerCase());
}

function isAssistantMarker(content: string): boolean {
  return content.trim().toLowerCase().startsWith(ASSISTANT_MARKER.toLowerCase());
}

// ═══════════════════════════════════════════════════════════════
// DOCUMENT ORDER WALK
// ═══════════════════════════════════════════════════════════════

/**
 * Walk all blocks in document order (depth-first pre-order)
 * Returns array of block IDs in reading order
 */
function getBlocksInDocumentOrder(
  rootIds: string[],
  getBlock: (id: string) => Block | undefined
): string[] {
  const result: string[] = [];

  function walk(blockId: string) {
    result.push(blockId);
    const block = getBlock(blockId);
    if (block?.childIds) {
      for (const childId of block.childIds) {
        walk(childId);
      }
    }
  }

  for (const rootId of rootIds) {
    walk(rootId);
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════
// CONTEXT COLLECTION
// ═══════════════════════════════════════════════════════════════

interface TurnContext {
  /** Collected context text */
  text: string;
  /** Number of blocks included */
  blockCount: number;
}

/**
 * Collect context from the current user turn
 *
 * Walks blocks in document order, finds:
 * - Last ## user marker before sendBlockId
 * - All content between that marker and sendBlockId
 *
 * Ignores nesting. Just flat document order.
 */
export function collectTurnContext(
  sendBlockId: string,
  rootIds: string[],
  getBlock: (id: string) => Block | undefined
): TurnContext {
  const allBlocks = getBlocksInDocumentOrder(rootIds, getBlock);
  const sendIndex = allBlocks.indexOf(sendBlockId);

  if (sendIndex === -1) {
    return { text: '', blockCount: 0 };
  }

  // Find last ## user marker before sendBlockId
  let lastUserIndex = -1;
  let hitAssistant = false;
  for (let i = sendIndex - 1; i >= 0; i--) {
    const block = getBlock(allBlocks[i]);
    if (!block) continue;

    if (isUserMarker(block.content)) {
      lastUserIndex = i;
      break;
    }

    // Stop if we hit an ## assistant marker (previous turn)
    if (isAssistantMarker(block.content)) {
      hitAssistant = true;
      break;
    }
  }

  // No ## user marker found - implicit first turn
  // Collect from start unless we hit an ## assistant (which means orphaned /send)
  if (lastUserIndex === -1) {
    if (hitAssistant) {
      // /send after ## assistant with no ## user between - that's an error
      return { text: '', blockCount: 0 };
    }
    // Implicit first turn: everything from start to /send
    lastUserIndex = 0;
  }

  // Collect all content between ## user and /send
  const parts: string[] = [];
  let blockCount = 0;

  for (let i = lastUserIndex; i < sendIndex; i++) {
    const blockId = allBlocks[i];
    const block = getBlock(blockId);
    if (!block) continue;

    const content = block.content.trim();
    if (!content) continue;

    // Skip the ## user marker itself (or include as context?)
    // Including it for now - user can see their own header
    parts.push(content);
    blockCount++;
  }

  return {
    text: parts.join('\n'),
    blockCount,
  };
}

// ═══════════════════════════════════════════════════════════════
// HANDLER
// ═══════════════════════════════════════════════════════════════

/**
 * Send handler - explicit conversation trigger
 */
export const sendHandler: BlockHandler = {
  prefixes: ['/send', '::send'],

  async execute(
    blockId: string,
    _content: string,
    actions: ExecutorActions
  ): Promise<void> {
    const startTime = performance.now();

    // Get store access from extended actions
    const extActions = actions as unknown as {
      getBlock?: (id: string) => Block | undefined;
      rootIds?: string[];
    };

    const { getBlock } = extActions;

    // Need store access for context collection
    if (!getBlock) {
      console.error('[send] Missing getBlock - cannot collect context');
      actions.updateBlockContent(blockId, 'error:: Missing store access');
      return;
    }

    // Get rootIds from actions or infer from block tree
    // For now, we'll need rootIds passed in
    const rootIds = extActions.rootIds ?? [];
    if (rootIds.length === 0) {
      console.warn('[send] No rootIds available, collecting context may be limited');
    }

    // Collect turn context
    const context = collectTurnContext(blockId, rootIds, getBlock);

    if (!context.text) {
      actions.updateBlockContent(blockId, 'error:: No ## user turn found above');
      return;
    }

    console.log('[send] Collected context:', {
      blockCount: context.blockCount,
      textLength: context.text.length,
    });

    // Replace /send block with ## assistant marker
    // Use executor origin so UI updates even while block is focused
    const updateContent = actions.updateBlockContentFromExecutor ?? actions.updateBlockContent;
    updateContent(blockId, ASSISTANT_MARKER);
    actions.setBlockStatus?.(blockId, 'running');

    // Create response placeholder as child
    const responseId = actions.createBlockInside(blockId);
    updateContent(responseId, 'Thinking...');

    // Create ## user block IMMEDIATELY so user can start typing while waiting
    // This is the key UX insight: don't make user wait for LLM to start next thought
    let userInputId: string | null = null;
    if (actions.createBlockAfter) {
      const nextUserId = actions.createBlockAfter(blockId);
      if (nextUserId) {
        updateContent(nextUserId, USER_MARKER);
        userInputId = actions.createBlockInside(nextUserId);
        actions.updateBlockContent(userInputId, '');
        // Focus immediately - user can type while LLM is thinking
        if (actions.focusBlock) {
          requestAnimationFrame(() => actions.focusBlock!(userInputId!));
        }
      }
    }

    try {
      // Call LLM with conversation API for better results
      const messages = [{ role: 'user', content: context.text }];
      const response = await invoke<string>('execute_ai_conversation', {
        messages,
        system: 'You are a helpful assistant responding to notes and thoughts in an outliner. Be concise and direct. Focus on what the user is asking about.',
      });

      const duration = performance.now() - startTime;
      console.log('[send] Complete:', {
        duration: `${duration.toFixed(1)}ms`,
        responseLength: response.length,
      });

      // Update response
      actions.updateBlockContent(responseId, response.trim());
      actions.setBlockStatus?.(blockId, 'complete');
    } catch (err) {
      console.error('[send] Error:', err);
      actions.updateBlockContent(responseId, `Error: ${String(err)}`);
      actions.setBlockStatus?.(blockId, 'error');
    }
  },
};
