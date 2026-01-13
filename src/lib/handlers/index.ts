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

// Re-export search types for component use
export type { SearchResults, SearchHit } from './search';

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
  registry.register(conversationHandler);
  registry.register(dailyHandler);
  registry.register(searchHandler);
  registry.register(pickHandler);

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
