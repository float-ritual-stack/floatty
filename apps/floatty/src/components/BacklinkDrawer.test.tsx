/**
 * BacklinkDrawer housing tests (FLO-440 U2, slice 2).
 *
 * Exercises the component through the WorkspaceProvider mock seam with an
 * injected backlink index — synthetic PII-free fixtures. Pure height math
 * lives in drawerLayout.test.ts; scope-stack rules in backlinkScope.test.ts.
 */
import { render, fireEvent } from '@solidjs/testing-library';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { BacklinkDrawer } from './BacklinkDrawer';

// The drawer never navigates itself — it resolves the pane link at the call
// site and hands the funnel a target. Stub the funnel entry points so the
// assertions are on WHAT it hands over; identity pane resolution keeps the
// pane-link machinery out of the picture.
const navMocks = vi.hoisted(() => ({
  navigateToBlock: vi.fn(() => ({ success: true, targetPaneId: 'pane-test' })),
  followWikilinkTarget: vi.fn(() => ({ success: true, targetPaneId: 'pane-test' })),
}));
vi.mock('../lib/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/navigation')>()),
  navigateToBlock: navMocks.navigateToBlock,
  followWikilinkTarget: navMocks.followWikilinkTarget,
  resolveSameTabLink: (paneId: string) => paneId,
}));
import {
  WorkspaceProvider,
  createMockBlockStore,
  createMockPaneStore,
} from '../context/WorkspaceContext';
import type { BacklinkIndex } from '../lib/backlinkIndex';
import type { Block } from '../lib/blockTypes';
import { isMac, getActionForEvent } from '../lib/keybinds';
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
    canonicalTargetKey: () => null,
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

