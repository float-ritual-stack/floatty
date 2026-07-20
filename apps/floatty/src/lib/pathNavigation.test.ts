/**
 * Path-addressing navigation tests (ADR-008, FLO-474 + mkdir-p D3 rewrite).
 *
 * Two layers:
 *   1. resolveWikilinkPath — the pure descendant walk + deterministic scoring
 *      (rung → depth → recency → oldest-createdAt). Store-first: the block
 *      store is a synthetic tree, findPage is the REAL predicate reading it.
 *      Unchanged by mkdir-p — the resolver still reports `unresolvedTail`; the
 *      create side lives entirely in navigateWikilinkPath.
 *   2. navigateWikilinkPath / handleChirpNavigate funnel branch — the mkdir-p
 *      CREATE policy (ADR-008 Decision 3, rewritten 2026-07-19): a multi-segment
 *      click fuzzy-resolves the frontier, then CREATES the unresolved tail
 *      exactly-as-written (direct-child chain, one batch tx, origin 'user'),
 *      then navigates to the destination. Segment-1 miss creates the page too.
 *      Malformed/opaque paths keep the old single-string page behavior.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Block } from './blockTypes';
import type { BatchBlockOp } from '../hooks/useBlockStore';

// ── Synthetic tree (no PII) ─────────────────────────────────────────────────
// pages:: → Demo Alpha ┬─ Section B → Digest 0000 → Deferred   (skip target)
//                      ├─ Section C
//                      ├─ Notes(shallow) → Notes(deep)          (depth proximity)
//                      ├─ Recent Twin(old) / Recent Twin(new)   (recency)
//                      └─ Age Twin(old)   / Age Twin(new)       (oldest-createdAt)
//
// MUTABLE: the mkdir-p tests create pages + tail chains into TREE, so it is
// rebuilt fresh per test (beforeEach). The resolveWikilinkPath tests never
// mutate, so a fresh tree each run is harmless to them.
function b(
  id: string,
  content: string,
  parentId: string | null,
  childIds: string[],
  createdAt: number,
  updatedAt: number,
): Block {
  return {
    id,
    parentId,
    childIds,
    content,
    type: 'text',
    collapsed: false,
    createdAt,
    updatedAt,
  };
}

function freshTree(): Record<string, Block> {
  return {
    root: b('root', 'pages::', null, ['pageAlpha'], 10, 10),
    pageAlpha: b(
      'pageAlpha',
      '# Demo Alpha',
      'root',
      ['secB', 'secC', 'bodyScan', 'notesShallow', 'recentOld', 'recentNew', 'ageOld', 'ageNew'],
      100,
      100,
    ),
    secB: b('secB', '## Section B', 'pageAlpha', ['digest'], 200, 200),
    bodyScan: b('bodyScan', '## 3D Body Scan investigations', 'pageAlpha', [], 220, 220),
    digest: b('digest', '# Digest 0000', 'secB', ['deferred'], 250, 250),
    deferred: b('deferred', '## Deferred', 'digest', [], 300, 300),
    secC: b('secC', '## Section C', 'pageAlpha', [], 210, 210),
    notesShallow: b('notesShallow', '## Notes', 'pageAlpha', ['notesDeep'], 400, 400),
    notesDeep: b('notesDeep', '## Notes', 'notesShallow', [], 350, 500),
    recentOld: b('recentOld', '## Recent Twin', 'pageAlpha', [], 100, 100),
    recentNew: b('recentNew', '## Recent Twin', 'pageAlpha', [], 900, 900),
    ageOld: b('ageOld', '## Age Twin', 'pageAlpha', [], 100, 500),
    ageNew: b('ageNew', '## Age Twin', 'pageAlpha', [], 900, 500),
  };
}

let TREE: Record<string, Block>;
let genCounter = 0;

/** First block whose content matches exactly — created contents are unique. */
function findByContent(content: string): Block | undefined {
  return Object.values(TREE).find((bl) => bl.content === content);
}

