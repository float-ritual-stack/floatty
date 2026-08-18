/**
 * Refresh-on-arrival tests ([[FLO-895]]).
 *
 * [[FLO-854]] fetch-on-miss pulls when a navigation target ISN'T here. That
 * cannot help the common agent workflow: something updates a block you already
 * have, tells you, and you click. The block resolves locally, navigation
 * succeeds, and you are shown the version you had — nothing was missing, so
 * nothing was pulled, and the correction waits for the 120s health poll.
 *
 * These cover the other half: landing on something that DOES exist also pulls,
 * without making the click wait for the network.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const ROOT = '11111111-1111-4111-8111-111111111111';
const PARENT = '22222222-2222-4222-8222-222222222222';

type FakeBlock = { parentId: string | null; childIds: string[]; content: string };
const BLOCKS: Record<string, FakeBlock> = {};

function seedLocalTree() {
  for (const key of Object.keys(BLOCKS)) delete BLOCKS[key];
  BLOCKS[ROOT] = { parentId: null, childIds: [PARENT], content: 'pages::' };
  BLOCKS[PARENT] = { parentId: ROOT, childIds: [], content: 'a page' };
}

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

import { navigateToBlock, navigateToPage, resetFetchOnMissState } from './navigation';

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

describe('refresh-on-arrival', () => {
  it('pulls when landing on a block that already exists locally', () => {
    // The whole point: no miss occurs here, so fetch-on-miss stays silent.
    const r = navigateToBlock(PARENT, { paneId: 'p1' });

    expect(r.success).toBe(true);
    expect(pullServerDiffNow).toHaveBeenCalledTimes(1);
  });

  it('does not make the click wait for the network', () => {
    // Navigation must complete synchronously with whatever we have. The pull
    // is still unresolved here; the block re-renders when it lands.
    const r = navigateToBlock(PARENT, { paneId: 'p1' });

    expect(r.success).toBe(true);
    expect(zoomTo).toHaveBeenCalled();
    expect(pullResolvers).toHaveLength(1); // still in flight
  });

  it('pulls when landing on an existing page', () => {
    const r = navigateToPage('a page', { paneId: 'p1' });

    expect(r.success).toBe(true);
    expect(pullServerDiffNow).toHaveBeenCalledTimes(1);
  });

  it('does not pull when the page navigation failed', () => {
    navigateToPageMock.mockReturnValueOnce({ success: false, targetPaneId: null } as never);

    navigateToPage('nope', { paneId: 'p1' });

    expect(pullServerDiffNow).not.toHaveBeenCalled();
  });

  it('does not pull for a block that is not here — that is fetch-on-miss territory', () => {
    navigateToBlock('cccccccc-cccc-4ccc-8ccc-cccccccccccc', { paneId: 'p1' });

    expect(pullServerDiffNow).not.toHaveBeenCalled();
  });

  it('coalesces rapid navigations into one pull', async () => {
    // Walking a backlink list must not fire a request per click.
    navigateToBlock(PARENT, { paneId: 'p1' });
    navigateToBlock(ROOT, { paneId: 'p1' });
    navigateToPage('a page', { paneId: 'p1' });
    await flush();

    expect(pullServerDiffNow).toHaveBeenCalledTimes(1);
  });

  it('pulls again once the cooldown expires', async () => {
    navigateToBlock(PARENT, { paneId: 'p1' });
    pullResolvers[0](true);
    await flush();

    await vi.advanceTimersByTimeAsync(11_000);
    navigateToBlock(PARENT, { paneId: 'p1' });

    expect(pullServerDiffNow).toHaveBeenCalledTimes(2);
  });

  it('survives a failing pull without breaking navigation', async () => {
    const r = navigateToBlock(PARENT, { paneId: 'p1' });
    expect(r.success).toBe(true);

    pullRejecters[0](new Error('offline'));
    await flush();

    // A later navigation still works and still tries again after cooldown.
    await vi.advanceTimersByTimeAsync(11_000);
    expect(navigateToBlock(PARENT, { paneId: 'p1' }).success).toBe(true);
    expect(pullServerDiffNow).toHaveBeenCalledTimes(2);
  });

  it('shares one in-flight pull with fetch-on-miss', async () => {
    // An arrival and a miss in the same moment must not open two requests.
    navigateToBlock(PARENT, { paneId: 'p1' });
    navigateToBlock('dddddddd-dddd-4ddd-8ddd-dddddddddddd', { paneId: 'p1' });
    await flush();

    expect(pullServerDiffNow).toHaveBeenCalledTimes(1);
  });
});
