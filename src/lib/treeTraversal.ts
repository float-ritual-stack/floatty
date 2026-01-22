/**
 * Tree Traversal Utilities
 *
 * Generic utilities for walking the block tree to find inherited values.
 * Used by providerDetectionHook and /context handler.
 *
 * @see FLO-187 Provider-Aware Dispatch System
 */

import type { Block } from './blockTypes';

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

/**
 * Minimal store interface for tree traversal.
 * Works with HookBlockStore and other store implementations.
 */
export interface TraversalStore {
  getBlock: (id: string) => Block | undefined;
  rootIds: string[];
}

/**
 * Provider configuration parsed from ai::* blocks.
 *
 * Config-driven: Rust looks up provider by name in config.toml.
 *
 * Examples:
 * - "ai::" → { name: 'ollama' } (default)
 * - "ai::ollama qwen2.5:7b" → { name: 'ollama', model: 'qwen2.5:7b' }
 * - "ai::kitty float-hub" → { name: 'kitty', workingDir: 'float-hub' }
 * - "ai::gemini" → { name: 'gemini' }
 */
export interface ProviderConfig {
  /** Provider name (looked up in config.toml [providers.*]) */
  name: string;
  /** Block ID where provider was defined */
  blockId: string;
  /** Working directory override (from ai::kitty float-hub) */
  workingDir?: string;
  /** Session ID for resuming conversations */
  sessionId?: string;
  /** Model override */
  model?: string;
}

/**
 * Full inherited context visible to user via /context command.
 * Aggregates all inherited values from ancestor blocks.
 */
export interface InheritedContext {
  /** Provider configuration from ai::* ancestor */
  provider?: ProviderConfig;
  /** Model override from model:: child of provider */
  model?: string;
  /** Session ID from session: child of provider */
  sessionId?: string;
  /** Active zoom scope */
  zoomedRootId?: string;
  /** Ancestors with their content (for debugging) */
  ancestors: Array<{ id: string; content: string }>;
}

// ═══════════════════════════════════════════════════════════════
// PROVIDER PARSING
// ═══════════════════════════════════════════════════════════════

/**
 * Parse a provider configuration from block content.
 *
 * Config-driven: Just extracts provider name and arg, Rust does config lookup.
 *
 * Pattern: "ai::{provider} {arg}"
 *
 * @example
 * parseProviderConfig("ai::") → { name: 'ollama' }
 * parseProviderConfig("ai::kitty float-hub") → { name: 'kitty', workingDir: 'float-hub' }
 * parseProviderConfig("ai::ollama qwen2.5:7b") → { name: 'ollama', model: 'qwen2.5:7b' }
 * parseProviderConfig("ai::gemini") → { name: 'gemini' }
 */
export function parseProviderConfig(content: string, blockId: string): ProviderConfig | null {
  const trimmed = content.trim().toLowerCase();

  // Must start with ai:: prefix
  if (!trimmed.startsWith('ai::')) {
    return null;
  }

  // Get rest after "ai::"
  const rest = content.trim().slice(4).trim();

  // "ai::" alone = default provider (ollama)
  if (!rest) {
    return { name: 'ollama', blockId };
  }

  // Parse "provider arg" format
  const spaceIndex = rest.indexOf(' ');
  const providerName = spaceIndex === -1 ? rest : rest.slice(0, spaceIndex);
  const arg = spaceIndex === -1 ? undefined : rest.slice(spaceIndex + 1).trim() || undefined;

  // Config-driven: Just pass the name through, Rust decides what it means
  // The arg interpretation depends on the provider type (from config):
  // - CLI providers: arg is working directory
  // - HTTP providers: arg is model name
  return {
    name: providerName.toLowerCase(),
    blockId,
    // Pass arg as both - Rust will use the appropriate one based on config
    workingDir: arg,
    model: arg,
  };
}

// ═══════════════════════════════════════════════════════════════
// TREE TRAVERSAL
// ═══════════════════════════════════════════════════════════════

/**
 * Walk up the tree from a block, calling visitor for each ancestor.
 * Stops when visitor returns truthy value.
 *
 * @param startId - Block ID to start from
 * @param store - Block store for lookups
 * @param visitor - Called for each block, return truthy to stop
 * @returns The value returned by visitor when it stopped, or undefined
 */
