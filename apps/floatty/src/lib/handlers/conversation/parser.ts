/**
 * Conversation Parser
 *
 * Role inference, config parsing, and prefix handling.
 */

import type { MessageRole, ConversationConfig, ConversationBlock } from './types';

// ═══════════════════════════════════════════════════════════════
// ROLE PREFIXES
// ═══════════════════════════════════════════════════════════════

/**
 * Prefixes that explicitly declare a role
 */
const ROLE_PREFIXES: Record<string, MessageRole> = {
  'ai::': 'user', // Conversation root
  'chat::': 'user', // Alias for ai::
  'user::': 'user', // Explicit user message
  'assistant::': 'assistant',
  'system::': 'system',
};

/**
 * Prefixes that indicate a conversation root
 */
export const CONVERSATION_ROOT_PREFIXES = ['ai::', 'chat::'];

/**
 * Prefixes that indicate config blocks (not messages)
 * NOTE: All lowercase - isConfigBlock() lowercases content before checking
 */
const CONFIG_PREFIXES = [
  'model::',
  'maxtokens::',
  'temperature::',
  'expanddepth::',
  'expandhistory::',
  'debugmode::',
  'context::',
];

// ═══════════════════════════════════════════════════════════════
// ROLE INFERENCE
// ═══════════════════════════════════════════════════════════════

/**
 * Infer the role of a message from its content and position
 */
export function inferRole(
  content: string,
  previousRole?: MessageRole
): MessageRole {
  const trimmed = content.trim().toLowerCase();

  // Check explicit prefixes first
  for (const [prefix, role] of Object.entries(ROLE_PREFIXES)) {
    if (trimmed.startsWith(prefix)) {
      return role;
    }
  }

  // Infer from structure: alternate roles
  if (previousRole === 'assistant') return 'user';
  if (previousRole === 'user') return 'assistant';

  // Default to user
  return 'user';
}

/**
 * Check if content starts with a conversation root prefix
 */
export function isConversationRoot(content: string): boolean {
  const trimmed = content.trim().toLowerCase();
  return CONVERSATION_ROOT_PREFIXES.some((p) => trimmed.startsWith(p));
}

/**
 * Check if content is a config block (not a message)
 */
export function isConfigBlock(content: string): boolean {
  const trimmed = content.trim().toLowerCase();
  return CONFIG_PREFIXES.some((p) => trimmed.startsWith(p));
}

/**
 * Check if content is a context directive
 */
export function isContextDirective(content: string): boolean {
  const trimmed = content.trim().toLowerCase();
  return trimmed.startsWith('context::');
}

// ═══════════════════════════════════════════════════════════════
// PREFIX STRIPPING
// ═══════════════════════════════════════════════════════════════

/**
 * Remove role prefix from content to get the actual message
 */
export function stripRolePrefix(content: string): string {
  const trimmed = content.trim();

  // Check all known role prefixes
  for (const prefix of Object.keys(ROLE_PREFIXES)) {
    const lowerTrimmed = trimmed.toLowerCase();
    if (lowerTrimmed.startsWith(prefix)) {
      return trimmed.slice(prefix.length).trim();
    }
  }

  return trimmed;
}

// ═══════════════════════════════════════════════════════════════
// CONFIG PARSING
// ═══════════════════════════════════════════════════════════════

/**
 * Parse configuration from a block's children
 */
export function parseConversationConfig(
  rootBlock: ConversationBlock,
  getBlock: (id: string) => ConversationBlock | undefined
): ConversationConfig {
  const config: ConversationConfig = {};

  for (const childId of rootBlock.childIds) {
    const child = getBlock(childId);
    if (!child) continue;

    const content = child.content.trim();

    // model::value
    const modelMatch = content.match(/^model::(.+)$/i);
    if (modelMatch) {
      config.model = modelMatch[1].trim();
      continue;
    }

    // maxTokens::value
    const tokensMatch = content.match(/^maxTokens::(\d+)$/i);
    if (tokensMatch) {
      config.maxTokens = parseInt(tokensMatch[1], 10);
      continue;
    }

    // temperature::value
    const tempMatch = content.match(/^temperature::([\d.]+)$/i);
    if (tempMatch) {
      config.temperature = parseFloat(tempMatch[1]);
      continue;
    }

    // expandDepth::value
    const depthMatch = content.match(/^expandDepth::(\d+)$/i);
    if (depthMatch) {
      config.expandDepth = parseInt(depthMatch[1], 10);
      continue;
    }

    // expandHistory::value
    const historyMatch = content.match(/^expandHistory::(true|false)$/i);
    if (historyMatch) {
      config.expandHistory = historyMatch[1].toLowerCase() === 'true';
      continue;
    }

    // debugMode::value
    const debugMatch = content.match(/^debugMode::(true|false)$/i);
    if (debugMatch) {
      config.debugMode = debugMatch[1].toLowerCase() === 'true';
      continue;
    }
  }

  return config;
}

/**
 * Extract system prompt from children (system:: block)
 */
export function extractSystemPrompt(
  rootBlock: ConversationBlock,
  getBlock: (id: string) => ConversationBlock | undefined
): string | undefined {
  for (const childId of rootBlock.childIds) {
    const child = getBlock(childId);
    if (!child) continue;

    const content = child.content.trim().toLowerCase();
    if (content.startsWith('system::')) {
      return child.content.trim().slice('system::'.length).trim();
    }
  }
  return undefined;
}
