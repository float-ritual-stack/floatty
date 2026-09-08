/**
 * Pane-scope (floor) navigation policy tests.
 *
 * Covers the decision logic in requestPaneZoom / requestPaneZoomOut /
 * isWithinPaneScope. The above-floor→linked-pane branch that routes a *block*
 * target through navigateToBlock is exercised live (MCP) rather than here — its
 * internals (pickZoomTarget, scroll/highlight) aren't the policy under test.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Synthetic tree:  root(pages::) → pin → child → grandchild ──────────────
const TREE: Record<string, { parentId: string | null; childIds: string[]; content: string }> = {
  root: { parentId: null, childIds: ['pin'], content: 'pages::' },
  pin: { parentId: 'root', childIds: ['child'], content: 'the pinned block' },
  child: { parentId: 'pin', childIds: ['grandchild'], content: 'child' },
  grandchild: { parentId: 'child', childIds: [], content: 'grandchild' },
};

const zoomTo = vi.fn();
const resolveLink = vi.fn<(src: string, blk?: string) => string | null>(() => null);
// paneId 'pinPane' is floored at 'pin' and hosted in the sidebar; 'normalPane'
// is an unbounded tab pane.
const getFloor = (paneId: string): string | null => (paneId === 'pinPane' ? 'pin' : null);

vi.mock('../hooks/usePaneStore', () => ({
  paneStore: {
    getFloor: (paneId: string) => getFloor(paneId),
    zoomTo: (...args: unknown[]) => zoomTo(...args),
    getPaneHost: (paneId: string) =>
      paneId === 'pinPane' ? { kind: 'sidebar' } : { kind: 'tab', tabId: 't1' },
    setFocusedBlockId: vi.fn(),
  },
}));
vi.mock('../hooks/useBlockStore', () => ({
  // getter: the factory is hoisted above TREE's initialization
  blockStore: { getBlock: (id: string) => TREE[id] ?? null, get blocks() { return TREE; } },
}));
vi.mock('../hooks/usePaneLinkStore', () => ({
  paneLinkStore: { resolveLink: (src: string, blk?: string) => resolveLink(src, blk) },
}));
vi.mock('../hooks/useLayoutStore', () => ({
  layoutStore: { setActivePaneId: vi.fn(), splitPane: vi.fn() },
  findTabIdByPaneId: (paneId: string) => (paneId === 'pinPane' ? null : 't1'),
}));
vi.mock('../hooks/useTabStore', () => ({ tabStore: { activeTabId: () => 't1' } }));
vi.mock('../hooks/useBacklinkNavigation', () => ({ navigateToPage: vi.fn() }));
vi.mock('./logger', () => ({ createLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }) }));

import { followWikilinkTarget, isWithinPaneScope, requestPaneZoom, requestPaneZoomOut } from './navigation';
import { navigateToPage as navigateToPageImpl } from '../hooks/useBacklinkNavigation';

beforeEach(() => {
  zoomTo.mockClear();
  resolveLink.mockReset();
  resolveLink.mockReturnValue(null);
  vi.mocked(navigateToPageImpl).mockReset();
});

// The shared click-a-wikilink ladder (FLO-953). The block-id HIT branch lands
// in navigateToBlock, whose internals are exercised live (see header) — the
// ordering that matters here is: id lookalikes never mint a page, and a page
// name reaches the mkdir-p choke point with the pane the caller resolved.
describe('followWikilinkTarget', () => {
  it('a full UUID that is not in the outline fails without touching pages', () => {
    const result = followWikilinkTarget('00000000-0000-4000-8000-000000000009', { paneId: 'normalPane' });
    expect(result).toMatchObject({ success: false, targetPaneId: 'normalPane', error: 'block not found in outline' });
    expect(navigateToPageImpl).not.toHaveBeenCalled();
    expect(zoomTo).not.toHaveBeenCalled();
  });

  it('a hex prefix that resolves to nothing never creates a page', () => {
    const result = followWikilinkTarget('deadbeef', { paneId: 'normalPane' });
    expect(result).toMatchObject({ success: false, error: 'block id prefix did not resolve' });
    expect(navigateToPageImpl).not.toHaveBeenCalled();
  });

  it('a page name reaches navigateToPage in the pane the caller resolved', () => {
    vi.mocked(navigateToPageImpl).mockReturnValue(
      { success: true, targetPaneId: 'normalPane', focusTargetId: null, pageId: 'p1' } as never,
    );
    const result = followWikilinkTarget('Demo Page', { paneId: 'normalPane', splitDirection: undefined });
    expect(navigateToPageImpl).toHaveBeenCalledWith('Demo Page', 'normalPane', 'none', false, undefined);
    expect(result.success).toBe(true);
  });

  it('an empty target is a no-op', () => {
    expect(followWikilinkTarget('', { paneId: 'normalPane' })).toMatchObject({ success: false, error: 'empty target' });
    expect(navigateToPageImpl).not.toHaveBeenCalled();
  });
});

describe('isWithinPaneScope', () => {
  it('unbounded pane: everything (incl. ◊/null) is in scope', () => {
    expect(isWithinPaneScope('normalPane', null)).toBe(true);
    expect(isWithinPaneScope('normalPane', 'root')).toBe(true);
    expect(isWithinPaneScope('normalPane', 'grandchild')).toBe(true);
  });

  it('floored pane: the floor and its descendants are in scope', () => {
    expect(isWithinPaneScope('pinPane', 'pin')).toBe(true);
    expect(isWithinPaneScope('pinPane', 'child')).toBe(true);
    expect(isWithinPaneScope('pinPane', 'grandchild')).toBe(true);
  });

  it('floored pane: the floor’s ancestors and ◊/null are OUT of scope', () => {
    expect(isWithinPaneScope('pinPane', 'root')).toBe(false);
    expect(isWithinPaneScope('pinPane', null)).toBe(false);
  });
});

describe('requestPaneZoom', () => {
  it('unbounded pane: zooms in-pane to the target (◊ = full tree)', () => {
    requestPaneZoom('normalPane', 'grandchild');
    expect(zoomTo).toHaveBeenCalledWith('normalPane', 'grandchild', { originBlockId: undefined });
    zoomTo.mockClear();
    requestPaneZoom('normalPane', null);
    expect(zoomTo).toHaveBeenCalledWith('normalPane', null, { originBlockId: undefined });
  });

  it('floored pane, in-scope target: zooms in-pane', () => {
    requestPaneZoom('pinPane', 'child');
    expect(zoomTo).toHaveBeenCalledWith('pinPane', 'child', { originBlockId: undefined });
  });

  it('floored pane, above-floor + NO linked pane: no-op (pin holds)', () => {
    resolveLink.mockReturnValue(null);
    requestPaneZoom('pinPane', 'root');
    requestPaneZoom('pinPane', null);
    expect(zoomTo).not.toHaveBeenCalled();
  });

  it('floored pane, ◊ (null) + linked pane: opens linked pane at full tree', () => {
    resolveLink.mockReturnValue('paneA');
    requestPaneZoom('pinPane', null);
    expect(zoomTo).toHaveBeenCalledWith('paneA', null);
  });
});

describe('requestPaneZoomOut (Escape)', () => {
  it('unbounded pane: zooms out to full tree (null)', () => {
    requestPaneZoomOut('normalPane');
    expect(zoomTo).toHaveBeenCalledWith('normalPane', null, { originBlockId: undefined });
  });

  it('floored pane: clamps to the floor (never above)', () => {
    requestPaneZoomOut('pinPane');
    expect(zoomTo).toHaveBeenCalledWith('pinPane', 'pin', { originBlockId: undefined });
  });
});