export function traverseUp<T>(
  startId: string,
  store: TraversalStore,
  visitor: (block: Block) => T | undefined
): T | undefined {
  let currentId: string | undefined = startId;

  while (currentId) {
    const block = store.getBlock(currentId);
    if (!block) break;

    const result = visitor(block);
    if (result !== undefined) {
      return result;
    }

    currentId = block.parentId ?? undefined;
  }

  return undefined;
}

/**
 * Get all ancestors of a block (from block up to root).
 *
 * @returns Array from startId up to root (startId first, root last)
 */
export function getAncestors(
  startId: string,
  store: TraversalStore
): Array<{ id: string; content: string }> {
  const ancestors: Array<{ id: string; content: string }> = [];

  traverseUp(startId, store, (block) => {
    ancestors.push({ id: block.id, content: block.content });
    return undefined; // Continue to root
  });

  return ancestors;
}

/**
 * Find the nearest ancestor matching a predicate.
 */
export function findAncestor(
  startId: string,
  store: TraversalStore,
  predicate: (block: Block) => boolean
): Block | undefined {
  return traverseUp(startId, store, (block) => {
    if (predicate(block)) return block;
    return undefined;
  });
}

// ═══════════════════════════════════════════════════════════════
// PROVIDER DETECTION
// ═══════════════════════════════════════════════════════════════

/**
 * Find provider configuration by traversing up from a block.
 *
 * @param startId - Block to start from (typically /send block)
 * @param store - Block store for lookups
 * @returns Provider config or default provider if none found
 */
export function traverseUpForProvider(
  startId: string,
  store: TraversalStore
): ProviderConfig {
  const provider = traverseUp(startId, store, (block) => {
    const config = parseProviderConfig(block.content, block.id);
    if (config) return config;
    return undefined;
  });

  // Default to 'ollama' if no provider found (config-driven default)
  return provider ?? { name: 'ollama', blockId: '' };
}

/**
 * Find session ID from provider block's children.
 * Looks for "session: {uuid}" pattern.
 */
export function findSessionId(providerBlockId: string, store: TraversalStore): string | undefined {
  const providerBlock = store.getBlock(providerBlockId);
  if (!providerBlock) return undefined;

  for (const childId of providerBlock.childIds) {
    const child = store.getBlock(childId);
    if (!child) continue;

    const content = child.content.trim();
    if (content.startsWith('session:')) {
      const sessionId = content.slice('session:'.length).trim();
      if (sessionId) return sessionId;
    }
  }

  return undefined;
}

/**
 * Find model override from provider block's children.
 * Looks for "model:: {name}" pattern.
 */
export function findModelOverride(providerBlockId: string, store: TraversalStore): string | undefined {
  const providerBlock = store.getBlock(providerBlockId);
  if (!providerBlock) return undefined;

  for (const childId of providerBlock.childIds) {
    const child = store.getBlock(childId);
    if (!child) continue;

    const content = child.content.trim().toLowerCase();
    if (content.startsWith('model::')) {
      return child.content.trim().slice('model::'.length).trim() || undefined;
    }
  }

  return undefined;
}

// ═══════════════════════════════════════════════════════════════
// INHERITED CONTEXT
// ═══════════════════════════════════════════════════════════════

/**
 * Build full inherited context for a block.
 * Used by /context handler to show what's in effect.
 */
export function buildInheritedContext(
  startId: string,
  store: TraversalStore,
  zoomedRootId?: string
): InheritedContext {
  const ancestors = getAncestors(startId, store);
  const provider = traverseUpForProvider(startId, store);

  let sessionId: string | undefined;
  let model: string | undefined;

  // If we found a provider, look for session and model in its children
  if (provider.blockId) {
    sessionId = findSessionId(provider.blockId, store);
    model = findModelOverride(provider.blockId, store);
  }

  // Provider config may already have a model
  if (!model && 'model' in provider) {
    model = provider.model;
  }

  return {
    provider,
    model,
    sessionId,
    zoomedRootId,
    ancestors,
  };
}
