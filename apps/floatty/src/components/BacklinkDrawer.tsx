/**
 * BacklinkDrawer — U2 drawer housing + U4 scope stack + slice-2 dumb list
 * (FLO-440, design doc 2026-08-11-backlinks-drawer.md).
 *
 * Per-pane bottom drawer inside OutlinerPane. Slice 2 ships the housing
 * (tab strip with one real tab + inert slots, drag/keyboard-resizable grab
 * strip, per-pane persisted open/height) and a deliberately dumb row list.
 * Sorting, facets, churn clustering, slices and the context-radius dial are
 * U3 (BlockRefList) — do not grow them here.
 *
 * Interaction decisions in force: D1 default-closed (the ⟲n chip
 * advertises) · D3 row click = NOTHING (rows are display-only until U3's
 * explicit affordances) · D6 true-empty is a feature · D11 drag-resize with
 * double-click-to-default · keyboard resize contract from the design doc's
 * §U2 (accessibility-baseline.md: the drawer takes the affordance).
 */

import { createMemo, createSignal, For, Show } from 'solid-js';
import { useWorkspace } from '../context/WorkspaceContext';
import { resolveBacklinkScope, type BacklinkGroup } from '../lib/backlinkScope';

/**
 * Structural equality for the scope-stack result. The memo recomputes on
 * every focus/zoom/index change, but most recomputations yield the same
 * groups — without a custom `equals`, each fresh array identity would make
 * `<For>` tear down and rebuild every group header and row on every caret
 * move (solidjs-patterns.md §1).
 */
function groupsEqual(a: BacklinkGroup[], b: BacklinkGroup[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const ga = a[i];
    const gb = b[i];
    if (ga.kind !== gb.kind || ga.targetId !== gb.targetId) return false;
    if (ga.sourceIds.length !== gb.sourceIds.length) return false;
    for (let j = 0; j < ga.sourceIds.length; j++) {
      if (ga.sourceIds[j] !== gb.sourceIds[j]) return false;
    }
  }
  return true;
}
import {
  DRAWER_DEFAULT_HEIGHT,
  DRAWER_KEY_STEP,
  DRAWER_KEY_STEP_LARGE,
  DRAWER_MIN_HEIGHT,
  clampDrawerHeight,
  drawerMaxHeight,
} from '../lib/drawerLayout';

interface BacklinkDrawerProps {
  paneId: string;
  /** Current pane height in px — the clamp bound for drawer resizing. */
  paneHeight: number;
}

const SLOT_TABS = ['graph', 'properties', 'history'] as const;

