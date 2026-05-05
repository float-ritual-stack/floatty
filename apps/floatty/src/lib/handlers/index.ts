/**
 * Handler Registry - Central Registration
 * 
 * Import and register all block handlers here.
 * Call registerHandlers() from app initialization to activate.
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
import { evalHandler } from './eval';
import { artifactHandler } from './artifactHandler';
import { echoCopyHandler } from './echoCopy';
import { hookRegistry } from '../hooks';
import { sendContextHook } from './hooks/sendContextHook';
import { registerCtxRouterHook } from './hooks/ctxRouterHook';
import { registerOutlinksHook } from './hooks/outlinksHook';
import { registerOutputSummaryHook } from './hooks/outputSummaryHook';
import { loadDoors, cleanupDoorDeps } from './doorLoader';
import { doorRegistry } from './doorRegistry';
import { registerFuncIndexHook } from './funcRegistry';
import { createLogger } from '../logger';

const logger = createLogger('handlers');

// Re-export registry and types for convenience
export { registry } from './registry';
export { doorRegistry } from './doorRegistry';
export type { BlockHandler, ExecutorActions } from './types';

// Re-export executor for hook-aware handler execution
export { executeHandler, createHookBlockStore } from './executor';

// Re-export search types for component use
export type { SearchResults, SearchHit } from './search';

// Re-export door types for component use
export type {
  Door,
  DoorMeta,
  DoorEnvelope,
  DoorViewOutput,
  DoorExecOutput,
  DoorViewProps,
  DoorServerAccess,
} from './doorTypes';

// Guard against duplicate registration (HMR in dev can trigger multiple calls)
let handlersRegistered = false;

/**
 * Register all handlers and hooks with global registries
 * Call this once during app initialization (e.g., in main.tsx or App.tsx)
 */
export function registerHandlers(): void {
  if (handlersRegistered) {
    logger.debug('Already registered, skipping');
    return;
  }
  handlersRegistered = true;

  // Register block handlers
  registry.register(shHandler);
  registry.register(conversationHandler);
  registry.register(searchHandler);
  registry.register(pickHandler);
  registry.register(sendHandler);
  registry.register(helpHandler);
  registry.register(backupHandler);
  registry.register(infoHandler);
  registry.register(evalHandler);
  registry.register(artifactHandler);
  registry.register(echoCopyHandler);

  // Register hooks - THE ARCHITECTURE IN ACTION
  // Hooks assemble context, handlers consume it
  hookRegistry.register(sendContextHook);

  // Register EventBus subscriptions (block lifecycle hooks)
  registerCtxRouterHook();
  registerOutlinksHook();
  registerOutputSummaryHook();
  registerFuncIndexHook();

  logger.info(`Registered handlers: ${registry.getRegisteredPrefixes().join(', ')}`);
  logger.info(`Registered hooks: ${hookRegistry.getHookIds().join(', ')}`);

  // Load userland doors (async, fire-and-forget)
  // Built-in handlers are available immediately; doors load in background.
  loadDoors().catch(err => logger.error('Door loading failed', { err }));
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
    logger.debug('HMR cleanup - resetting registration');
    handlersRegistered = false;
    registry.clear();
    hookRegistry.clear();
    doorRegistry.clear();
    cleanupDoorDeps();
  });
}
