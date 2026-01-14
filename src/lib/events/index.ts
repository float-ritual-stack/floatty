/**
 * Event system for Floatty's two-lane architecture
 *
 * @module events
 * @see docs/architecture/FLOATTY_HOOK_SYSTEM.md
 */

// Types
export {
  Origin,
  type OriginType,
  type BlockEventType,
  type BlockChangeField,
  type BlockEvent,
  type EventEnvelope,
  type SyncEventHandler,
  type AsyncEventHandler,
  type EventFilter,
  EventFilters,
} from './types';

// EventBus (sync pub/sub)
export {
  EventBus,
  blockEventBus,
  type SubscriptionOptions,
} from './eventBus';

// ProjectionScheduler (async batched)
export {
  ProjectionScheduler,
  blockProjectionScheduler,
  type ProjectionSchedulerOptions,
  type ProjectionOptions,
} from './projectionScheduler';
