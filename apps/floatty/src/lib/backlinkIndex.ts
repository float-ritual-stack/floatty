/**
 * Client-only canonical backlink reverse index.
 *
 * Derived state only: rebuilt from the local Y.Doc, held in memory, and never
 * persisted. The observer marks dirty; one requestAnimationFrame rebuilds a
 * complete replacement which is then published through a Solid signal.
 */

import { createSignal, type Accessor } from 'solid-js';
import * as Y from 'yjs';
import { getSharedDoc } from '../hooks/useSyncedYDoc';
import type { Block } from './blockTypes';
import { getSectionKey } from './pageTitle';
import { matchExact } from './pathMatcher';
import { extractWikilinkTargets } from './wikilinkUtils';

const PAGES_PREFIX = 'pages::';
const MIN_ID_PREFIX_LENGTH = 6;
const HEX_ID_RE = /^[0-9a-f]+$/i;

export interface BacklinkIndex {
  /** Source block ids that link to this canonical target key. */
  referencing(targetKey: string): string[];
  /** Prefix targets dropped because they matched multiple full block ids. */
  readonly ambiguousTargets: string[];
}

type BacklinkBlock = Pick<Block, 'id' | 'parentId' | 'childIds' | 'content' | 'createdAt'>;
type BacklinkBlocks = Readonly<Record<string, BacklinkBlock>> | Iterable<BacklinkBlock>;

interface BacklinkIndexOptions {
  requestFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (handle: number) => void;
  /** Test/performance instrumentation; called after each completed build. */
  onBuild?: (index: BacklinkIndex) => void;
}

function asBlockArray(blocks: BacklinkBlocks): BacklinkBlock[] {
  return Symbol.iterator in Object(blocks)
    ? Array.from(blocks as Iterable<BacklinkBlock>)
    : Object.values(blocks as Readonly<Record<string, BacklinkBlock>>);
}

function compactId(value: string): string {
  return value.replaceAll('-', '').toLowerCase();
}

function canonicalPageMap(
  blocks: BacklinkBlock[],
  byId: ReadonlyMap<string, BacklinkBlock>,
  rootIds?: readonly string[],
): Map<string, string> {
  const containerCandidates = rootIds
    ? rootIds.map((id) => byId.get(id)).filter((block): block is BacklinkBlock => block !== undefined)
    : blocks.filter((block) => block.parentId === null);
  const pages: BacklinkBlock[] = [];

  for (const container of containerCandidates) {
    if (container.content.trim() !== PAGES_PREFIX) continue;
    for (const childId of container.childIds) {
      const page = byId.get(childId);
      if (page) pages.push(page);
    }
  }

  // matchExact owns both canonical title comparison and oldest-createdAt wins,
  // including the shared rule that unknown timestamps compare as +Infinity.
  const groups = new Map<string, BacklinkBlock[]>();
  for (const page of pages) {
    const key = getSectionKey(page.content);
    if (!key) continue;
    const group = groups.get(key);
    if (group) group.push(page);
    else groups.set(key, [page]);
  }

  const pageByName = new Map<string, string>();
  for (const [key, group] of groups) {
    const index = matchExact(key, group);
    if (index !== null) pageByName.set(key, group[index].id);
  }
  return pageByName;
}

