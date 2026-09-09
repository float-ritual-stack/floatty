/**
 * P2 effective-marker predicate index. Derived, never persisted or EventBus-fed.
 * Full rebuilds make invalidation inheritance-shaped: metadata edits, deletion,
 * and reparenting update every affected descendant in one atomic publication.
 * Parent memoisation costs O(blocks + effective marker output), not n * depth.
 * rAF coalesces bursts without resetting the pending frame; background tabs can
 * starve rAF, and synchronous rebuilds still occupy the main thread (as in P2).
 * Synthetic binary tree warm medians (local Vitest): 20k = 22.17ms,
 * 32k = 37.81ms. markerIndex.test.ts reproduces both sizes.
 */
import { createComputed, createRoot, createSignal, on, type Accessor } from 'solid-js';
import * as Y from 'yjs';
import { getSharedDoc } from '../hooks/useSyncedYDoc';
import { getEffectiveMarkers, type EffectiveMarkers, type MarkerBlock } from './blockContext';

export interface MarkerIndex {
  /** Block ids whose effective markers include this type and optional value. */
  having(type: string, value?: string): string[];
  /** Distinct values and block counts, including inherited markers. Null maps to ''. */
  readonly vocabulary: ReadonlyMap<string, ReadonlyMap<string, number>>;
}

interface MarkerIndexOptions {
  /** Live boundary, including when the block store materializes after mount. */
  pagesContainerId?: Accessor<string | null>;
  requestFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (handle: number) => void;
  onBuild?: (index: MarkerIndex) => void;
}

/** Build a complete immutable-by-contract snapshot from plain store.blocks. */
export function buildMarkerIndex(
  blocks: Readonly<Record<string, MarkerBlock>>,
  pagesContainerId?: string | null,
): MarkerIndex {
  const memo = new Map<string, EffectiveMarkers>();
  const byType = new Map<string, string[]>();
  const byValue = new Map<string, Map<string, string[]>>();
  const vocabulary = new Map<string, Map<string, number>>();
  const getBlock = (id: string) => blocks[id];
  for (const block of Object.values(blocks)) {
    const effective = getEffectiveMarkers(getBlock, block.id, pagesContainerId, memo);
    const seenTypes = new Set<string>();
    const seenKeys = new Set<string>();
    for (const marker of effective.markers) {
      const type = marker.markerType;
      const value = marker.value ?? '';
      if (!seenTypes.has(type)) {
        seenTypes.add(type);
        const ids = byType.get(type);
        if (ids) ids.push(block.id);
        else byType.set(type, [block.id]);
      }
      const key = `${type}::${value}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      let values = byValue.get(type);
      if (!values) { values = new Map(); byValue.set(type, values); }
      const ids = values.get(value);
      if (ids) ids.push(block.id);
      else values.set(value, [block.id]);
      let counts = vocabulary.get(type);
      if (!counts) { counts = new Map(); vocabulary.set(type, counts); }
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }
  return {
    having(type, value) {
      return [...((value === undefined ? byType.get(type) : byValue.get(type)?.get(value)) ?? [])];
    },
    vocabulary,
  };
}

function buildFromDoc(doc: Y.Doc, pagesContainerId?: string | null): MarkerIndex {
  const blocks: Record<string, MarkerBlock> = {};
  doc.getMap('blocks').forEach((value, id) => {
    if (!(value instanceof Y.Map)) return;
    const parentId = value.get('parentId');
    const metadata = value.get('metadata');
    blocks[id] = {
      id,
      parentId: typeof parentId === 'string' ? parentId : null,
      metadata: metadata instanceof Y.Map ? metadata.toJSON() : metadata as MarkerBlock['metadata'],
    };
  });
  return buildMarkerIndex(blocks, pagesContainerId);
}

/**
 * Observe the local Y.Doc and publish complete rAF-coalesced index snapshots.
 * Mirrors backlinkIndex: production observes the shared doc; tests inject one.
 * Read the doc directly because WorkspaceProvider can mount before the block
 * store is materialized; store initialization itself does not mutate the doc.
 */
export function createMarkerIndex(
  doc: Y.Doc = getSharedDoc(),
  options: MarkerIndexOptions = {},
): { index: Accessor<MarkerIndex>; dispose: () => void } {
  const requestFrame = options.requestFrame
    ?? ((callback: FrameRequestCallback) => requestAnimationFrame(callback));
  const cancelFrame = options.cancelFrame
    ?? ((handle: number) => cancelAnimationFrame(handle));
  const initial = buildFromDoc(doc, options.pagesContainerId?.());
  options.onBuild?.(initial);
  const [index, setIndex] = createSignal(initial, { equals: false });
  const blocksMap = doc.getMap('blocks');
  let frameHandle: number | null = null;
  let disposed = false;

  const rebuild = (): void => {
    frameHandle = null;
    if (disposed) return;
    const next = buildFromDoc(doc, options.pagesContainerId?.());
    if (disposed) return;
    setIndex(() => next);
    options.onBuild?.(next);
  };

  const markDirty = (): void => {
    if (disposed || frameHandle !== null) return;
    frameHandle = requestFrame(rebuild);
  };
  const observeBlocks = (events: Y.YEvent<unknown>[]): void => {
    const relevant = events.some((event) => {
      if (event.path.length === 0) return true; // block add/delete/replacement
      if (event.path.length >= 2) return event.path[1] === 'metadata';
      if (!(event instanceof Y.YMapEvent)) return false;
      return [...event.changes.keys.keys()].some((key) =>
        key === 'metadata' || key === 'parentId'
      );
    });
    if (relevant) markDirty();
  };

  blocksMap.observeDeep(observeBlocks);
  const disposeBoundary = createRoot((dispose) => {
    if (options.pagesContainerId) {
      createComputed(on(options.pagesContainerId, markDirty, { defer: true }));
    }
    return dispose;
  });

  return {
    index,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      disposeBoundary();
      blocksMap.unobserveDeep(observeBlocks);
      if (frameHandle !== null) {
        cancelFrame(frameHandle);
        frameHandle = null;
      }
    },
  };
}
