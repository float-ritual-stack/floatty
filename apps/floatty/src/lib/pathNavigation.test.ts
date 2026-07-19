/**
 * Path-addressing navigation tests (ADR-008 stage 2a-client, FLO-474).
 *
 * Two layers:
 *   1. resolveWikilinkPath — the pure descendant walk + deterministic scoring
 *      (rung → depth → recency → oldest-createdAt). Store-first: the block
 *      store is a synthetic tree, findPage is the REAL predicate reading it.
 *   2. navigateWikilinkPath / handleChirpNavigate funnel branch — miss policy
 *      (ADR-008 D3: multi-segment never creates a page) + single-segment
 *      fall-through to the unchanged page path.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Block } from './blockTypes';

// ── Synthetic tree (no PII) ─────────────────────────────────────────────────
// pages:: → Demo Alpha ┬─ Section B → Digest 0000 → Deferred   (skip target)
//                      ├─ Section C
//                      ├─ Notes(shallow) → Notes(deep)          (depth proximity)
//                      ├─ Recent Twin(old) / Recent Twin(new)   (recency)
//                      └─ Age Twin(old)   / Age Twin(new)       (oldest-createdAt)
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

const TREE: Record<string, Block> = {
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

const setFocusedBlockId = vi.fn();
const zoomTo = vi.fn();

vi.mock('../hooks/useBlockStore', () => ({
  blockStore: {
    getBlock: (id: string) => TREE[id] ?? null,
    // Getters defer TREE access to call-time — a plain `blocks: TREE` property
    // would read TREE at factory-eval time, before the const initializes (TDZ).
    get blocks() {
      return TREE;
    },
    get rootIds() {
      return ['root'];
    },
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
// Keep the REAL findPage (it reads the mocked blockStore); spy only navigateToPage.
vi.mock('../hooks/useBacklinkNavigation', async (importActual) => {
  const actual = await importActual<typeof import('../hooks/useBacklinkNavigation')>();
  return { ...actual, navigateToPage: vi.fn() };
});
vi.mock('./logger', () => ({
  createLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { resolveWikilinkPath, navigateWikilinkPath, handleChirpNavigate } from './navigation';
import { navigateToPage as navigateToPageImplMock } from '../hooks/useBacklinkNavigation';

beforeEach(() => {
  setFocusedBlockId.mockClear();
  zoomTo.mockClear();
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

  it('partial miss lands at the deepest resolved segment', () => {
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

describe('navigateWikilinkPath — funnel wiring + miss policy (ADR-008 D3)', () => {
  it('full resolution navigates to the leaf block', () => {
    const res = navigateWikilinkPath(['Demo Alpha', 'Section B', 'Deferred'], { paneId: 'p1' });
    expect(res.success).toBe(true);
    // navigateToBlock focuses the actual destination block in the target pane.
    expect(setFocusedBlockId).toHaveBeenCalledWith('p1', 'deferred');
  });

  it('partial miss still navigates to the deepest resolved block', () => {
    const res = navigateWikilinkPath(['Demo Alpha', 'Section B', 'zzz'], { paneId: 'p1' });
    expect(res.success).toBe(true);
    expect(setFocusedBlockId).toHaveBeenCalledWith('p1', 'secB');
  });

  it('page miss is a no-op: no navigation, no page created', () => {
    const res = navigateWikilinkPath(['No Such Page', 'x'], { paneId: 'p1' });
    expect(res.success).toBe(false);
    expect(setFocusedBlockId).not.toHaveBeenCalled();
    expect(zoomTo).not.toHaveBeenCalled();
    // Junk-page creation retired: the page path is never invoked for a miss.
    expect(navigateToPageImplMock).not.toHaveBeenCalled();
  });
});

describe('handleChirpNavigate — path branch routing', () => {
  it('routes a multi-segment target through the path resolver', () => {
    const res = handleChirpNavigate('Demo Alpha > Section B', { sourcePaneId: 'p1' });
    expect(res.success).toBe(true);
    expect(setFocusedBlockId).toHaveBeenCalledWith('p1', 'secB');
    // Did NOT fall through to page find-or-create.
    expect(navigateToPageImplMock).not.toHaveBeenCalled();
  });

  it('single-segment target still falls through to the page path (unchanged)', () => {
    handleChirpNavigate('Demo Alpha', { sourcePaneId: 'p1' });
    expect(navigateToPageImplMock).toHaveBeenCalledTimes(1);
    expect((navigateToPageImplMock as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('Demo Alpha');
  });
});