describe('BacklinkDrawer navigation wiring (FLO-953)', () => {
  beforeEach(() => {
    navMocks.navigateToBlock.mockClear();
    navMocks.followWikilinkTarget.mockClear();
  });

  const open = () => renderDrawer({
    focusedBlockId: 'focal-1',
    drawerOpen: true,
    index: indexOf({ 'focal-1': ['src-1'] }),
  });

  it('→ and ⌘-click both hand the source to navigateToBlock in the caller-resolved pane', () => {
    const { container } = open();
    fireEvent.click(container.querySelector('.blockref-nav')!);
    expect(navMocks.navigateToBlock).toHaveBeenCalledWith('src-1', { paneId: 'pane-test', highlight: true });
    fireEvent.click(container.querySelector('.blockref-content')!, { metaKey: true });
    expect(navMocks.navigateToBlock).toHaveBeenCalledTimes(2);
    expect(navMocks.followWikilinkTarget).not.toHaveBeenCalled();
  });

  it('a [[wikilink]] inside a row follows the shared ladder, not the row', () => {
    const { container } = open();
    const link = container.querySelector('.blockref-content .md-wikilink')!;
    expect(link.getAttribute('data-target')).toBe('focal-1');
    fireEvent.click(link);
    expect(navMocks.followWikilinkTarget).toHaveBeenCalledWith(
      'focal-1',
      expect.objectContaining({ paneId: 'pane-test', highlight: true, splitDirection: undefined }),
    );
    expect(navMocks.navigateToBlock).not.toHaveBeenCalled();
  });

  it('⌥-click on a wikilink asks for a split, like a wikilink in the outline', () => {
    const { container } = open();
    fireEvent.click(container.querySelector('.blockref-content .md-wikilink')!, { altKey: true });
    expect(navMocks.followWikilinkTarget).toHaveBeenCalledWith(
      'focal-1',
      expect.objectContaining({ paneId: 'pane-test', splitDirection: 'horizontal' }),
    );
  });
});

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
    const rows = container.querySelectorAll('.blockref-row');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('first source');
    // D3: row bodies are display-only — no interactive semantics; the
    // navigate affordance is a real button, tested in BlockRefList.test.tsx
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

  it('tracks pointer drag on window and commits on completion', () => {
    const setDrawerHeight = vi.fn();
    const { container } = renderDrawer({
      drawerOpen: true,
      setDrawerHeight,
    });
    const grip = container.querySelector('.backlink-drawer-grip')!;

    fireEvent.pointerDown(grip, { button: 0, pointerId: 1, clientY: 300 });
    fireEvent.pointerMove(window, { pointerId: 1, clientY: 260 });
    fireEvent.pointerUp(window, { pointerId: 1, clientY: 260 });

    expect(setDrawerHeight).toHaveBeenCalledWith('pane-test', DRAWER_DEFAULT_HEIGHT + 40);
  });

  it('removes window drag listeners on unmount', () => {
    const setDrawerHeight = vi.fn();
    const { container, unmount } = renderDrawer({
      drawerOpen: true,
      setDrawerHeight,
    });
    const grip = container.querySelector('.backlink-drawer-grip')!;

    fireEvent.pointerDown(grip, { button: 0, pointerId: 1, clientY: 300 });
    unmount();
    fireEvent.pointerMove(window, { pointerId: 1, clientY: 260 });
    fireEvent.pointerUp(window, { pointerId: 1, clientY: 260 });

    expect(setDrawerHeight).not.toHaveBeenCalled();
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

it('focus shortcut walks drawer rows, toggles slices, navigates, and escapes to the pane', () => {
  Element.prototype.scrollIntoView = vi.fn();
  navMocks.navigateToBlock.mockClear();
  const focal = '00000000-0000-4000-8000-000000000001';
  const first = '00000000-0000-4000-8000-000000000002';
  const second = '00000000-0000-4000-8000-000000000003';
  const child = '00000000-0000-4000-8000-000000000004';
  const blocks: Record<string, Block> = {
    [focal]: block(focal, 'Demo focal'),
    [first]: { ...block(first, 'Demo first'), childIds: [child], updatedAt: 2 },
    [second]: { ...block(second, 'Demo second'), updatedAt: 1 },
    [child]: { ...block(child, 'Demo child'), parentId: first },
  };
  let focused: string | null = focal;
  let editor!: HTMLDivElement;
  const paneStore = createMockPaneStore({
    getFocusedBlockId: () => focused,
    setFocusedBlockId: (_pane, id) => { focused = id; if (id === focal) editor.focus(); },
    isDrawerOpen: () => true,
  });
  const { container } = render(() => <WorkspaceProvider
    blockStore={createMockBlockStore({ blocks, getBlock: (id) => blocks[id] })}
    paneStore={paneStore} backlinkIndex={() => indexOf({ [focal]: [first, second] })}
  >
    <div class="outliner-pane-body">
      <div ref={editor} contenteditable="true" tabindex="0" />
      <BacklinkDrawer paneId="pane-test" paneHeight={600} />
    </div>
  </WorkspaceProvider>);
  editor.focus();
  const shortcut = new KeyboardEvent('keydown', { key: 'Y', code: 'KeyY', shiftKey: true, metaKey: isMac, ctrlKey: !isMac, bubbles: true, cancelable: true });
  expect(getActionForEvent(shortcut)).toBe('focusBacklinks');
  editor.dispatchEvent(shortcut);
  const body = container.querySelector<HTMLElement>('.backlink-drawer-body')!;
  const highlighted = () => container.querySelector('.blockref-row-focused')?.getAttribute('data-source-block-id');
  expect(document.activeElement).toBe(body);
  expect(highlighted()).toBe(first);
  fireEvent.keyDown(body, { key: 'ArrowDown' });
  expect(highlighted()).toBe(second);
  fireEvent.keyDown(body, { key: 'ArrowUp' });
  expect(highlighted()).toBe(first);
  fireEvent.keyDown(body, { key: ' ' });
  expect(container.querySelector('.blockref-slice')).not.toBeNull();
  fireEvent.keyDown(body, { key: '.', metaKey: true });
  expect(container.querySelector('.blockref-slice')).toBeNull();
  fireEvent.keyDown(body, { key: 'Enter' });
  expect(navMocks.navigateToBlock).toHaveBeenCalledWith(first, { paneId: 'pane-test', highlight: true });
  fireEvent.keyDown(body, { key: 'Escape' });
  expect(document.activeElement).toBe(editor);
  expect(focused).toBe(focal);
  expect(container.querySelector('.blockref-row[tabindex]')).toBeNull();
});