/**
 * mkdir-p create mock — mirrors the real `batchCreateBlocksInside`: walks the
 * nested BatchBlockOp chain, appending ONE child per level into TREE, returning
 * the top-level ids. Fresh blocks get monotonically-increasing timestamps.
 */
function mockBatchCreateInside(parentId: string, ops: BatchBlockOp[]): string[] {
  if (!TREE[parentId]) return [];
  const topIds: string[] = [];
  const createOp = (pid: string, op: BatchBlockOp): string => {
    const id = `gen-${++genCounter}`;
    const ts = 1000 + genCounter;
    TREE[id] = b(id, op.content, pid, [], ts, ts);
    TREE[pid] = { ...TREE[pid], childIds: [...TREE[pid].childIds, id] };
    if (op.children) for (const child of op.children) createOp(id, child);
    return id;
  };
  for (const op of ops) topIds.push(createOp(parentId, op));
  return topIds;
}

const setFocusedBlockId = vi.fn();
const zoomTo = vi.fn();
const batchSpy = vi.fn((parentId: string, ops: BatchBlockOp[], _origin?: string) =>
  mockBatchCreateInside(parentId, ops),
);

vi.mock('../hooks/useBlockStore', () => ({
  blockStore: {
    getBlock: (id: string) => TREE[id] ?? null,
    // Getters defer TREE access to call-time — a plain `blocks: TREE` property
    // would read TREE at factory-eval time, before it initializes (TDZ), and
    // would never see the beforeEach re-assignment.
    get blocks() {
      return TREE;
    },
    get rootIds() {
      return ['root'];
    },
    batchCreateBlocksInside: (parentId: string, ops: BatchBlockOp[], origin?: string) =>
      batchSpy(parentId, ops, origin),
  },
}));
vi.mock('../hooks/usePaneStore', () => ({
  paneStore: {
    getFloor: () => null,
    getPaneHost: () => ({ kind: 'tab', tabId: 't1' }),
    zoomTo: (...args: unknown[]) => zoomTo(...args),
    setFocusedBlockId: (...args: unknown[]) => setFocusedBlockId(...args),
    setCollapsed: vi.fn(),
  },
}));
vi.mock('../hooks/usePaneLinkStore', () => ({
  paneLinkStore: { resolveLink: () => null },
}));
vi.mock('../hooks/useLayoutStore', () => ({
  layoutStore: { setActivePaneId: vi.fn(), splitPane: vi.fn() },
  findTabIdByPaneId: () => 't1',
}));
vi.mock('../hooks/useTabStore', () => ({ tabStore: { activeTabId: () => 't1' } }));
// Keep the REAL findPage (it reads the mocked blockStore); spy navigateToPage;
// provide a mutating ensurePage that materializes a `# ${name}` page under root
// (the `pages::` container) via the REAL findPage guard, mirroring production's
// find-or-create. IDs are threaded from creation, never re-resolved by name.
vi.mock('../hooks/useBacklinkNavigation', async (importActual) => {
  const actual = await importActual<typeof import('../hooks/useBacklinkNavigation')>();
  const ensurePage = vi.fn((name: string): Block | null => {
    const existing = actual.findPage(name);
    if (existing) return existing;
    const id = `page-${++genCounter}`;
    const ts = 1000 + genCounter;
    TREE[id] = b(id, `# ${name}`, 'root', [], ts, ts);
    TREE.root = { ...TREE.root, childIds: [...TREE.root.childIds, id] };
    return TREE[id];
  });
  return { ...actual, navigateToPage: vi.fn(), ensurePage };
});
vi.mock('./logger', () => ({
  createLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  resolveWikilinkPath,
  navigateWikilinkPath,
  handleChirpNavigate,
  navigateToPage,
} from './navigation';
import {
  navigateToPage as navigateToPageImplMock,
  ensurePage as ensurePageMock,
} from '../hooks/useBacklinkNavigation';
import { matchFuzzy } from './pathMatcher';
import { getPageTitle } from './pageTitle';
import corpusRaw from './__fixtures__/path-grammar.json?raw';

beforeEach(() => {
  TREE = freshTree();
  genCounter = 0;
  setFocusedBlockId.mockClear();
  zoomTo.mockClear();
  batchSpy.mockClear();
  (ensurePageMock as ReturnType<typeof vi.fn>).mockClear();
  // The impl returns a NavigationResult; the funnel's navigateToPage reads
  // `.success` on it, so give the spy a valid shape.
  (navigateToPageImplMock as ReturnType<typeof vi.fn>).mockReset().mockReturnValue({
    success: true,
    pageId: 'pageAlpha',
    focusTargetId: null,
    targetPaneId: 'p1',
    created: false,
  });
});

describe('resolveWikilinkPath — descendant walk + scoring', () => {
  it('resolves an exact three-segment chain, skipping an intermediate', () => {
    // "Demo Alpha > Section B > Deferred" skips "Digest 0000".
    const r = resolveWikilinkPath(['Demo Alpha', 'Section B', 'Deferred']);
    expect(r).toEqual({ blockId: 'deferred', resolvedDepth: 3, unresolvedTail: [] });
  });

  it('skips levels: a deep descendant resolves directly under the page', () => {
    // "Demo Alpha > Deferred" — Deferred is 3 levels down, reached in one hop.
    const r = resolveWikilinkPath(['Demo Alpha', 'Deferred']);
    expect(r).toEqual({ blockId: 'deferred', resolvedDepth: 2, unresolvedTail: [] });
  });

  it('fuzzy rung 3 (contains) matches a longer heading', () => {
    // FLO-474 canonical shape: "3D Body" contains-matches "## 3D Body Scan
    // investigations" (rung 3). No other candidate contains "3d body".
    const r = resolveWikilinkPath(['Demo Alpha', '3D Body']);
    expect(r.blockId).toBe('bodyScan');
    expect(r.resolvedDepth).toBe(2);
  });

  it('depth proximity beats recency: shallower Notes wins over newer deeper Notes', () => {
    // notesShallow(depth 1, updatedAt 400) vs notesDeep(depth 2, updatedAt 500).
    const r = resolveWikilinkPath(['Demo Alpha', 'Notes']);
    expect(r.blockId).toBe('notesShallow');
  });

  it('recency breaks a same-rung same-depth tie (newer updatedAt wins)', () => {
    // recentOld(updatedAt 100) vs recentNew(updatedAt 900) — both depth 1, rung 1.
    const r = resolveWikilinkPath(['Demo Alpha', 'Recent Twin']);
    expect(r.blockId).toBe('recentNew');
  });

  it('oldest createdAt is the final tie-break (equal rung/depth/updatedAt)', () => {
    // ageOld(createdAt 100) vs ageNew(createdAt 900) — both depth 1, rung 1, updatedAt 500.
    const r = resolveWikilinkPath(['Demo Alpha', 'Age Twin']);
    expect(r.blockId).toBe('ageOld');
  });

  it('partial miss reports the deepest resolved segment + the unresolved tail', () => {
    // resolveWikilinkPath is a pure READ — it still reports the tail. mkdir-p
    // creation is navigateWikilinkPath's job, not the resolver's.
    const r = resolveWikilinkPath(['Demo Alpha', 'Section B', 'zzz-absent']);
    expect(r).toEqual({ blockId: 'secB', resolvedDepth: 2, unresolvedTail: ['zzz-absent'] });
  });

  it('page (segment 1) miss returns null — never resolves to a block', () => {
    const r = resolveWikilinkPath(['No Such Page', 'Section B']);
    expect(r).toEqual({
      blockId: null,
      resolvedDepth: 0,
      unresolvedTail: ['No Such Page', 'Section B'],
    });
  });
});

describe('navigateWikilinkPath — mkdir-p create policy (ADR-008 D3 rewrite)', () => {
  it('full resolution navigates to the leaf block — no creation', () => {
    const res = navigateWikilinkPath(['Demo Alpha', 'Section B', 'Deferred'], { paneId: 'p1' });
    expect(res.success).toBe(true);
    // navigateToBlock focuses the actual destination block in the target pane.
    expect(setFocusedBlockId).toHaveBeenCalledWith('p1', 'deferred');
    expect(batchSpy).not.toHaveBeenCalled();
    expect(ensurePageMock).not.toHaveBeenCalled();
  });

  // FLIPPED (was "partial miss still navigates to the deepest resolved block",
  // no creation). ADR-008 D3 rewrite: a partial-miss click now SCAFFOLDS the
  // unresolved tail under the deepest resolved block and lands on the new leaf.
  it('partial miss scaffolds the unresolved tail and lands on the created leaf', () => {
    const res = navigateWikilinkPath(['Demo Alpha', 'Section B', 'zzz'], { paneId: 'p1' });
    expect(res.success).toBe(true);

    const created = findByContent('zzz');
    expect(created).toBeDefined();
    // Content is exactly-as-written (no heading prefix, no canonicalization).
    expect(created!.content).toBe('zzz');
    // Direct child of the deepest resolved block (secB), not a page.
    expect(created!.parentId).toBe('secB');
    // Lands on the newly-created destination.
    expect(setFocusedBlockId).toHaveBeenCalledWith('p1', created!.id);
    // ONE batch transaction, origin 'user' (single undo step + normal sync).
    expect(batchSpy).toHaveBeenCalledTimes(1);
    expect(batchSpy.mock.calls[0][0]).toBe('secB');
    expect(batchSpy.mock.calls[0][2]).toBe('user');
  });

  it('multi-segment tail is a direct-child chain, contents exactly-as-written', () => {
    const res = navigateWikilinkPath(
      ['Demo Alpha', 'Section B', 'doesnt', 'also doesnt', 'destination'],
      { paneId: 'p1' },
    );
    expect(res.success).toBe(true);

    const a = findByContent('doesnt');
    const bb = findByContent('also doesnt');
    const dest = findByContent('destination');
    expect(a && bb && dest).toBeTruthy();
    // Chain parentage: secB → doesnt → also doesnt → destination.
    expect(a!.parentId).toBe('secB');
    expect(bb!.parentId).toBe(a!.id);
    expect(dest!.parentId).toBe(bb!.id);
    // Lands on the deepest (destination) segment.
    expect(setFocusedBlockId).toHaveBeenCalledWith('p1', dest!.id);
    // Whole chain in ONE batch transaction (single undo step), origin 'user'.
    expect(batchSpy).toHaveBeenCalledTimes(1);
    expect(batchSpy.mock.calls[0][2]).toBe('user');
  });

  // FLIPPED (was "page miss is a no-op: no navigation, no page created"). ADR-008
  // D3 rewrite: a segment-1 miss now CREATES the page (find-or-create path) AND
  // scaffolds the tail under it — every click succeeds.
  it('segment-1 miss creates the page and scaffolds the tail under it', () => {
    const res = navigateWikilinkPath(['Brand New Page', 'alpha', 'beta'], { paneId: 'p1' });
    expect(res.success).toBe(true);

    // Page created via the find-or-create path (ensurePage), under pages:: (root).
    expect(ensurePageMock).toHaveBeenCalledWith('Brand New Page');
    const page = findByContent('# Brand New Page');
    expect(page).toBeDefined();
    expect(page!.parentId).toBe('root');

    // Tail chain under the new page: page → alpha → beta.
    const alpha = findByContent('alpha');
    const beta = findByContent('beta');
    expect(alpha!.parentId).toBe(page!.id);
    expect(beta!.parentId).toBe(alpha!.id);

    // Lands on the destination (beta). Junk-page-via-navigateToPage NOT used —
    // creation flows through ensurePage, not the single-segment page path.
    expect(setFocusedBlockId).toHaveBeenCalledWith('p1', beta!.id);
    expect(navigateToPageImplMock).not.toHaveBeenCalled();
    expect(batchSpy).toHaveBeenCalledTimes(1);
  });

  it('date-shaped segment-1 pre-scaffolds a future daily note (page named YYYY-MM-DD)', () => {
    const res = navigateWikilinkPath(['2026-07-20', 'x'], { paneId: 'p1' });
    expect(res.success).toBe(true);

    // The created page carries the date title, so the daily-note resolver /
    // findPage match it later — a daily note pre-scaffolded for free.
    const page = findByContent('# 2026-07-20');
    expect(page).toBeDefined();
    expect(page!.parentId).toBe('root');

    const x = findByContent('x');
    expect(x!.parentId).toBe(page!.id);
    expect(setFocusedBlockId).toHaveBeenCalledWith('p1', x!.id);
  });

  it('re-clicking an already-scaffolded path creates nothing new (idempotent)', () => {
    // First click scaffolds Fresh Page → alpha → beta.
    navigateWikilinkPath(['Fresh Page', 'alpha', 'beta'], { paneId: 'p1' });
    const beta = findByContent('beta');
    expect(beta).toBeDefined();
    expect(batchSpy).toHaveBeenCalledTimes(1);
    const sizeAfterFirst = Object.keys(TREE).length;

    setFocusedBlockId.mockClear();

    // Second identical click: resolveWikilinkPath now FINDS the whole path
    // (fuzzy ladder, no duplication) → full resolution → no creation.
    const res = navigateWikilinkPath(['Fresh Page', 'alpha', 'beta'], { paneId: 'p1' });
    expect(res.success).toBe(true);
    expect(setFocusedBlockId).toHaveBeenCalledWith('p1', beta!.id);
    expect(batchSpy).toHaveBeenCalledTimes(1); // still 1 — nothing created
    expect(ensurePageMock).toHaveBeenCalledTimes(1); // page not re-created
    expect(Object.keys(TREE).length).toBe(sizeAfterFirst); // no new blocks
  });

  it('the fuzzy ladder absorbs case variance — a case-differing re-click finds, not duplicates', () => {
    navigateWikilinkPath(['Fresh Page', 'alpha'], { paneId: 'p1' });
    const alpha = findByContent('alpha');
    expect(batchSpy).toHaveBeenCalledTimes(1);
    const sizeAfterFirst = Object.keys(TREE).length;

    setFocusedBlockId.mockClear();

    // Different case on BOTH the page and the segment → still resolves to the
    // same blocks (canonicalized rung-1 match), no duplicate scaffolding.
    const res = navigateWikilinkPath(['fresh page', 'ALPHA'], { paneId: 'p1' });
    expect(res.success).toBe(true);
    expect(setFocusedBlockId).toHaveBeenCalledWith('p1', alpha!.id);
    expect(batchSpy).toHaveBeenCalledTimes(1);
    expect(Object.keys(TREE).length).toBe(sizeAfterFirst);
  });
});

describe('navigateToPage — choke point routes multi-segment to mkdir-p', () => {
  // Regression for the live-QA escape: Terminal wikilink clicks and ⌘Enter on a
  // [[link]] call navigateToPage DIRECTLY (not through the guarded handlers), so
  // a raw "this > is > a > test" string reached find-or-create and minted a junk
  // page. The guard now lives INSIDE navigateToPage — every ingress is covered.
  it('routes a multi-segment target to the path handler — never mints a " > " page', () => {
    const res = navigateToPage('this > is > a > test', { paneId: 'p1' });
    expect(res.success).toBe(true);

    // THE bug: no page (or any block) named with the raw path string.
    expect(findByContent('# this > is > a > test')).toBeUndefined();
    expect(Object.values(TREE).some((bl) => bl.content.includes(' > '))).toBe(false);
    // The find-or-create page path was NOT the ingress for a multi-segment target.
    expect(navigateToPageImplMock).not.toHaveBeenCalled();

    // Scaffolded the real structure: page "this" → is → a → test, landed on "test".
    expect(findByContent('# this')).toBeDefined();
    const test = findByContent('test');
    expect(test).toBeDefined();
    expect(test!.content).toBe('test'); // exactly-as-written, no heading prefix
    expect(setFocusedBlockId).toHaveBeenCalledWith('p1', test!.id);
    expect(batchSpy).toHaveBeenCalledTimes(1);
  });

  it('single-segment target still uses the normal page find-or-create (unchanged)', () => {
    navigateToPage('Solo Page', { paneId: 'p1' });
    expect(navigateToPageImplMock).toHaveBeenCalledTimes(1);
    expect((navigateToPageImplMock as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('Solo Page');
    expect(batchSpy).not.toHaveBeenCalled();
    expect(ensurePageMock).not.toHaveBeenCalled();
  });

  it('malformed/opaque target keeps single-string find-or-create — no mkdir-p split', () => {
    // "a > b >" (trailing empty segment) → parsePathSegments collapses to one
    // opaque segment → normal page path, not the scaffold.
    navigateToPage('a > b >', { paneId: 'p1' });
    expect(navigateToPageImplMock).toHaveBeenCalledTimes(1);
    expect((navigateToPageImplMock as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('a > b >');
    expect(batchSpy).not.toHaveBeenCalled();
    expect(ensurePageMock).not.toHaveBeenCalled();
  });
});

describe('handleChirpNavigate — path branch routing', () => {
  it('routes a fully-resolvable multi-segment target through the path resolver', () => {
    const res = handleChirpNavigate('Demo Alpha > Section B', { sourcePaneId: 'p1' });
    expect(res.success).toBe(true);
    expect(setFocusedBlockId).toHaveBeenCalledWith('p1', 'secB');
    // Full resolution — no creation, no fall-through to page find-or-create.
    expect(batchSpy).not.toHaveBeenCalled();
    expect(navigateToPageImplMock).not.toHaveBeenCalled();
  });

  it('single-segment target still falls through to the page path (unchanged)', () => {
    handleChirpNavigate('Demo Alpha', { sourcePaneId: 'p1' });
    expect(navigateToPageImplMock).toHaveBeenCalledTimes(1);
    expect((navigateToPageImplMock as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('Demo Alpha');
  });

  it('malformed/opaque path keeps old single-string behavior — no split, no mkdir-p', () => {
    // "a > b >" has a trailing empty segment → parsePathSegments returns it as
    // one opaque segment → routes to the single-string page path, NOT the path
    // resolver. No junk OPAQUE page scaffolding.
    handleChirpNavigate('a > b >', { sourcePaneId: 'p1' });
    expect(navigateToPageImplMock).toHaveBeenCalledTimes(1);
    expect((navigateToPageImplMock as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('a > b >');
    expect(batchSpy).not.toHaveBeenCalled();
    expect(ensurePageMock).not.toHaveBeenCalled();
  });
});

describe('resolveWikilinkPath — chain-cycle guard (client/server parity)', () => {
  it('stops before re-adding a chain-cycle block, matching the server walk', () => {
    // Synthetic malformed tree (no PII): pages:: → Page → a → (child back to Page).
    // [[Page > A > Page]]: segment 1 resolves Page, "A" resolves a, then "Page"
    // would resolve the cyclic Page (a's child) — but it is already in the
    // resolution chain, so the walk STOPS at a (deepest = the previous match).
    // Mirrors descendant_walk.rs::cycle_in_chain_terminates_before_readd: the
    // server reports deepest="a", unresolved=["Page"]; the client must agree.
    TREE = {
      root: b('root', 'pages::', null, ['Page'], 10, 10),
      Page: b('Page', 'Page', 'root', ['a'], 100, 100),
      a: b('a', 'A', 'Page', ['Page'], 200, 200), // cycle: a's only child is Page
    };
    const r = resolveWikilinkPath(['Page', 'A', 'Page']);
    expect(r.blockId).toBe('a'); // deepest resolved = the previous match, not the cyclic Page
    expect(r.resolvedDepth).toBe(2); // page(1) + A(1); the cyclic "Page" is NOT counted
    expect(r.unresolvedTail).toEqual(['Page']);
  });
});

// ── Shared walk corpus (coherence finding 7, TS half) ───────────────────────
// The `walk` section of __fixtures__/path-grammar.json drives BOTH the server
// walker (descendant_walk.rs::walk_corpus) and the client resolver here, so the
// ADR-008 D2 cross-level scoring (rung → depth → recency → oldest-createdAt) is
// locked to ONE fixture instead of two hand-authored trees that can drift.
interface WalkNode {
  id: string;
  parent: string | null;
  content: string;
  createdAt: number;
  updatedAt: number;
}
interface WalkCase {
  name: string;
  mode: string;
  root: string;
  segments: string[];
  tree: WalkNode[];
  resolved: boolean;
  termination: string;
  expected: string;
  traceRungs: number[];
  unresolved: string[];
}
const walkCorpus = (JSON.parse(corpusRaw) as { walk: { cases: WalkCase[] } }).walk.cases;

/**
 * Build a mock block store from a walk case: a `pages::` container ('root',
 * matching the mocked `blockStore.rootIds`) whose child is the case's page
 * (`case.root`), then every case node parented as declared. Returns the page
 * NAME (segment 1 for the client resolver, which resolves it via findPage).
 */
function buildWalkTree(c: WalkCase): { tree: Record<string, Block>; pageName: string } {
  const childIdsOf: Record<string, string[]> = {};
  for (const n of c.tree) childIdsOf[n.id] ??= [];
  for (const n of c.tree) if (n.parent) (childIdsOf[n.parent] ??= []).push(n.id);

  const tree: Record<string, Block> = {
    root: b('root', 'pages::', null, [c.root], 10, 10),
  };
  for (const n of c.tree) {
    tree[n.id] = b(n.id, n.content, n.parent ?? 'root', childIdsOf[n.id] ?? [], n.createdAt, n.updatedAt);
  }
  const rootNode = c.tree.find((n) => n.id === c.root)!;
  return { tree, pageName: getPageTitle(rootNode.content) };
}

/**
 * Re-derive each resolved descendant segment's rung. The resolver exposes only
 * the DEEPEST block, so reconstruct the trace via progressively-longer prefixes:
 * segment k resolves against the deepest-so-far independent of later segments
 * (greedy sequential walk), so `resolveWikilinkPath([page, ...segs.slice(0,k)])`
 * lands exactly on the block segment k matched. matchFuzzy is the SAME matcher
 * the resolver uses — this locks per-segment scoring to the fixture WITHOUT
 * changing the protected resolver's return shape. resolvedDepth counts the page
 * as depth 1, so resolved descendants = resolvedDepth - 1.
 */
function clientTraceRungs(pageName: string, descSegments: string[], resolvedDepth: number): number[] {
  const rungs: number[] = [];
  for (let k = 1; k < resolvedDepth; k++) {
    const { blockId } = resolveWikilinkPath([pageName, ...descSegments.slice(0, k)]);
    const block = blockId ? TREE[blockId] : undefined;
    const fm = block
      ? matchFuzzy(descSegments[k - 1], [{ content: block.content, createdAt: block.createdAt }])
      : null;
    if (fm) rungs.push(fm.rung);
  }
  return rungs;
}

describe('resolveWikilinkPath — shared walk corpus (client/server scoring parity)', () => {
  for (const c of walkCorpus) {
    if (c.mode === 'exact') {
      // Skipped ON PURPOSE: the client has NO exact-mode walker — clicks are
      // always fuzzy (level-skipping). Exact mode is the SERVER's write
      // predicate (mkdir-p find-or-create), verified by descendant_walk.rs.
      it.skip(`${c.name} (exact mode — client has no exact walker)`, () => {
        /* client clicks are always fuzzy; exact is the server write predicate */
      });
      continue;
    }
    it(c.name, () => {
      const { tree, pageName } = buildWalkTree(c);
      TREE = tree;
      const r = resolveWikilinkPath([pageName, ...c.segments]);

      // deepest-resolved id — the block the walk reached (corpus `expected`).
      expect(r.blockId).toBe(c.expected);
      // unresolved tail — descendant segments that did NOT resolve.
      expect(r.unresolvedTail).toEqual(c.unresolved);
      // per-segment rungs — same fixture the server asserts via `trace_rungs`.
      expect(clientTraceRungs(pageName, c.segments, r.resolvedDepth)).toEqual(c.traceRungs);
    });
  }
});
