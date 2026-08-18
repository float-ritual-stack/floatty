/**
 * FLO-895 nav-drift probe tests.
 *
 * The probe compares three views of a block on arrival — what the store
 * renders, what the local Y.Doc holds, what the server says — and blames a
 * layer. These tests cover every row of that verdict table plus the guards,
 * because the probe's whole value is that its verdict is trustworthy: it is
 * what decides which of the abandoned branch's fixes get re-derived.
 *
 * Driven through the public navigateToBlock surface. The two repair primitives
 * are mocked — `pullServerDiffNow`'s CRDT semantics live in
 * useSyncedYDoc.test.ts, `refreshBlockFromDoc`'s in useBlockStore's suite.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const BLOCK = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PARENT = '22222222-2222-4222-8222-222222222222';
const ROOT = '11111111-1111-4111-8111-111111111111';

type FakeBlock = {
  id: string;
  parentId: string | null;
  childIds: string[];
  content: string;
  updatedAt: number;
};

const BLOCKS: Record<string, FakeBlock> = {};
/** Stands in for the Y.Doc's blocks map — deliberately separate from BLOCKS. */
const DOC: Record<string, { content: string } | undefined> = {};

function seed(storeContent: string, docContent: string, storeUpdatedAt = 1000) {
  for (const key of Object.keys(BLOCKS)) delete BLOCKS[key];
  for (const key of Object.keys(DOC)) delete DOC[key];
  BLOCKS[ROOT] = { id: ROOT, parentId: null, childIds: [PARENT], content: 'pages::', updatedAt: 1 };
  BLOCKS[PARENT] = { id: PARENT, parentId: ROOT, childIds: [BLOCK], content: 'a page', updatedAt: 1 };
  BLOCKS[BLOCK] = {
    id: BLOCK,
    parentId: PARENT,
    childIds: [],
    content: storeContent,
    updatedAt: storeUpdatedAt,
  };
  DOC[BLOCK] = { content: docContent };
}

// ── Mocks (factories run lazily, after these consts initialize) ─────────────
const refreshBlockFromDoc = vi.fn((id: string) => {
  const docBlock = DOC[id];
  if (!docBlock) return false;
  BLOCKS[id].content = docBlock.content;
  return true;
});
const pullServerDiffNow = vi.fn(async () => true);
const getBlockSnapshot = vi.fn(
  async (_id: string): Promise<{ id: string; content: string; updatedAt: number } | null> => null
);
const clientInitialized = { value: true };
const warn = vi.fn();
const info = vi.fn();

