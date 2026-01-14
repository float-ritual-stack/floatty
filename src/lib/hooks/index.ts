/**
 * Hook System
 *
 * Block lifecycle and execution hooks aligned with FLOATTY_HOOK_SYSTEM.md.
 *
 * @module hooks
 * @see docs/architecture/FLOATTY_HOOK_SYSTEM.md
 */

// Types
export {
  type HookEvent,
  type HookContext,
  type HookResult,
  type HookHandler,
  type HookFilter,
  type Hook,
  type HookBlockStore,
  HookFilters,
} from './types';

// Registry
export { HookRegistry, hookRegistry } from './hookRegistry';
