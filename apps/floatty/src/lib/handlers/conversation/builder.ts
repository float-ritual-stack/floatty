/**
 * Conversation Builder
 *
 * Walks the block tree to construct a messages array for LLM API calls.
 */

import type {
  ConversationMessage,
  ConversationConfig,
  ConversationBlock,
  MessageRole,
} from './types';
import {
  inferRole,
  isConversationRoot,
  isConfigBlock,
  isContextDirective,
  stripRolePrefix,
} from './parser';

// ═══════════════════════════════════════════════════════════════
// TREE NAVIGATION
// ═══════════════════════════════════════════════════════════════

/**
 * Find the conversation root by walking up the tree
 * Returns the root block ID or undefined if not in a conversation
 */
export function findConversationRoot(
  blockId: string,
  getBlock: (id: string) => ConversationBlock | undefined,
  getParentId: (id: string) => string | undefined
): string | undefined {
  let currentId: string | undefined = blockId;

  while (currentId) {
    const block = getBlock(currentId);
    if (!block) break;

    if (isConversationRoot(block.content)) {
      return currentId;
    }

    currentId = getParentId(currentId);
  }

  return undefined;
}

/**
 * Get the path from root to target block
 * Returns array of block IDs in order from root to target
 */
export function getPathToBlock(
  rootId: string,
  targetId: string,
  getBlock: (id: string) => ConversationBlock | undefined,
  getParentId: (id: string) => string | undefined
): string[] {
  // Build path from target back to root
  const path: string[] = [];
  let currentId: string | undefined = targetId;

  while (currentId) {
    path.unshift(currentId);
    if (currentId === rootId) break;
    currentId = getParentId(currentId);
  }

  // Verify we reached the root
  if (path[0] !== rootId) {
    return []; // Target is not a descendant of root
  }

  return path;
}

// ═══════════════════════════════════════════════════════════════
// MESSAGE BUILDING
// ═══════════════════════════════════════════════════════════════

/**
 * Build the conversation messages array from the block tree
 *
 * Walks from root to the current block, collecting messages.
 * Skips config blocks and context directives.
 */
export function buildConversation(
  currentBlockId: string,
  getBlock: (id: string) => ConversationBlock | undefined,
  getParentId: (id: string) => string | undefined,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _config: ConversationConfig
): ConversationMessage[] {
  // Find root
  const rootId = findConversationRoot(currentBlockId, getBlock, getParentId);
  if (!rootId) {
    throw new Error('Not in a conversation');
  }

  // Get path from root to current
  const path = getPathToBlock(rootId, currentBlockId, getBlock, getParentId);
  if (path.length === 0) {
    throw new Error('Could not find path to conversation root');
  }

  const messages: ConversationMessage[] = [];
  let previousRole: MessageRole | undefined;

  for (const blockId of path) {
    const block = getBlock(blockId);
    if (!block) continue;

    // Skip config blocks
    if (isConfigBlock(block.content)) continue;

    // Skip context directive blocks
    if (isContextDirective(block.content)) continue;

    // Skip empty blocks (continuation placeholders)
    const trimmed = block.content.trim();
    if (!trimmed) continue;

    const role = inferRole(block.content, previousRole);
    const content = stripRolePrefix(block.content);

    // Don't add empty messages
    if (!content) continue;

    messages.push({
      role,
      content,
      blockId,
    });

    previousRole = role;
  }

  return messages;
}

/**
 * Check if a block is within a conversation tree
 */
export function isInConversation(
  blockId: string,
  getBlock: (id: string) => ConversationBlock | undefined,
  getParentId: (id: string) => string | undefined
): boolean {
  return findConversationRoot(blockId, getBlock, getParentId) !== undefined;
}

/**
 * Get the turn number for a block in a conversation
 * Turn = distance from root in message pairs (user + assistant = 1 turn)
 */
export function getTurnNumber(
  blockId: string,
  getBlock: (id: string) => ConversationBlock | undefined,
  getParentId: (id: string) => string | undefined
): number {
  const rootId = findConversationRoot(blockId, getBlock, getParentId);
  if (!rootId) return 0;

  const path = getPathToBlock(rootId, blockId, getBlock, getParentId);

  // Count message blocks (skip config)
  let messageCount = 0;
  for (const id of path) {
    const block = getBlock(id);
    if (!block) continue;
    if (isConfigBlock(block.content)) continue;
    if (isContextDirective(block.content)) continue;
    if (!block.content.trim()) continue;
    messageCount++;
  }

  // Approximate turn count - assumes ~alternating user/assistant pattern
  // Not exact if consecutive same-role messages exist, but close enough for depth tracking
  return Math.floor(messageCount / 2);
}
