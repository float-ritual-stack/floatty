/**
 * FLO-854 fetch-on-miss tests.
 *
 * When a block-id navigation misses (ghost-writer window: the server has the
 * block, the local Y.Doc doesn't yet), handleChirpNavigate kicks a bounded
 * state-diff pull and retries the navigation once. Driven through the public
 * handleChirpNavigate surface; the pull primitive is mocked — its CRDT
 * semantics are covered in useSyncedYDoc.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mutable block table: ghost blocks "arrive" mid-test (post-pull) ─────────
const ROOT = '11111111-1111-4111-8111-111111111111';
const PARENT = '22222222-2222-4222-8222-222222222222';
const GHOST = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GHOST2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

type FakeBlock = { parentId: string | null; childIds: string[]; content: string };
const BLOCKS: Record<string, FakeBlock> = {};

function seedLocalTree() {
  for (const key of Object.keys(BLOCKS)) delete BLOCKS[key];
  BLOCKS[ROOT] = { parentId: null, childIds: [PARENT], content: 'pages::' };
  BLOCKS[PARENT] = { parentId: ROOT, childIds: [], content: 'a page' };
}

function arriveGhost(id: string) {
  BLOCKS[id] = { parentId: PARENT, childIds: [], content: `ghost ${id.slice(0, 8)}` };
  BLOCKS[PARENT].childIds.push(id);
}

// ── Store mocks (factories run lazily, after these consts initialize) ───────
const zoomTo = vi.fn();
const setFocusedBlockId = vi.fn();
const navigateToPageMock = vi.fn(() => ({ success: true, targetPaneId: 'p1' }));
const pullResolvers: Array<(v: boolean) => void> = [];
const pullRejecters: Array<(e: unknown) => void> = [];
const pullServerDiffNow = vi.fn(
  () =>
    new Promise<boolean>((res, rej) => {
      pullResolvers.push(res);
      pullRejecters.push(rej);
    })
);

vi.mock('../hooks/usePaneStore', () => ({
  paneStore: {
    zoomTo: (...args: unknown[]) => zoomTo(...args),
    setFocusedBlockId: (...args: unknown[]) => setFocusedBlockId(...args),
    setCollapsed: vi.fn(),
    getFloor: () => null,
    getPaneHost: () => ({ kind: 'tab', tabId: 't1' }),
  },
}));
vi.mock('../hooks/useBlockStore', () => ({
  blockStore: {
    // Getter defers the reference until access — the factory itself runs
    // during hoisted import resolution, before top-level consts initialize.
    get blocks() {
      return BLOCKS;
    },
    getBlock: (id: string) => BLOCKS[id] ?? null,
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
vi.mock('../hooks/useBacklinkNavigation', () => ({
  navigateToPage: (...args: unknown[]) => navigateToPageMock(...args),
  findPage: vi.fn(),
  ensurePage: vi.fn(),
}));
vi.mock('../hooks/useSyncedYDoc', () => ({
  pullServerDiffNow: () => pullServerDiffNow(),
}));
vi.mock('./logger', () => ({
  createLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { handleChirpNavigate, resetFetchOnMissState } from './navigation';

/** Flush the microtask chain (and 0ms timers) under fake timers. */
async function flush() {
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  seedLocalTree();
  zoomTo.mockClear();
  setFocusedBlockId.mockClear();
  navigateToPageMock.mockClear();
  pullServerDiffNow.mockClear();
  pullResolvers.length = 0;
  pullRejecters.length = 0;
  resetFetchOnMissState();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('handleChirpNavigate fetch-on-miss (FLO-854)', () => {
  it('branch A (full UUID, type block): returns pending, pulls, lands after arrival', async () => {
    const r = handleChirpNavigate(GHOST, { type: 'block', sourcePaneId: 'p1' });

    expect(r.success).toBe(false);
    expect(r.pending).toBe(true);
    expect(pullServerDiffNow).toHaveBeenCalledTimes(1);
    expect(zoomTo).not.toHaveBeenCalled();

    arriveGhost(GHOST);
    pullResolvers[0](true);
    await flush();

    expect(setFocusedBlockId).toHaveBeenCalledWith('p1', GHOST);
    expect(zoomTo).toHaveBeenCalledTimes(1);
  });

  it('branch B (short hash, type wikilink): re-resolves the prefix after the pull', async () => {
    const r = handleChirpNavigate('aaaaaaaa', { type: 'wikilink', sourcePaneId: 'p1' });

    expect(r.success).toBe(false);
    expect(r.pending).toBe(true);
    expect(pullServerDiffNow).toHaveBeenCalledTimes(1);

    arriveGhost(GHOST);
    pullResolvers[0](true);
    await flush();

    // The 8-char prefix resolved to the full UUID that arrived with the pull
    expect(setFocusedBlockId).toHaveBeenCalledWith('p1', GHOST);
  });

  it('still lands when the pull applied nothing but the block arrived via WS meanwhile', async () => {
    handleChirpNavigate(GHOST, { type: 'block', sourcePaneId: 'p1' });

    // WS broadcast wins the race; the diff comes back empty (applied=false)
    arriveGhost(GHOST);
    pullResolvers[0](false);
    await flush();

    expect(setFocusedBlockId).toHaveBeenCalledWith('p1', GHOST);
  });

  it('does not navigate when the block is absent server-side too', async () => {
    handleChirpNavigate(GHOST, { type: 'block', sourcePaneId: 'p1' });

    pullResolvers[0](true); // pull applied ops, but the ghost never arrives
    await flush();

    expect(zoomTo).not.toHaveBeenCalled();
    expect(setFocusedBlockId).not.toHaveBeenCalled();
  });

  it('concurrent misses share one in-flight pull', async () => {
    handleChirpNavigate(GHOST, { type: 'block', sourcePaneId: 'p1' });
    handleChirpNavigate(GHOST2, { type: 'block', sourcePaneId: 'p1' });

    expect(pullServerDiffNow).toHaveBeenCalledTimes(1);

    arriveGhost(GHOST);
    arriveGhost(GHOST2);
    pullResolvers[0](true);
    await flush();

    expect(setFocusedBlockId).toHaveBeenCalledWith('p1', GHOST);
    expect(setFocusedBlockId).toHaveBeenCalledWith('p1', GHOST2);
  });

  it('per-target cooldown: suppresses re-pull for the same target, not others', async () => {
    handleChirpNavigate(GHOST, { type: 'block', sourcePaneId: 'p1' });
    pullResolvers[0](true); // completes, ghost still missing → cooldown for GHOST
    await flush();
    expect(pullServerDiffNow).toHaveBeenCalledTimes(1);

    // Same target inside the cooldown window → no new pull
    handleChirpNavigate(GHOST, { type: 'block', sourcePaneId: 'p1' });
    expect(pullServerDiffNow).toHaveBeenCalledTimes(1);

    // Different target → pull allowed
    handleChirpNavigate(GHOST2, { type: 'block', sourcePaneId: 'p1' });
    expect(pullServerDiffNow).toHaveBeenCalledTimes(2);
    pullResolvers[1](true);
    await flush();

    // Cooldown expires → same target pulls again
    await vi.advanceTimersByTimeAsync(5001);
    handleChirpNavigate(GHOST, { type: 'block', sourcePaneId: 'p1' });
    expect(pullServerDiffNow).toHaveBeenCalledTimes(3);
  });

  it('abandons the retry when the pull outlives the timeout (no surprise navigation)', async () => {
    handleChirpNavigate(GHOST, { type: 'block', sourcePaneId: 'p1' });

    await vi.advanceTimersByTimeAsync(3000); // timeout fires, retry abandoned

    arriveGhost(GHOST);
    pullResolvers[0](true); // pull completes late
    await flush();

    expect(zoomTo).not.toHaveBeenCalled();
    expect(setFocusedBlockId).not.toHaveBeenCalled();
  });

  it('a rejected pull is caught (no navigation, no unhandled rejection)', async () => {
    handleChirpNavigate(GHOST, { type: 'block', sourcePaneId: 'p1' });

    pullRejecters[0](new Error('server unreachable'));
    await flush();

    expect(zoomTo).not.toHaveBeenCalled();
  });

  it('page-name targets never trigger a pull', () => {
    handleChirpNavigate('Some Page', { type: 'wikilink', sourcePaneId: 'p1' });

    expect(pullServerDiffNow).not.toHaveBeenCalled();
    expect(navigateToPageMock).toHaveBeenCalled();
  });

  it('local hits navigate immediately without a pull', () => {
    const r = handleChirpNavigate(PARENT, { type: 'block', sourcePaneId: 'p1' });

    expect(r.success).toBe(true);
    expect(r.pending).toBeUndefined();
    expect(pullServerDiffNow).not.toHaveBeenCalled();
  });
});
