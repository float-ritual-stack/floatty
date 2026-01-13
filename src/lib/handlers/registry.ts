/**
 * Block Handler Registry
 * 
 * Central registry for all executable block handlers (sh::, ai::, daily::, etc.)
 * Provides registration and lookup functionality.
 */

import type { BlockHandler } from './types';

// ═══════════════════════════════════════════════════════════════
// REGISTRY CLASS
// ═══════════════════════════════════════════════════════════════

export class HandlerRegistry {
  private handlers: BlockHandler[] = [];

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
    return this.handlers.find(h =>
      h.prefixes.some(p => trimmed.startsWith(p))
    ) ?? null;
  }

  /**
   * Check if content is an executable block
   */
  isExecutableBlock(content: string): boolean {
    return this.findHandler(content) !== null;
  }

  /**
   * Get all registered prefixes (for debugging/documentation)
   */
  getRegisteredPrefixes(): string[] {
    return this.handlers.flatMap(h => h.prefixes);
  }

  /**
   * Clear all handlers (for HMR cleanup)
   */
  clear(): void {
    this.handlers = [];
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
