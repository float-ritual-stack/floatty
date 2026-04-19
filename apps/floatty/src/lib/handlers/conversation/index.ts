/**
 * Conversation Handler
 *
 * Multi-turn LLM conversation handler for ai:: blocks.
 * Builds conversation from tree structure (nested blocks = turns).
 */

import { invoke } from '@tauri-apps/api/core';
import type { BlockHandler, ExecutorActions } from '../types';
import type {
  ConversationBlock,
  ConversationConfig,
} from './types';
import { buildConversation, findConversationRoot } from './builder';
import {
  parseConversationConfig,
  extractSystemPrompt,
  CONVERSATION_ROOT_PREFIXES,
} from './parser';
import { extractContent } from '../utils';
import { createLogger } from '../../logger';

const logger = createLogger('conversation');

// ═══════════════════════════════════════════════════════════════
// HANDLER
// ═══════════════════════════════════════════════════════════════

/**
 * Conversation handler for multi-turn LLM interactions
 */
export const conversationHandler: BlockHandler = {
  prefixes: ['ai::', 'chat::'],

  async execute(
    blockId: string,
    content: string,
    actions: ExecutorActions
  ): Promise<void> {
    // Get tree navigation functions from actions
    const extActions = actions as unknown as {
      getBlock?: (id: string) => ConversationBlock | undefined;
      getParentId?: (id: string) => string | undefined;
      getChildren?: (id: string) => string[];
    };

    const { getBlock, getParentId, getChildren } = extActions;

    // If we don't have tree navigation, fall back to single-turn
    if (!getBlock || !getParentId || !getChildren) {
      logger.warn('Missing tree navigation, falling back to single-turn');
      return executeSingleTurn(blockId, content, actions);
    }

    // Check if this is a new conversation root (fresh ai:: block)
    const currentBlock = getBlock(blockId);
    const isRoot =
      currentBlock &&
      CONVERSATION_ROOT_PREFIXES.some((p) =>
        currentBlock.content.trim().toLowerCase().startsWith(p)
      );

    // If this is the root with no children yet, treat as single turn initially
    // (the response will become a child, enabling multi-turn)
    if (isRoot && currentBlock.childIds.length === 0) {
      return executeConversationTurn(
        blockId,
        content,
        actions,
        getBlock,
        getParentId,
        getChildren!
      );
    }

    // Check if we're inside a conversation tree
    const rootId = findConversationRoot(blockId, getBlock, getParentId);

    if (!rootId) {
      // Not in a conversation, fall back to single-turn
      return executeSingleTurn(blockId, content, actions);
    }

    // Execute as part of conversation
    return executeConversationTurn(
      blockId,
      content,
      actions,
      getBlock,
      getParentId,
      getChildren!
    );
  },
};

// ═══════════════════════════════════════════════════════════════
// CONVERSATION EXECUTION
// ═══════════════════════════════════════════════════════════════

