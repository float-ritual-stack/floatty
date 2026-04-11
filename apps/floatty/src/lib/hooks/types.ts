/**
 * Hook System Types
 *
 * Aligned with docs/architecture/FLOATTY_HOOK_SYSTEM.md
 *
 * Hooks provide lifecycle event handling for blocks:
 * - block:create/update/delete - CRDT changes
 * - execute:before/after - handler execution
 *
 * @example
 * registerHook({
 *   id: 'wikilink-index',
 *   event: 'block:create',
 *   filter: (block) => block.content.includes('[['),
 *   priority: 50,
 *   handler: (ctx) => {
 *     indexWikilinks(ctx.block);
 *     return {};
 *   }
 * });
 */

import type { Block } from '../blockTypes';

// ═══════════════════════════════════════════════════════════════
// HOOK EVENTS
// ═══════════════════════════════════════════════════════════════

/**
 * Events that hooks can listen to.
 *
 * Block lifecycle:
 * - block:create - Block added to Y.Doc
 * - block:update - Block content/metadata changed
 * - block:delete - Block removed from Y.Doc
 *
 * Execution lifecycle:
 * - execute:before - Before handler.execute() runs (can abort/modify)
 * - execute:after - After handler.execute() completes (can post-process)
 */
export type HookEvent =
  | 'block:create'
  | 'block:update'
  | 'block:delete'
  | 'execute:before'
  | 'execute:after';

// ═══════════════════════════════════════════════════════════════
// HOOK CONTEXT
// ═══════════════════════════════════════════════════════════════

/**
 * Read-only block store interface for hooks.
 * Hooks should not mutate directly - use HookResult for modifications.
 */
export interface HookBlockStore {
  getBlock: (id: string) => Block | undefined;
  readonly rootIds: string[];
  readonly blocks: Record<string, Block>;
  /** Current zoomed root (if any) - hooks can use this for scoping */
  readonly zoomedRootId?: string;
}

/**
 * Context passed to hook handlers.
 *
 * For block:* events:
 * - block: The affected block
 * - content: Block content at time of event
 * - previousContent: Previous content (for update events)
 *
 * For execute:* events:
 * - block: The block being executed
 * - content: Content to execute (may be modified by earlier hooks)
 * - result: Handler output (only for execute:after)
 * - error: Error message if execution failed (only for execute:after)
 */
export interface HookContext {
  /** The block this event is about */
  block: Block;

  /** Current content (may be modified by earlier hooks for execute:before) */
  content: string;

  /** The event type */
  event: HookEvent;

  /** Read-only access to block store */
  store: HookBlockStore;

  /** Previous content (for block:update events) */
  previousContent?: string;

  /** Handler output (for execute:after) */
  result?: unknown;

  /** Error message if execution failed (for execute:after) */
  error?: string;
}

// ═══════════════════════════════════════════════════════════════
// HOOK RESULT
// ═══════════════════════════════════════════════════════════════

/**
 * Result returned by hook handlers.
 *
 * For execute:before, hooks can:
 * - Modify content before execution
 * - Abort execution with a reason
 * - Inject context for the handler
 *
 * For other events, hooks typically return {} (no modification).
 */
export interface HookResult {
  /** Modified content (for execute:before) */
  content?: string;

  /** Abort execution (for execute:before) */
  abort?: boolean;

  /** Reason for abort (shown to user) */
  reason?: string;

  /** Additional context for handler (for execute:before) */
  context?: Record<string, unknown>;
}

// ═══════════════════════════════════════════════════════════════
// HOOK INTERFACE
// ═══════════════════════════════════════════════════════════════

/**
 * Hook handler function.
 * Can be sync or async - async hooks are awaited.
 */
export type HookHandler = (ctx: HookContext) => HookResult | Promise<HookResult>;

/**
 * Filter function to determine if hook should run for a block.
 */
export type HookFilter = (block: Block) => boolean;

/**
 * Hook definition.
 *
 * @example
 * const dangerCheck: Hook = {
 *   id: 'sh-danger-check',
 *   event: 'execute:before',
 *   filter: (block) => block.type === 'sh',
 *   priority: -10,  // Run early (security)
 *   handler: (ctx) => {
 *     if (ctx.content.includes('rm -rf /')) {
 *       return { abort: true, reason: 'Dangerous command blocked' };
 *     }
 *     return {};
 *   }
 * };
 */
export interface Hook {
  /** Unique identifier for this hook */
  id: string;

  /** Event(s) to listen to */
  event: HookEvent | HookEvent[];

  /** Filter to determine if hook runs for a block */
  filter: HookFilter;

  /**
   * Priority for execution order. Lower = earlier.
   *
   * Conventions:
   * - -100 to -1: Security/validation (run first)
   * - 0 to 49: Context assembly, transformation
   * - 50 to 99: Standard processing
   * - 100+: Logging, cleanup (run last)
   */
  priority: number;

  /** Handler function */
  handler: HookHandler;
}

// ═══════════════════════════════════════════════════════════════
// BUILT-IN FILTERS
// ═══════════════════════════════════════════════════════════════

/**
 * Pre-built filter functions for common use cases.
 */
export const HookFilters = {
  /** Match all blocks */
  all: (): HookFilter => () => true,

  /** Match blocks of specific type */
  byType: (type: Block['type']): HookFilter =>
    (block) => block.type === type,

  /** Match blocks with content starting with prefix */
  byPrefix: (prefix: string): HookFilter =>
    (block) => block.content.trim().toLowerCase().startsWith(prefix.toLowerCase()),

  /** Match blocks containing wikilinks */
  hasWikilinks: (): HookFilter =>
    (block) => block.content.includes('[['),

  /** Match executable blocks (sh::, ai::, daily::, etc.) */
  isExecutable: (prefixes: string[]): HookFilter =>
    (block) => {
      const trimmed = block.content.trim().toLowerCase();
      return prefixes.some(p => trimmed.startsWith(p.toLowerCase()));
    },

  /** Combine filters with AND */
  and: (...filters: HookFilter[]): HookFilter =>
    (block) => filters.every(f => f(block)),

  /** Combine filters with OR */
  or: (...filters: HookFilter[]): HookFilter =>
    (block) => filters.some(f => f(block)),

  /** Negate a filter */
  not: (filter: HookFilter): HookFilter =>
    (block) => !filter(block),
} as const;
