/**
 * Handler Registry - Central Registration
 * 
 * Import and register all block handlers here.
 * Call registerHandlers() from app initialization to activate.
 */

import { registry } from './registry';
import { shHandler } from './commandDoor';
import { conversationHandler } from './conversation';
import { dailyHandler } from './daily';
import { searchHandler } from './search';
import { pickHandler } from './pick';
import { sendHandler } from './send';
import { helpHandler } from './help';
import { backupHandler } from './backup';
import { hookRegistry } from '../hooks';
import { sendContextHook } from './hooks/sendContextHook';
import { registerCtxRouterHook } from './hooks/ctxRouterHook';

// Re-export registry and types for convenience
export { registry } from './registry';
export type { BlockHandler, ExecutorActions } from './types';

// Re-export executor for hook-aware handler execution
export { executeHandler, createHookBlockStore } from './executor';

// Re-export daily types for component use
export type {
  PrInfo,
  TimelogEntry,
  ScatteredThought,
  DayStats,
  DailyNoteData
} from './daily';

// Re-export search types for component use
export type { SearchResults, SearchHit } from './search';

// Guard against duplicate registration (HMR in dev can trigger multiple calls)
let handlersRegistered = false;

/**
 * Register all handlers and hooks with global registries
 * Call this once during app initialization (e.g., in main.tsx or App.tsx)
 */
export function registerHandlers(): void {
  if (handlersRegistered) {
    console.log('[handlers] Already registered, skipping');
    return;
  }
  handlersRegistered = true;

  // Register block handlers
  registry.register(shHandler);
  registry.register(conversationHandler);
  registry.register(dailyHandler);
  registry.register(searchHandler);
  registry.register(pickHandler);
  registry.register(sendHandler);
  registry.register(helpHandler);
  registry.register(backupHandler);

  // Register hooks - THE ARCHITECTURE IN ACTION
  // Hooks assemble context, handlers consume it
  hookRegistry.register(sendContextHook);

  // Register EventBus subscriptions (block lifecycle hooks)
  registerCtxRouterHook();

  console.log('[handlers] Registered handlers:', registry.getRegisteredPrefixes().join(', '));
  console.log('[handlers] Registered hooks:', hookRegistry.getHookIds().join(', '));
}

/**
 * Check if content is a handler-managed block
 * Convenience wrapper for registry.isExecutableBlock()
 */
export function isExecutableBlock(content: string): boolean {
  return registry.isExecutableBlock(content);
}

// ═══════════════════════════════════════════════════════════════
// HMR CLEANUP
// ═══════════════════════════════════════════════════════════════

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    console.log('[handlers] HMR cleanup - resetting registration');
    handlersRegistered = false;
    registry.clear();
    hookRegistry.clear();
  });
}
