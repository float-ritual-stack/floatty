/**
 * BacklinkDrawer housing tests (FLO-440 U2, slice 2).
 *
 * Exercises the component through the WorkspaceProvider mock seam with an
 * injected backlink index — synthetic PII-free fixtures. Pure height math
 * lives in drawerLayout.test.ts; scope-stack rules in backlinkScope.test.ts.
 */
import { render, fireEvent } from '@solidjs/testing-library';
import { describe, it, expect, vi } from 'vitest';
import { BacklinkDrawer } from './BacklinkDrawer';
import {
  WorkspaceProvider,
  createMockBlockStore,
  createMockPaneStore,
} from '../context/WorkspaceContext';
import type { BacklinkIndex } from '../lib/backlinkIndex';
import type { Block } from '../lib/blockTypes';
import { DRAWER_DEFAULT_HEIGHT, DRAWER_MIN_HEIGHT } from '../lib/drawerLayout';

function block(id: string, content: string): Block {
  return {
    id,
    content,
    type: 'text',
    parentId: null,
    childIds: [],
    collapsed: false,
    createdAt: 0,
    updatedAt: 0,
  } as unknown as Block;
}

function indexOf(map: Record<string, string[]>): BacklinkIndex {
  return {
    referencing: (targetKey: string) => [...(map[targetKey] ?? [])],
    ambiguousTargets: [],
  };
}

const BLOCKS: Record<string, Block> = {
  'focal-1': block('focal-1', 'the focal block'),
  'src-1': block('src-1', 'first source mentions [[focal-1]]'),
  'src-2': block('src-2', 'second source mentions [[focal-1]]'),
};

interface Setup {
  focusedBlockId?: string | null;
  index?: BacklinkIndex;
  drawerOpen?: boolean;
  setDrawerHeight?: (paneId: string, px: number) => void;
  getDrawerHeight?: () => number | null;
}

function renderDrawer(setup: Setup = {}) {
  const blockStore = createMockBlockStore({
    getBlock: (id: string) => BLOCKS[id],
  });
  const paneStore = createMockPaneStore({
    getFocusedBlockId: () => setup.focusedBlockId ?? null,
    isDrawerOpen: () => setup.drawerOpen ?? false,
    getDrawerHeight: setup.getDrawerHeight ?? (() => null),
    setDrawerHeight: setup.setDrawerHeight ?? (() => {}),
  });
  const index = setup.index ?? indexOf({});
  return render(() => (
    <WorkspaceProvider blockStore={blockStore} paneStore={paneStore} backlinkIndex={() => index}>
      <BacklinkDrawer paneId="pane-test" paneHeight={600} />
    </WorkspaceProvider>
  ));
}

describe('BacklinkDrawer housing (U2)', () => {
  it('renders closed by default with the bar and count chip (D1)', () => {
    const { container } = renderDrawer({
      focusedBlockId: 'focal-1',
      index: indexOf({ 'focal-1': ['src-1', 'src-2'] }),
    });
    const drawer = container.querySelector('.backlink-drawer');
    expect(drawer).not.toBeNull();
    expect(drawer!.classList.contains('backlink-drawer-open')).toBe(false);
    expect(container.querySelector('.backlink-drawer-body')).toBeNull();
    expect(container.querySelector('.backlink-drawer-grip')).toBeNull();
    expect(container.querySelector('.backlink-drawer-chip')?.textContent).toBe('⟲2');
  });

  it('open drawer renders focal group header and display-only rows (D2/D3)', () => {
    const { container } = renderDrawer({
      focusedBlockId: 'focal-1',
      drawerOpen: true,
      index: indexOf({ 'focal-1': ['src-1', 'src-2'] }),
    });
    const header = container.querySelector('.backlink-drawer-group-header');
    expect(header?.textContent).toContain('this block');
    expect(header?.textContent).toContain('the focal block');
    const rows = container.querySelectorAll('.backlink-drawer-row');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('first source');
    // D3: rows are display-only — no interactive semantics
    rows.forEach((row) => {
      expect(row.getAttribute('tabindex')).toBeNull();
      expect(row.getAttribute('role')).toBeNull();
    });
  });

  it('true-empty state renders when no groups resolve (D6)', () => {
    const { container } = renderDrawer({ drawerOpen: true });
    expect(container.querySelector('.backlink-drawer-empty')?.textContent)
      .toContain('nothing links here yet');
    expect(container.querySelectorAll('.backlink-drawer-group')).toHaveLength(0);
  });

  it('keyboard resize funnels through clamp-then-persist (§U2 contract)', () => {
    const commits: number[] = [];
    const { container } = renderDrawer({
      focusedBlockId: 'focal-1',
      drawerOpen: true,
      index: indexOf({ 'focal-1': ['src-1'] }),
      setDrawerHeight: (_paneId, px) => commits.push(px),
    });
    const grip = container.querySelector('.backlink-drawer-grip')!;
    expect(grip.getAttribute('role')).toBe('separator');
    expect(grip.getAttribute('aria-valuemin')).toBe(String(DRAWER_MIN_HEIGHT));

    fireEvent.keyDown(grip, { key: 'ArrowUp' });
    fireEvent.keyDown(grip, { key: 'ArrowDown', shiftKey: true });
    fireEvent.keyDown(grip, { key: 'Home' });
    fireEvent.keyDown(grip, { key: 'End' });
    fireEvent.keyDown(grip, { key: 'Enter' });

    // paneHeight 600 → max = min(450, 440) = 440. Each key reads the
    // (unchanged, mock) stored height of null → default 240 as its base.
    expect(commits).toEqual([
      DRAWER_DEFAULT_HEIGHT + 16,  // ArrowUp
      DRAWER_DEFAULT_HEIGHT - 64,  // Shift+ArrowDown
      DRAWER_MIN_HEIGHT,           // Home
      440,                         // End (pane-relative max)
      DRAWER_DEFAULT_HEIGHT,       // Enter = reset to default
    ]);
  });

  it('applies the stored height clamped to the pane on open', () => {
    const { container } = renderDrawer({
      focusedBlockId: 'focal-1',
      drawerOpen: true,
      index: indexOf({ 'focal-1': ['src-1'] }),
      getDrawerHeight: () => 900, // stored on a taller window
    });
    const drawer = container.querySelector('.backlink-drawer') as HTMLElement;
    // paneHeight 600 → clamped to 440, raw 900 never applied
    expect(drawer.style.height).toBe('440px');
  });

  it('toggle button opens and closes through the pane store', () => {
    const setDrawerOpen = vi.fn();
    const blockStore = createMockBlockStore({ getBlock: (id: string) => BLOCKS[id] });
    const paneStore = createMockPaneStore({ setDrawerOpen });
    const { container } = render(() => (
      <WorkspaceProvider blockStore={blockStore} paneStore={paneStore} backlinkIndex={() => indexOf({})}>
        <BacklinkDrawer paneId="pane-test" paneHeight={600} />
      </WorkspaceProvider>
    ));
    const toggle = container.querySelector('.backlink-drawer-toggle') as HTMLElement;
    fireEvent.click(toggle);
    expect(setDrawerOpen).toHaveBeenCalledWith('pane-test', true);
  });
});
