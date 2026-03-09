/**
 * BlockController — Two-phase editing model for blocks.
 *
 * Replaces live Yjs contentEditable binding with:
 *   composing (DOM-only) → committed (Y.Doc write)
 *
 * Like setBlockOutput in the door pattern: discrete Y.Doc operations,
 * not a live collaborative document binding.
 *
 * Usage:
 *   const controller = createBlockController(blockStore);
 *   controller.startComposing('block-1');   // capture baseline
 *   // ... user types in DOM, no Y.Doc writes ...
 *   controller.commitBlock('block-1');       // diff + write to Y.Doc
 *
 * @see src/lib/handlers/doorLoader.ts — setBlockOutput pattern
 * @see src/lib/events/types.ts — Origin, EventEnvelope
 */

import { createSignal, type Accessor } from 'solid-js';
import type { Origin } from './events/types';

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

export type CommitSource = 'blur' | 'enter' | 'pause' | 'navigation' | 'explicit';

export interface BlockCommittedEvent {
  blockId: string;
  previous: string;
  next: string;
  source: CommitSource;
  timestamp: number;
}

export type BlockCommittedHandler = (event: BlockCommittedEvent) => void;

/** Minimal interface — only the store methods BlockController needs. */
export interface BlockStoreAdapter {
  getBlockContent: (id: string) => string | undefined;
  updateBlockContent: (id: string, content: string) => void;
}

interface ComposingState {
  baseline: string;
  startedAt: number;
}

// ═══════════════════════════════════════════════════════════════
// BLOCK CONTROLLER
// ═══════════════════════════════════════════════════════════════

export interface BlockController {
  /** Begin local-only editing. Captures Y.Doc content as baseline. */
  startComposing: (blockId: string) => void;

  /**
   * Diff local content against baseline, write delta to Y.Doc.
   * No-op if content unchanged. Returns the committed event or null.
   */
  commitBlock: (blockId: string, localContent: string, source: CommitSource) => BlockCommittedEvent | null;

  /** Revert to baseline, no Y.Doc write. */
  cancelComposing: (blockId: string) => string | null;

  /** Reactive signal: is this block currently composing? */
  isComposing: (blockId: string) => boolean;

  /** Subscribe to committed events. Returns unsubscribe function. */
  onCommitted: (handler: BlockCommittedHandler) => () => void;

  /** Get baseline content for a composing block (for cancel/revert). */
  getBaseline: (blockId: string) => string | undefined;

  /** Clean up all state (for testing / unmount). */
  dispose: () => void;
}

export function createBlockController(store: BlockStoreAdapter): BlockController {
  // Composing state per block. Map instead of signal-per-block
  // because block set is dynamic. The isComposing accessor uses
  // a version signal to trigger SolidJS reactivity.
  const composing = new Map<string, ComposingState>();
  const [version, setVersion] = createSignal(0);
  const handlers = new Set<BlockCommittedHandler>();

  function startComposing(blockId: string): void {
    if (composing.has(blockId)) return; // Already composing

    const content = store.getBlockContent(blockId);
    if (content === undefined) {
      console.warn(`[BlockController] startComposing: block ${blockId} not found`);
      return;
    }

    composing.set(blockId, {
      baseline: content,
      startedAt: Date.now(),
    });
    setVersion((v) => v + 1); // Trigger reactive reads
  }

  function commitBlock(
    blockId: string,
    localContent: string,
    source: CommitSource,
  ): BlockCommittedEvent | null {
    const state = composing.get(blockId);
    if (!state) {
      // Not composing — commit anyway if content differs from store.
      // Graceful fallback for blocks that weren't explicitly started.
      const current = store.getBlockContent(blockId);
      if (current === undefined || current === localContent) return null;

      store.updateBlockContent(blockId, localContent);
      const event: BlockCommittedEvent = {
        blockId,
        previous: current,
        next: localContent,
        source,
        timestamp: Date.now(),
      };
      emit(event);
      return event;
    }

    const { baseline } = state;
    composing.delete(blockId);
    setVersion((v) => v + 1);

    // No-op if unchanged
    if (localContent === baseline) return null;

    // Single Y.Doc transaction via store adapter
    store.updateBlockContent(blockId, localContent);

    const event: BlockCommittedEvent = {
      blockId,
      previous: baseline,
      next: localContent,
      source,
      timestamp: Date.now(),
    };
    emit(event);
    return event;
  }

  function cancelComposing(blockId: string): string | null {
    const state = composing.get(blockId);
    if (!state) return null;

    composing.delete(blockId);
    setVersion((v) => v + 1);
    return state.baseline;
  }

  function isComposing(blockId: string): boolean {
    // Read version signal to create reactive dependency
    version();
    return composing.has(blockId);
  }

  function getBaseline(blockId: string): string | undefined {
    return composing.get(blockId)?.baseline;
  }

  function onCommitted(handler: BlockCommittedHandler): () => void {
    handlers.add(handler);
    return () => handlers.delete(handler);
  }

  function emit(event: BlockCommittedEvent): void {
    for (const handler of handlers) {
      try {
        handler(event);
      } catch (err) {
        console.error('[BlockController] onCommitted handler threw:', err);
      }
    }
  }

  function dispose(): void {
    composing.clear();
    handlers.clear();
    setVersion(0);
  }

  return {
    startComposing,
    commitBlock,
    cancelComposing,
    isComposing,
    onCommitted,
    getBaseline,
    dispose,
  };
}
