/**
 * Conversation Handler Types
 *
 * Types for multi-turn LLM conversations in the outliner.
 */

import type { ExecutorActions } from '../types';

// ═══════════════════════════════════════════════════════════════
// MESSAGE TYPES
// ═══════════════════════════════════════════════════════════════

export type MessageRole = 'user' | 'assistant' | 'system';

/**
 * A single message in a conversation
 */
export interface ConversationMessage {
  role: MessageRole;
  content: string;
  blockId: string; // For debugging/reference
}

// ═══════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════

/**
 * Per-conversation configuration parsed from inline blocks
 */
export interface ConversationConfig {
  /** Model name (e.g., 'llama3', 'sonnet', 'opus') */
  model?: string;
  /** Maximum tokens for response */
  maxTokens?: number;
  /** Temperature for generation */
  temperature?: number;
  /** Wikilink expansion depth */
  expandDepth?: number;
  /** Expand links in history too */
  expandHistory?: boolean;
  /** Show debug output */
  debugMode?: boolean;
}

// ═══════════════════════════════════════════════════════════════
// EXTENDED ACTIONS
// ═══════════════════════════════════════════════════════════════

/**
 * Extended actions for conversation handling
 * Adds tree navigation capabilities
 */
export interface ConversationActions extends ExecutorActions {
  /** Get parent block ID */
  getParentId: (id: string) => string | undefined;
  /** Get child block IDs */
  getChildren: (id: string) => string[];
}

// ═══════════════════════════════════════════════════════════════
// BLOCK REPRESENTATION
// ═══════════════════════════════════════════════════════════════

/**
 * Minimal block representation for conversation building
 */
export interface ConversationBlock {
  id: string;
  content: string;
  childIds: string[];
}

// ═══════════════════════════════════════════════════════════════
// API REQUEST/RESPONSE
// ═══════════════════════════════════════════════════════════════

/**
 * Request payload for the backend conversation command
 */
export interface ConversationRequest {
  messages: Array<{ role: string; content: string }>;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  system?: string;
}
