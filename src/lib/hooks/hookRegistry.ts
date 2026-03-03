/**
 * Hook Registry
 *
 * Central registry for block lifecycle and execution hooks.
 * Provides the documented hook system interface from FLOATTY_HOOK_SYSTEM.md.
 *
 * Priority conventions:
 * | Range      | Use                              |
 * |------------|----------------------------------|
 * | -100 to -1 | Security/validation (run first)  |
 * | 0 to 49    | Context assembly, transformation |
 * | 50 to 99   | Standard processing              |
 * | 100+       | Logging, cleanup (run last)      |
 *
 * @example
 * // Register a hook
 * hookRegistry.register({
 *   id: 'ai-context-assembly',
 *   event: 'execute:before',
 *   filter: (block) => block.type === 'ai',
 *   priority: 0,
 *   handler: (ctx) => {
 *     const messages = buildConversation(ctx.block, ctx.store);
 *     return { context: { messages } };
 *   }
 * });
 *
 * // Run hooks for an event
 * const result = await hookRegistry.run('execute:before', {
 *   block,
 *   content: block.content,
 *   event: 'execute:before',
 *   store,
 * });
 *
 * if (result.abort) {
 *   console.log('Execution aborted:', result.reason);
 * }
 */

import type {
  Hook,
  HookEvent,
  HookContext,
  HookResult,
} from './types';

// ═══════════════════════════════════════════════════════════════
// HOOK REGISTRY
// ═══════════════════════════════════════════════════════════════

export class HookRegistry {
  private hooks: Map<string, Hook> = new Map();
  private hooksByEvent: Map<HookEvent, Hook[]> = new Map();

  /**
   * Register a hook.
   *
   * @param hook - Hook definition
   * @throws If hook with same ID already exists
   */
  register(hook: Hook): void {
    if (this.hooks.has(hook.id)) {
      // Idempotent on HMR — module-level guards reset but singleton registry persists
      console.debug(`[HookRegistry] Hook "${hook.id}" already registered, skipping`);
      return;
    }

    this.hooks.set(hook.id, hook);

    // Index by event for fast lookup
    const events = Array.isArray(hook.event) ? hook.event : [hook.event];
    for (const event of events) {
      const existing = this.hooksByEvent.get(event) || [];
      existing.push(hook);
      // Sort by priority (lower = earlier)
      existing.sort((a, b) => a.priority - b.priority);
      this.hooksByEvent.set(event, existing);
    }
  }

  /**
   * Unregister a hook by ID.
   *
   * @param id - Hook ID
   * @returns true if hook was found and removed
   */
  unregister(id: string): boolean {
    const hook = this.hooks.get(id);
    if (!hook) return false;

    this.hooks.delete(id);

    // Remove from event index
    const events = Array.isArray(hook.event) ? hook.event : [hook.event];
    for (const event of events) {
      const existing = this.hooksByEvent.get(event) || [];
      const filtered = existing.filter((h) => h.id !== id);
      this.hooksByEvent.set(event, filtered);
    }

    return true;
  }

  /**
   * Run all hooks for an event.
   *
   * Hooks are run in priority order. For execute:before:
   * - Content modifications are accumulated
   * - First abort stops execution
   * - Context is merged
   *
   * @param event - Event type
   * @param ctx - Hook context
   * @returns Accumulated result from all hooks
   */
  async run(event: HookEvent, ctx: HookContext): Promise<HookResult> {
    const hooks = this.hooksByEvent.get(event) || [];
    const accumulated: HookResult = {};

    // Track modified content through the chain
    let currentContent = ctx.content;

    for (const hook of hooks) {
      // Check filter
      if (!hook.filter(ctx.block)) {
        continue;
      }

      try {
        // Create context with potentially modified content
        const hookCtx: HookContext = {
          ...ctx,
          content: currentContent,
        };

        // Run handler (may be sync or async)
        const result = await Promise.resolve(hook.handler(hookCtx));

        // Accumulate results
        if (result.abort) {
          // Early exit on abort
          return {
            ...accumulated,
            abort: true,
            reason: result.reason,
            content: currentContent,
          };
        }

        if (result.content !== undefined) {
          currentContent = result.content;
        }

        if (result.context) {
          accumulated.context = {
            ...accumulated.context,
            ...result.context,
          };
        }
      } catch (error) {
        // Log but don't propagate - one hook failing shouldn't break others
        console.error(`[HookRegistry] Hook "${hook.id}" threw:`, error);
      }
    }

    // Return accumulated result with final content
    return {
      ...accumulated,
      content: currentContent !== ctx.content ? currentContent : undefined,
    };
  }

  /**
   * Run hooks synchronously (for performance-critical paths).
   *
   * Note: Async hooks will not be awaited - their return values are ignored.
   * Use run() for full async support.
   */
  runSync(event: HookEvent, ctx: HookContext): HookResult {
    const hooks = this.hooksByEvent.get(event) || [];
    const accumulated: HookResult = {};
    let currentContent = ctx.content;

    for (const hook of hooks) {
      if (!hook.filter(ctx.block)) {
        continue;
      }

      try {
        const hookCtx: HookContext = { ...ctx, content: currentContent };
        const result = hook.handler(hookCtx);

        // Skip if result is a Promise (async hook)
        if (result instanceof Promise) {
          console.warn(
            `[HookRegistry] Async hook "${hook.id}" called in sync context - result ignored`
          );
          continue;
        }

        if (result.abort) {
          return {
            ...accumulated,
            abort: true,
            reason: result.reason,
            content: currentContent,
          };
        }

        if (result.content !== undefined) {
          currentContent = result.content;
        }

        if (result.context) {
          accumulated.context = {
            ...accumulated.context,
            ...result.context,
          };
        }
      } catch (error) {
        console.error(`[HookRegistry] Hook "${hook.id}" threw:`, error);
      }
    }

    return {
      ...accumulated,
      content: currentContent !== ctx.content ? currentContent : undefined,
    };
  }

  /**
   * Check if any hooks are registered for an event.
   */
  hasHooks(event: HookEvent): boolean {
    const hooks = this.hooksByEvent.get(event);
    return hooks !== undefined && hooks.length > 0;
  }

  /**
   * Get all registered hook IDs.
   */
  getHookIds(): string[] {
    return Array.from(this.hooks.keys());
  }

  /**
   * Get hooks for a specific event (for debugging).
   */
  getHooksForEvent(event: HookEvent): Array<{ id: string; priority: number }> {
    const hooks = this.hooksByEvent.get(event) || [];
    return hooks.map((h) => ({ id: h.id, priority: h.priority }));
  }

  /**
   * Clear all hooks.
   */
  clear(): void {
    this.hooks.clear();
    this.hooksByEvent.clear();
  }
}

// ═══════════════════════════════════════════════════════════════
// SINGLETON INSTANCE
// ═══════════════════════════════════════════════════════════════

/**
 * Global hook registry for block lifecycle and execution hooks.
 */
export const hookRegistry = new HookRegistry();
