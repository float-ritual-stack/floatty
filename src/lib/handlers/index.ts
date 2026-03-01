/**
 * Handler Registry - Central Registration
 *
 * Import and register all block handlers here.
 * Call registerHandlers() from app initialization to activate.
 *
 * Plugins (bundled and user) are loaded after built-in handlers,
 * so plugin handlers can extend but not conflict with built-ins.
 */

import { registry } from './registry';
import { shHandler } from './commandDoor';
import { conversationHandler } from './conversation';
import { searchHandler } from './search';
import { pickHandler } from './pick';
import { sendHandler } from './send';
import { helpHandler } from './help';
import { backupHandler } from './backup';
import { infoHandler } from './info';
import { hookRegistry } from '../hooks';
import { sendContextHook } from './hooks/sendContextHook';
import { registerCtxRouterHook } from './hooks/ctxRouterHook';
import { registerOutlinksHook } from './hooks/outlinksHook';
import { loadPlugins, clearViews, unloadAllPlugins } from '../plugins';
import { bundledPlugins } from '../../plugins';

// Re-export registry and types for convenience
export { registry } from './registry';
export type { BlockHandler, ExecutorActions } from './types';

// Re-export executor for hook-aware handler execution
export { executeHandler, createHookBlockStore } from './executor';

// Re-export daily types for component use (now from tauriTypes — plugin owns the handler)
export type {
  PrInfo,
  TimelogEntry,
  ScatteredThought,
  DayStats,
  DailyNoteData
} from '../tauriTypes';

// Re-export search types for component use
export type { SearchResults, SearchHit } from './search';

// Guard against duplicate registration (HMR in dev can trigger multiple calls)
let handlersRegistered = false;

/**
 * Register all handlers and hooks with global registries, then load plugins.
 * Call this once during app initialization (e.g., in main.tsx or App.tsx).
 *
 * Load order:
 * 1. Built-in handlers (sh::, ai::, search::, etc.)
 * 2. Built-in hooks (sendContext, ctxRouter, outlinks)
 * 3. Bundled plugins (daily:: — shipped with app, loaded via plugin system)
 * 4. User plugins (~/.floatty/plugins/* — future: dynamic filesystem loading)
 */
export async function registerHandlers(): Promise<void> {
  if (handlersRegistered) {
    console.log('[handlers] Already registered, skipping');
    return;
  }
  handlersRegistered = true;

  // Register built-in block handlers
  registry.register(shHandler);
  registry.register(conversationHandler);
  registry.register(searchHandler);
  registry.register(pickHandler);
  registry.register(sendHandler);
  registry.register(helpHandler);
  registry.register(backupHandler);
  registry.register(infoHandler);

  // Register hooks - THE ARCHITECTURE IN ACTION
  // Hooks assemble context, handlers consume it
  hookRegistry.register(sendContextHook);

  // Register EventBus subscriptions (block lifecycle hooks)
  registerCtxRouterHook();
  registerOutlinksHook();

  console.log('[handlers] Registered built-in handlers:', registry.getRegisteredPrefixes().join(', '));
  console.log('[handlers] Registered hooks:', hookRegistry.getHookIds().join(', '));

  // Load bundled plugins (daily:: is now a plugin)
  await loadPlugins(bundledPlugins);

  console.log('[handlers] All handlers after plugins:', registry.getRegisteredPrefixes().join(', '));
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
    unloadAllPlugins();
    clearViews();
    registry.clear();
    hookRegistry.clear();
  });
}