async function executeConversationTurn(
  blockId: string,
  content: string,
  actions: ExecutorActions,
  getBlock: (id: string) => ConversationBlock | undefined,
  getParentId: (id: string) => string | undefined,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _getChildren: (id: string) => string[]
): Promise<void> {
  const startTime = performance.now();

  // Find conversation root
  const rootId = findConversationRoot(blockId, getBlock, getParentId);
  const rootBlock = rootId ? getBlock(rootId) : undefined;

  // Parse config from root
  const config: ConversationConfig = rootBlock
    ? parseConversationConfig(rootBlock, getBlock)
    : {};

  // Get system prompt if defined
  const systemPrompt = rootBlock
    ? extractSystemPrompt(rootBlock, getBlock)
    : undefined;

  // Build messages array
  let messages;
  try {
    messages = buildConversation(blockId, getBlock, getParentId, config);
  } catch (err) {
    logger.error('Failed to build conversation', { err });
    return executeSingleTurn(blockId, content, actions);
  }

  // If no messages, fall back to single turn
  if (messages.length === 0) {
    return executeSingleTurn(blockId, content, actions);
  }

  logger.debug('Built messages', {
    count: messages.length,
    model: config.model,
    hasSystem: !!systemPrompt,
  });

  // Create response placeholder
  const responseId =
    actions.createBlockInsideAtTop?.(blockId) ?? actions.createBlockInside(blockId);
  actions.updateBlockContent(responseId, 'assistant:: Thinking...');
  actions.setBlockStatus?.(responseId, 'running');

  // Create the continuation block + focus it BEFORE awaiting the LLM.
  // Matches send.ts ordering: the user keeps typing while the model
  // responds. Without this, focus only moves once the response lands,
  // which defeats the "type while it thinks" UX.
  const nextId = actions.createBlockInside(responseId);
  actions.updateBlockContent(nextId, '');
  if (actions.focusBlock) {
    requestAnimationFrame(() => actions.focusBlock!(nextId));
  }

  try {
    // Call backend - use camelCase params as Tauri auto-converts to snake_case
    const response = await invoke<string>('execute_ai_conversation', {
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      model: config.model,
      maxTokens: config.maxTokens,
      temperature: config.temperature,
      system: systemPrompt,
    });

    const duration = performance.now() - startTime;
    logger.info('Complete', {
      duration: `${duration.toFixed(1)}ms`,
      responseLength: response.length,
    });

    // Update response block. Use updateBlockContentFromExecutor when
    // available so the write lands even if the user has since focused
    // responseId (e.g. clicked up into it).
    const updateResponse =
      actions.updateBlockContentFromExecutor ?? actions.updateBlockContent;
    updateResponse(responseId, `assistant:: ${response.trim()}`);
    actions.setBlockStatus?.(responseId, 'complete');
  } catch (err) {
    logger.error('Error', { err });
    actions.updateBlockContent(responseId, `error:: ${String(err)}`);
    actions.setBlockStatus?.(responseId, 'error');

    // Clean up the pre-created empty continuation block on error — keeps
    // the tree tidy. If the user has already typed into nextId between
    // focus and the error, preserve their content.
    if (actions.deleteBlock) {
      const nextBlock = actions.getBlock?.(nextId) as { content?: string } | undefined;
      if (!nextBlock?.content) {
        actions.deleteBlock(nextId);
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// SINGLE-TURN FALLBACK
// ═══════════════════════════════════════════════════════════════

/**
 * Fallback to single-turn execution (original ai:: behavior)
 * Used when tree navigation is unavailable or block is standalone
 */
async function executeSingleTurn(
  blockId: string,
  content: string,
  actions: ExecutorActions
): Promise<void> {
  const startTime = performance.now();
  const prompt = extractContent(content, ['ai::', 'chat::']);

  // Create response placeholder
  const responseId =
    actions.createBlockInsideAtTop?.(blockId) ?? actions.createBlockInside(blockId);
  actions.updateBlockContent(responseId, 'assistant:: Thinking...');
  actions.setBlockStatus?.(responseId, 'running');

  // Create the continuation block + focus it BEFORE awaiting the LLM.
  // See executeConversationTurn for the full explanation.
  const nextId = actions.createBlockInside(responseId);
  actions.updateBlockContent(nextId, '');
  if (actions.focusBlock) {
    requestAnimationFrame(() => actions.focusBlock!(nextId));
  }

  try {
    // Call original single-turn command
    const response = await invoke<string>('execute_ai_command', {
      prompt,
    });

    const duration = performance.now() - startTime;
    logger.info('Single-turn complete', {
      duration: `${duration.toFixed(1)}ms`,
      responseLength: response.length,
    });

    // Update response block — see executeConversationTurn note.
    const updateResponse =
      actions.updateBlockContentFromExecutor ?? actions.updateBlockContent;
    updateResponse(responseId, `assistant:: ${response.trim()}`);
    actions.setBlockStatus?.(responseId, 'complete');
  } catch (err) {
    logger.error('Single-turn error', { err });
    actions.updateBlockContent(responseId, `error:: ${String(err)}`);
    actions.setBlockStatus?.(responseId, 'error');

    if (actions.deleteBlock) {
      const nextBlock = actions.getBlock?.(nextId) as { content?: string } | undefined;
      if (!nextBlock?.content) {
        actions.deleteBlock(nextId);
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════

export { buildConversation, findConversationRoot } from './builder';
export {
  inferRole,
  isConversationRoot,
  parseConversationConfig,
  stripRolePrefix,
} from './parser';
export type {
  ConversationMessage,
  ConversationConfig,
  ConversationBlock,
  MessageRole,
} from './types';