export function BacklinkDrawer(props: BacklinkDrawerProps) {
  const { blockStore, paneStore, backlinks, pagesContainerId } = useWorkspace();

  const open = () => paneStore.isDrawerOpen(props.paneId);
  // Live drag height rides a local signal so pointermove doesn't spam the
  // persisted store; the clamped value commits once on pointerup.
  const [dragHeight, setDragHeight] = createSignal<number | null>(null);
  const storedHeight = () => paneStore.getDrawerHeight(props.paneId) ?? DRAWER_DEFAULT_HEIGHT;
  // Clamp on APPLY against the current pane height — the stored raw value
  // survives short windows untouched (drawerLayout.ts module doc).
  const appliedHeight = () => clampDrawerHeight(dragHeight() ?? storedHeight(), props.paneHeight);

  const groups = createMemo<BacklinkGroup[]>(() => resolveBacklinkScope({
    zoomedRootId: paneStore.getZoomedRootId(props.paneId),
    focusedBlockId: paneStore.getFocusedBlockId(props.paneId),
    pagesContainerId: pagesContainerId(),
    index: backlinks(),
    getBlock: (id) => blockStore.getBlock(id),
  }), undefined, { equals: groupsEqual });

  const totalCount = createMemo(() => {
    const distinct = new Set<string>();
    for (const group of groups()) {
      for (const sourceId of group.sourceIds) distinct.add(sourceId);
    }
    return distinct.size;
  });

  // A gesture persists the height clamped to the pane where the gesture
  // happened (the user expressed intent at THAT size); a restore with no
  // gesture never writes, so a height saved on a tall window survives short
  // windows untouched until the user resizes again.
  const commitHeight = (heightPx: number) => {
    paneStore.setDrawerHeight(props.paneId, clampDrawerHeight(heightPx, props.paneHeight));
  };

  const toggleOpen = () => paneStore.setDrawerOpen(props.paneId, !open());

  const onStripPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    const strip = event.currentTarget as HTMLElement;
    const startY = event.clientY;
    const startHeight = appliedHeight();
    // Move keyboard focus to the strip so the §U2 keyboard contract is live
    // immediately after a mouse drag (WebKit doesn't focus divs on click).
    strip.focus();
    // setPointerCapture can throw InvalidStateError on synthetic
    // PointerEvents — listener setup must not depend on capture succeeding
    // (PinShelfView.tsx precedent, same gesture).
    try {
      strip.setPointerCapture(event.pointerId);
    } catch { /* capture is best-effort */ }
    const onMove = (moveEvent: PointerEvent) => {
      // Dragging the strip UP (smaller clientY) grows the bottom drawer.
      setDragHeight(clampDrawerHeight(startHeight + (startY - moveEvent.clientY), props.paneHeight));
    };
    const onUp = (upEvent: PointerEvent) => {
      try {
        strip.releasePointerCapture(upEvent.pointerId);
      } catch { /* already released */ }
      strip.removeEventListener('pointermove', onMove);
      strip.removeEventListener('pointerup', onUp);
      strip.removeEventListener('pointercancel', onUp);
      const finalHeight = dragHeight();
      setDragHeight(null);
      if (finalHeight !== null) commitHeight(finalHeight);
    };
    strip.addEventListener('pointermove', onMove);
    strip.addEventListener('pointerup', onUp);
    strip.addEventListener('pointercancel', onUp);
  };

  // Keyboard twin of the pointer drag — every path funnels through the same
  // clamp-then-persist commitHeight, so the two cannot diverge.
  const onStripKeyDown = (event: KeyboardEvent) => {
    const current = appliedHeight();
    const step = event.shiftKey ? DRAWER_KEY_STEP_LARGE : DRAWER_KEY_STEP;
    switch (event.key) {
      case 'ArrowUp': commitHeight(current + step); break;
      case 'ArrowDown': commitHeight(current - step); break;
      case 'Home': commitHeight(DRAWER_MIN_HEIGHT); break;
      case 'End': commitHeight(drawerMaxHeight(props.paneHeight)); break;
      case 'Enter': commitHeight(DRAWER_DEFAULT_HEIGHT); break;
      default: return;
    }
    event.preventDefault();
  };

  const labelFor = (blockId: string): string => {
    const block = blockStore.getBlock(blockId);
    if (!block) return blockId.slice(0, 8);
    const firstLine = block.content.split('\n')[0].replace(/^#+\s*/, '').trim();
    return firstLine || blockId.slice(0, 8);
  };

  const rowText = (blockId: string): string => {
    const block = blockStore.getBlock(blockId);
    return block ? (block.content.split('\n')[0] || blockId.slice(0, 8)) : blockId.slice(0, 8);
  };

  return (
    <div
      class="backlink-drawer"
      classList={{
        'backlink-drawer-open': open(),
        'backlink-drawer-dragging': dragHeight() !== null,
      }}
      style={{ height: open() ? `${appliedHeight()}px` : undefined }}
    >
      <Show when={open()}>
        <div
          class="backlink-drawer-grip"
          tabindex="0"
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize backlinks drawer"
          aria-valuenow={appliedHeight()}
          aria-valuemin={DRAWER_MIN_HEIGHT}
          aria-valuemax={drawerMaxHeight(props.paneHeight)}
          onPointerDown={onStripPointerDown}
          onKeyDown={onStripKeyDown}
          onDblClick={() => commitHeight(DRAWER_DEFAULT_HEIGHT)}
        />
      </Show>
      <div class="backlink-drawer-bar">
        <button
          class="backlink-drawer-tab backlink-drawer-tab-active"
          aria-expanded={open()}
          onClick={toggleOpen}
        >
          Backlinks
        </button>
        <For each={SLOT_TABS}>
          {(slot) => (
            <span class="backlink-drawer-tab backlink-drawer-tab-slot" aria-disabled="true" title="coming later">
              {slot}
            </span>
          )}
        </For>
        <span class="backlink-drawer-spacer" />
        <span class="backlink-drawer-chip" classList={{ 'backlink-drawer-chip-empty': totalCount() === 0 }}>
          ⟲{totalCount()}
        </span>
        <button
          class="backlink-drawer-toggle"
          aria-label={open() ? 'Close backlinks drawer' : 'Open backlinks drawer'}
          aria-expanded={open()}
          onClick={toggleOpen}
        >
          {open() ? '▾' : '▴'}
        </button>
      </div>
      <Show when={open()}>
        <div class="backlink-drawer-body">
          <Show
            when={groups().length > 0}
            fallback={
              <div class="backlink-drawer-empty">
                nothing links here yet — [[page]] references will gather here
              </div>
            }
          >
            {/* U4: every resolved group renders — the page group is the
                always-present identity even at zero sources (D6: emptiness
                is legible, never hidden). */}
            <For each={groups()}>
              {(group) => (
                <div class="backlink-drawer-group">
                  <div class="backlink-drawer-group-header">
                    <span class="backlink-drawer-group-kind">
                      {group.kind === 'focal' ? 'this block' : 'page'}
                    </span>
                    <span class="backlink-drawer-group-label">{labelFor(group.targetId)}</span>
                    <span class="backlink-drawer-group-count">{group.sourceIds.length}</span>
                  </div>
                  {/* D3: rows are display-only in slice 2 — no click handlers */}
                  <For each={group.sourceIds}>
                    {(sourceId) => (
                      <div class="backlink-drawer-row" data-source-block-id={sourceId}>
                        {rowText(sourceId)}
                      </div>
                    )}
                  </For>
                  <Show when={group.sourceIds.length === 0}>
                    <div class="backlink-drawer-row backlink-drawer-row-none">no references yet</div>
                  </Show>
                </div>
              )}
            </For>
          </Show>
        </div>
      </Show>
    </div>
  );
}
