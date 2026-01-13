/**
 * Handler Registry - Central Registration
 * 
 * Import and register all block handlers here.
 * Call registerHandlers() from app initialization to activate.
 */

import { registry } from './registry';
import { shHandler, aiHandler } from './commandDoor';
import { dailyHandler } from './daily';

// Re-export registry and types for convenience
export { registry } from './registry';
export type { BlockHandler, ExecutorActions } from './types';

// Re-export daily types for component use
export type {
  PrInfo,
  TimelogEntry,
  ScatteredThought,
  DayStats,
  DailyNoteData
} from './daily';

// Guard against duplicate registration (HMR in dev can trigger multiple calls)
let handlersRegistered = false;

/**
 * Register all handlers with the global registry
 * Call this once during app initialization (e.g., in main.tsx or App.tsx)
 */
export function registerHandlers(): void {
  if (handlersRegistered) {
    console.log('[handlers] Already registered, skipping');
    return;
  }
  handlersRegistered = true;

  registry.register(shHandler);
  registry.register(aiHandler);
  registry.register(dailyHandler);

  console.log('[handlers] Registered:', registry.getRegisteredPrefixes().join(', '));
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
  });
}