vi.mock('../hooks/usePaneStore', () => ({
  paneStore: {
    zoomTo: vi.fn(),
    setFocusedBlockId: vi.fn(),
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
    refreshBlockFromDoc: (id: string) => refreshBlockFromDoc(id),
  },
  getValue: (obj: unknown, key: string) => (obj as Record<string, unknown>)?.[key],
}));
vi.mock('../hooks/usePaneLinkStore', () => ({ paneLinkStore: { resolveLink: () => null } }));
vi.mock('../hooks/useLayoutStore', () => ({
  layoutStore: { setActivePaneId: vi.fn(), splitPane: vi.fn() },
  findTabIdByPaneId: () => 't1',
}));
vi.mock('../hooks/useTabStore', () => ({ tabStore: { activeTabId: () => 't1' } }));
vi.mock('../hooks/useBacklinkNavigation', () => ({
  navigateToPage: vi.fn(() => ({ success: true, targetPaneId: 'p1' })),
  findPage: vi.fn(),
  ensurePage: vi.fn(),
}));
vi.mock('../hooks/useSyncedYDoc', () => ({
  pullServerDiffNow: () => pullServerDiffNow(),
  getSharedDoc: () => ({ getMap: () => ({ get: (id: string) => DOC[id] }) }),
}));
vi.mock('./httpClient', () => ({
  getHttpClient: () => ({ getBlockSnapshot: (id: string) => getBlockSnapshot(id) }),
  isClientInitialized: () => clientInitialized.value,
}));
vi.mock('./logger', () => ({
  // Arrow indirection defers the `warn`/`info` reads: createLogger runs during
  // hoisted import resolution (syncDiagnostics calls it at module init), before
  // this file's top-level consts exist. Referencing them directly is a TDZ error.
  createLogger: () => ({
    warn: (...args: unknown[]) => warn(...args),
    info: (...args: unknown[]) => info(...args),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { navigateToBlock, resetNavDriftState } from './navigation';
import { getSyncDiagnostics, resetSyncDiagnostics } from './syncDiagnostics';

/** Let the fire-and-forget probe's promise chain settle. */
async function flush() {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

function nav() {
  navigateToBlock(BLOCK, { paneId: 'p1' });
}

/** The single 'nav-drift detected' call's structured payload. */
function driftLog(): Record<string, unknown> | undefined {
  return warn.mock.calls.find(c => c[0] === 'nav-drift detected')?.[1] as
    | Record<string, unknown>
    | undefined;
}

describe('nav-drift probe', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetNavDriftState();
    resetSyncDiagnostics();
    clientInitialized.value = true;
    getBlockSnapshot.mockResolvedValue(null);
    document.body.innerHTML = '';
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  describe('verdict table', () => {
    it('stays silent when store, doc and server all agree', async () => {
      seed('same', 'same');
      getBlockSnapshot.mockResolvedValue({ id: BLOCK, content: 'same', updatedAt: 2000 });

      nav();
      await flush();

      expect(driftLog()).toBeUndefined();
      expect(refreshBlockFromDoc).not.toHaveBeenCalled();
      expect(pullServerDiffNow).not.toHaveBeenCalled();
    });

    it('blames ydoc-store-drop when the doc is fresh and the store is not', async () => {
      seed('OLD', 'NEW');
      getBlockSnapshot.mockResolvedValue({ id: BLOCK, content: 'NEW', updatedAt: 2000 });

      nav();
      await flush();

      expect(driftLog()).toMatchObject({ blockId: BLOCK, mode: 'ydoc-store-drop' });
      // The doc already holds the truth — repair locally, no network.
      expect(refreshBlockFromDoc).toHaveBeenCalledWith(BLOCK);
      expect(pullServerDiffNow).not.toHaveBeenCalled();
      expect(BLOCKS[BLOCK].content).toBe('NEW');
      expect(getSyncDiagnostics()).toMatchObject({
        navDriftYdocStoreDrops: 1,
        navDriftTransportMisses: 0,
        navDriftRepairs: 1,
      });
    });

    it('blames transport-miss when neither store nor doc has the server content', async () => {
      seed('OLD', 'OLD');
      getBlockSnapshot.mockResolvedValue({ id: BLOCK, content: 'NEW', updatedAt: 2000 });

      nav();
      await flush();

      expect(driftLog()).toMatchObject({ blockId: BLOCK, mode: 'transport-miss' });
      // The doc is genuinely behind — only a merge can fix it.
      expect(pullServerDiffNow).toHaveBeenCalled();
      expect(refreshBlockFromDoc).not.toHaveBeenCalled();
      expect(getSyncDiagnostics()).toMatchObject({
        navDriftTransportMisses: 1,
        navDriftYdocStoreDrops: 0,
        navDriftRepairs: 1,
      });
    });

    it('blames transport-miss when the doc has no entry for the block at all', async () => {
      seed('OLD', 'OLD');
      delete DOC[BLOCK];
      getBlockSnapshot.mockResolvedValue({ id: BLOCK, content: 'NEW', updatedAt: 2000 });

      nav();
      await flush();

      expect(driftLog()).toMatchObject({ mode: 'transport-miss', docLen: null });
      expect(pullServerDiffNow).toHaveBeenCalled();
    });
  });

  describe('direction guard', () => {
    // An unpushed local edit looks exactly like staleness if you only compare
    // content. Repairing it would revert the user's own typing — the one way
    // this probe could destroy data.
    it('ignores drift when the store is NEWER than the server', async () => {
      seed('LOCAL EDIT', 'LOCAL EDIT', 5000);
      getBlockSnapshot.mockResolvedValue({ id: BLOCK, content: 'server old', updatedAt: 2000 });

      nav();
      await flush();

      expect(driftLog()).toBeUndefined();
      expect(refreshBlockFromDoc).not.toHaveBeenCalled();
      expect(pullServerDiffNow).not.toHaveBeenCalled();
    });

    it('ignores drift when store and server share a timestamp', async () => {
      seed('a', 'a', 2000);
      getBlockSnapshot.mockResolvedValue({ id: BLOCK, content: 'b', updatedAt: 2000 });

      nav();
      await flush();

      expect(driftLog()).toBeUndefined();
      expect(refreshBlockFromDoc).not.toHaveBeenCalled();
    });
  });

  describe('being-edited guard', () => {
    /** Mount the block's DOM host with a focused contentEditable inside it. */
    function focusInsideBlock() {
      document.body.innerHTML = `<div data-block-id="${BLOCK}"><div contenteditable tabindex="0" id="ce"></div></div>`;
      (document.getElementById('ce') as HTMLElement).focus();
    }

    it('logs the verdict but does NOT repair a block being edited', async () => {
      seed('OLD', 'NEW');
      getBlockSnapshot.mockResolvedValue({ id: BLOCK, content: 'NEW', updatedAt: 2000 });
      focusInsideBlock();

      nav();
      await flush();

      // Evidence still captured — that is the point of logging before repairing.
      expect(driftLog()).toMatchObject({ mode: 'ydoc-store-drop', beingEdited: true });
      // ...but the store write is withheld: it would re-run useContentSync's
      // effect against a stale lastUpdateOrigin and eat in-flight keystrokes.
      expect(refreshBlockFromDoc).not.toHaveBeenCalled();
      expect(BLOCKS[BLOCK].content).toBe('OLD');
      expect(getSyncDiagnostics()).toMatchObject({
        navDriftYdocStoreDrops: 1,
        navDriftRepairs: 0,
      });
    });

    it('repairs when focus is elsewhere on the page', async () => {
      seed('OLD', 'NEW');
      getBlockSnapshot.mockResolvedValue({ id: BLOCK, content: 'NEW', updatedAt: 2000 });
      document.body.innerHTML = `<div data-block-id="${BLOCK}"></div><input id="other" />`;
      (document.getElementById('other') as HTMLElement).focus();

      nav();
      await flush();

      expect(refreshBlockFromDoc).toHaveBeenCalledWith(BLOCK);
    });
  });

  describe('guards and cost', () => {
    it('does not probe before the HTTP client is initialized', async () => {
      seed('OLD', 'NEW');
      clientInitialized.value = false;

      nav();
      await flush();

      // getHttpClient() THROWS when uninitialized — a probe that ran here would
      // turn every pre-boot terminal navigation into a logged failure.
      expect(getBlockSnapshot).not.toHaveBeenCalled();
    });

    it('probes a given block only once per cooldown window', async () => {
      seed('OLD', 'OLD');
      getBlockSnapshot.mockResolvedValue({ id: BLOCK, content: 'NEW', updatedAt: 2000 });

      nav();
      await flush();
      nav();
      await flush();

      expect(getBlockSnapshot).toHaveBeenCalledTimes(1);
    });

    it('is silent when the server has no such block (404)', async () => {
      seed('OLD', 'NEW');
      getBlockSnapshot.mockResolvedValue(null);

      nav();
      await flush();

      expect(driftLog()).toBeUndefined();
      expect(refreshBlockFromDoc).not.toHaveBeenCalled();
    });

    it('never lets a probe failure surface as a navigation failure', async () => {
      seed('OLD', 'NEW');
      getBlockSnapshot.mockRejectedValue(new Error('server on fire'));

      const result = navigateToBlock(BLOCK, { paneId: 'p1' });
      await flush();

      expect(result.success).toBe(true);
    });

    it('counts the verdict but not a repair when the repair fails', async () => {
      seed('OLD', 'OLD');
      getBlockSnapshot.mockResolvedValue({ id: BLOCK, content: 'NEW', updatedAt: 2000 });
      pullServerDiffNow.mockRejectedValueOnce(new Error('pull failed'));

      nav();
      await flush();

      expect(getSyncDiagnostics()).toMatchObject({
        navDriftTransportMisses: 1,
        navDriftRepairs: 0,
      });
    });
  });

  describe('log payload', () => {
    it('carries lengths and timestamps, and truncates content to a preview', async () => {
      const long = 'x'.repeat(500);
      seed('OLD', long);
      getBlockSnapshot.mockResolvedValue({ id: BLOCK, content: long, updatedAt: 2000 });

      nav();
      await flush();

      const payload = driftLog()!;
      expect(payload).toMatchObject({
        storeLen: 3,
        docLen: 500,
        serverLen: 500,
        storeUpdatedAt: 1000,
        serverUpdatedAt: 2000,
      });
      // Frontend logs reach OTLP → Loki. Enough to recognise the block, not
      // enough to ship the outline off the machine.
      expect((payload.serverPreview as string).length).toBe(60);
    });
  });
});
