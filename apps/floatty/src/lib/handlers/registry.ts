/**
 * Block Handler Registry
 * 
 * Central registry for all executable block handlers (sh::, ai::, daily::, etc.)
 * Provides registration and lookup functionality.
 */

import type { BlockHandler } from './types';
import { funcMetaHandler } from './funcRegistry';

// ═══════════════════════════════════════════════════════════════
// REGISTRY CLASS
// ═══════════════════════════════════════════════════════════════

export class HandlerRegistry {
  private handlers: BlockHandler[] = [];
  private funcPrefixes: Set<string> = new Set();

  /**
   * Register a new handler
   */
  register(handler: BlockHandler): void {
    this.handlers.push(handler);
  }

  /**
   * Find handler for content based on prefix match
   * @returns Handler if found, null otherwise
   */
  findHandler(content: string): BlockHandler | null {
    const trimmed = content.trim().toLowerCase();
    // Registered handlers win (static prefixes)
    const registered = this.handlers.find(h =>
      h.prefixes.some(p => trimmed.startsWith(p.toLowerCase()))
    );
    if (registered) return registered;

    // Fallback: check func-defined prefixes
    for (const fp of this.funcPrefixes) {
      if (trimmed.startsWith(fp)) return funcMetaHandler;
    }

    return null;
  }

  /**
   * Check if content is an executable block
   */
  isExecutableBlock(content: string): boolean {
    return this.findHandler(content) !== null;
  }

  /**
   * Remove handlers whose prefixes overlap with the given set.
   * Used by hot reload to deregister before re-registering.
   */
  unregisterByPrefixes(prefixes: string[]): void {
    const prefixSet = new Set(prefixes.map(p => p.toLowerCase()));
    this.handlers = this.handlers.filter(
      h => !h.prefixes.some(p => prefixSet.has(p.toLowerCase()))
    );
  }

  /**
   * Get all registered prefixes (for debugging/documentation)
   */
  getRegisteredPrefixes(): string[] {
    return this.handlers.flatMap(h => h.prefixes);
  }

  /**
   * Update the set of func-defined prefixes (called on block changes).
   */
  updateFuncPrefixes(prefixes: Set<string>): void {
    this.funcPrefixes = prefixes;
  }

  /**
   * Get func-defined prefixes (for debugging/testing).
   */
  getFuncPrefixes(): Set<string> {
    return this.funcPrefixes;
  }

  /**
   * Clear all handlers (for HMR cleanup)
   */
  clear(): void {
    this.handlers = [];
    this.funcPrefixes = new Set();
  }
}

// ═══════════════════════════════════════════════════════════════
// SINGLETON INSTANCE
// ═══════════════════════════════════════════════════════════════

/**
 * Global handler registry instance
 * Import and use directly: `registry.findHandler(content)`
 */
export const registry = new HandlerRegistry();
