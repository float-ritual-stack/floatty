/**
 * Send Context Assembly Hook
 *
 * This hook runs before /send handler executes.
 * It assembles the conversation context from the block tree
 * and makes it available via hookContext.messages.
 *
 * SIMPLE MODEL:
 * - Scan document order (depth-first)
 * - Find ## user / ## assistant markers
 * - Collect content between markers
 * - Indentation doesn't matter
 *
 * ZOOM SCOPING:
 * - When zoomedRootId is set, only scan within that subtree
 * - "Zooming into a thing is a way to manage context"
 * - Allows isolating conversations within larger documents
 */

import type { Hook, HookContext, HookResult } from '../../hooks/types';
import type { Block } from '../../blockTypes';

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
// DOCUMENT ORDER
// ═══════════════════════════════════════════════════════════════

/**
 * Get all blocks in document order (depth-first)
 * Indentation doesn't matter - just the order you'd read them top to bottom
 *
 * @param startIds - Either rootIds (full document) or [zoomedRootId] (scoped)
 * @param getBlock - Block lookup function
 */
function getBlocksInDocumentOrder(
  startIds: string[],
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

  for (const startId of startIds) {
    walk(startId);
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════
// HOOK
// ═══════════════════════════════════════════════════════════════

export const sendContextHook: Hook = {
  id: 'send-context-assembly',
  event: 'execute:before',
  priority: 0,

  filter: (block) => {
    const content = block.content.trim().toLowerCase();
    return content.startsWith('/send') || content.startsWith('::send');
  },

  handler: (ctx: HookContext): HookResult => {
    const { block, store } = ctx;

    // Determine context scope: zoomed subtree or full document
    // "Zooming into a thing is a way to manage context"
    const startIds = store.zoomedRootId
      ? [store.zoomedRootId]  // Scoped to zoomed subtree
      : store.rootIds;        // Full document

    // Get all blocks in document order within scope
    const allBlockIds = getBlocksInDocumentOrder(startIds, store.getBlock);
    const sendIndex = allBlockIds.indexOf(block.id);

    if (sendIndex === -1) {
      return { abort: true, reason: 'Block not found in tree' };
    }

    // Scan all blocks before /send, find markers and content
    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    let currentRole: 'user' | 'assistant' = 'user'; // Default to user (preamble)
    let currentContent: string[] = [];

    for (let i = 0; i < sendIndex; i++) {
      const b = store.getBlock(allBlockIds[i]);
      if (!b) continue;

      const text = b.content.trim();
      if (!text) continue;

      if (isUserMarker(text)) {
        // Flush previous content if any
        if (currentContent.length > 0) {
          messages.push({ role: currentRole, content: currentContent.join('\n') });
          currentContent = [];
        }
        currentRole = 'user';
      } else if (isAssistantMarker(text)) {
        // Flush previous content if any
        if (currentContent.length > 0) {
          messages.push({ role: currentRole, content: currentContent.join('\n') });
          currentContent = [];
        }
        currentRole = 'assistant';
      } else {
        // Regular content - accumulate under current role
        currentContent.push(text);
      }
    }

    // Flush final content
    if (currentContent.length > 0) {
      messages.push({ role: currentRole, content: currentContent.join('\n') });
    }

    if (messages.length === 0) {
      return { abort: true, reason: 'No content to send' };
    }

    // Ensure last message is from user
    const lastMessage = messages[messages.length - 1];
    if (lastMessage.role !== 'user') {
      return { abort: true, reason: 'No user content to send' };
    }

    console.log('[sendContextHook] Built conversation:', {
      turns: messages.length,
      scoped: store.zoomedRootId ? `zoomed:${store.zoomedRootId}` : 'full-doc',
      preview: messages.map(m => `${m.role}: ${m.content.slice(0, 30)}...`),
    });

    return {
      context: {
        messages,
        blockCount: messages.reduce((n, m) => n + m.content.split('\n').length, 0),
      },
    };
  },
};