/** Build a complete immutable-by-contract snapshot from plain block values. */
export function buildBacklinkIndex(
  blocksInput: BacklinkBlocks,
  rootIds?: readonly string[],
): BacklinkIndex {
  const blocks = asBlockArray(blocksInput);
  const byId = new Map(blocks.map((block) => [block.id, block]));
  const fullIdByLower = new Map(blocks.map((block) => [block.id.toLowerCase(), block.id]));
  const compactIdToFull = new Map(blocks.map((block) => [compactId(block.id), block.id]));
  const pageByName = canonicalPageMap(blocks, byId, rootIds);
  // Sorted compact ids provide prefix→full-id multimap semantics without
  // materializing every possible UUID prefix. A lower-bound lookup identifies
  // zero, one, or multiple contiguous matches in O(log n).
  const sortedCompactIds = blocks
    .map((block) => ({ compact: compactId(block.id), id: block.id }))
    .filter((entry) => HEX_ID_RE.test(entry.compact))
    .sort((a, b) => a.compact < b.compact ? -1 : a.compact > b.compact ? 1 : 0);
  const lowerBound = (prefix: string): number => {
    let low = 0;
    let high = sortedCompactIds.length;
    while (low < high) {
      const mid = low + Math.floor((high - low) / 2);
      if (sortedCompactIds[mid].compact < prefix) low = mid + 1;
      else high = mid;
    }
    return low;
  };

  const inbound = new Map<string, Set<string>>();
  const ambiguous = new Set<string>();

  const canonicalize = (rawTarget: string): string | null => {
    const target = rawTarget.trim();
    if (!target) return null;

    // Page names win before hex classification: 2026-08-11 compacts to valid
    // hex but is first and foremost a real page name.
    const pageKey = getSectionKey(target);
    const pageId = pageByName.get(pageKey);
    if (pageId) return pageId;

    const exactId = fullIdByLower.get(target.toLowerCase());
    if (exactId) return exactId;

    const compact = compactId(target);
    const exactCompactId = compactIdToFull.get(compact);
    if (exactCompactId) return exactCompactId;

    if (compact.length >= MIN_ID_PREFIX_LENGTH && HEX_ID_RE.test(compact)) {
      const first = lowerBound(compact);
      if (!sortedCompactIds[first]?.compact.startsWith(compact)) return null;
      if (sortedCompactIds[first + 1]?.compact.startsWith(compact)) {
        ambiguous.add(target);
        return null;
      }
      return sortedCompactIds[first].id;
    }

    // Preserve unresolved page-name references as a namespaced key. If a page
    // is later created, the next full rebuild promotes them to its block id.
    return `page:${pageKey}`;
  };

  for (const source of blocks) {
    if (!source.content.includes('[[')) continue;
    const sourceTargets = new Set<string>();
    for (const target of extractWikilinkTargets(source.content, 'nested')) {
      const canonical = canonicalize(target);
      if (canonical) sourceTargets.add(canonical);
    }
    for (const canonical of sourceTargets) {
      let sources = inbound.get(canonical);
      if (!sources) {
        sources = new Set();
        inbound.set(canonical, sources);
      }
      sources.add(source.id);
    }
  }

  const snapshot = new Map([...inbound].map(([key, sourceIds]) => [key, [...sourceIds]]));
  const ambiguousTargets = [...ambiguous];
  return {
    referencing(targetKey: string): string[] {
      return [...(snapshot.get(targetKey) ?? [])];
    },
    get ambiguousTargets(): string[] {
      return [...ambiguousTargets];
    },
  };
}

function yBlockSnapshot(id: string, value: unknown): BacklinkBlock | null {
  if (!(value instanceof Y.Map)) return null;
  const childValue = value.get('childIds');
  const childIds = childValue instanceof Y.Array
    ? childValue.toArray().filter((child): child is string => typeof child === 'string')
    : Array.isArray(childValue)
      ? childValue.filter((child): child is string => typeof child === 'string')
      : [];
  const parentId = value.get('parentId');
  const content = value.get('content');
  const createdAt = value.get('createdAt');
  return {
    id,
    parentId: typeof parentId === 'string' ? parentId : null,
    childIds,
    content: typeof content === 'string' ? content : '',
    createdAt: typeof createdAt === 'number' ? createdAt : 0,
  };
}

function buildFromDoc(doc: Y.Doc): BacklinkIndex {
  const blocks: BacklinkBlock[] = [];
  doc.getMap('blocks').forEach((value, id) => {
    const block = yBlockSnapshot(id, value);
    if (block) blocks.push(block);
  });
  return buildBacklinkIndex(blocks, doc.getArray<string>('rootIds').toArray());
}

/**
 * Observe the local Y.Doc and publish complete rAF-coalesced index snapshots.
 * Pass a doc/options only for isolated tests; production uses the shared doc.
 */
export function createBacklinkIndex(
  doc: Y.Doc = getSharedDoc(),
  options: BacklinkIndexOptions = {},
): { index: Accessor<BacklinkIndex>; dispose: () => void } {
  const requestFrame = options.requestFrame
    ?? ((callback: FrameRequestCallback) => requestAnimationFrame(callback));
  const cancelFrame = options.cancelFrame
    ?? ((handle: number) => cancelAnimationFrame(handle));
  const initial = buildFromDoc(doc);
  options.onBuild?.(initial);
  const [index, setIndex] = createSignal(initial, { equals: false });
  const blocksMap = doc.getMap('blocks');
  const rootIds = doc.getArray<string>('rootIds');
  let frameHandle: number | null = null;
  let disposed = false;

  const rebuild = (): void => {
    frameHandle = null;
    if (disposed) return;
    const next = buildFromDoc(doc);
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
      if (event.path.length >= 2) return event.path[1] === 'childIds';
      if (!(event instanceof Y.YMapEvent)) return false;
      return [...event.changes.keys.keys()].some((key) =>
        key === 'content' || key === 'parentId' || key === 'childIds' || key === 'createdAt'
      );
    });
    if (relevant) markDirty();
  };
  const observeRootIds = (): void => markDirty();

  blocksMap.observeDeep(observeBlocks);
  rootIds.observe(observeRootIds);

  return {
    index,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      blocksMap.unobserveDeep(observeBlocks);
      rootIds.unobserve(observeRootIds);
      if (frameHandle !== null) {
        cancelFrame(frameHandle);
        frameHandle = null;
      }
    },
  };
}
