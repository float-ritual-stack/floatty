/**
 * PinShelfView — sidebar tab that renders a stack of Outliners, one per child
 * of the `pinned::` root block. Each child's first `[[X]]` wikilink resolves
 * to a block (via `resolveBlockIdPrefix` for hash/UUID, falling back to
 * `findPage` for page-name), and the Outliner below is zoomed to that block.
 *
 * The whole feature is built on FLO-668's decoupled-pane contract:
 *   - generate a paneId per pin (stable, keyed on the pinned::-child's block id)
 *   - registerPane(id, { kind: 'sidebar' }) on mount → findTabIdByPaneId returns
 *     null → tab-scoped keybinds (Cmd+L, Cmd+Shift+F) naturally skip this pane
 *   - removePane(id) on cleanup piggybacks the existing paneStore cleanup path
 *   - <Outliner paneId={id}> mounts standalone per FLO-668's mount contract
 *
 * Rendering, tree editing, zoom history, wikilink nav, backlinks, collapse
 * state, Cmd+[/Cmd+] navigation are all inherited from the Outliner — nothing
 * pin-specific beyond mounting the component and driving its zoom target.
 *
 * v0: no add/remove/reorder UX. User edits the `pinned::` outline block to
 * curate the shelf. Entrypoints (keybind, drag, context menu) land later.
 */

import { Key } from '@solid-primitives/keyed';
import { createMemo, createEffect, createSignal, on, onMount, onCleanup, Show } from 'solid-js';
import { Outliner } from './Outliner';
import { blockStore } from '../hooks/useBlockStore';
import { paneStore } from '../hooks/usePaneStore';
import { useWorkspace } from '../context/WorkspaceContext';
import { extractFirstWikilink } from '../lib/wikilinkUtils';
import { resolveBlockIdPrefix } from '../lib/blockTypes';
import { findPage, findRootBlockByPrefix } from '../hooks/useBacklinkNavigation';
import './pin-shelf.css';

const PINNED_PREFIX = 'pinned::';

interface Pin {
  /** Stable id — the pinned::-child block whose content carries the [[X]] ref */
  childBlockId: string;
  /** Resolved block id to zoom the Outliner at */
  resolvedBlockId: string;
  /** Original wikilink target text (block id / page name) */
  target: string;
  /** Header label: the [[target|alias]] alias when present, else the target */
  displayTitle: string;
}

/**
 * Drag-to-reorder API, owned by the shelf and handed to each PinItem. Drag
 * state is shelf-level because a drop target spans pins. The pin header is the
 * grab zone (like a browser tab); `consumeSuppressClick` lets the header's
 * onClick (collapse) swallow the synthetic click that follows a drag.
 */
interface ReorderApi {
  draggingChildId: () => string | null;
  dropIndex: () => number | null;
  pinCount: () => number;
  start: (childId: string, e: PointerEvent) => void;
  consumeSuppressClick: () => boolean;
}

export function PinShelfView() {
  const { shortHashIndex } = useWorkspace();

  const pins = createMemo<Pin[]>(() => {
    const container = findRootBlockByPrefix(PINNED_PREFIX);
    if (!container) return [];

    const out: Pin[] = [];
    const blockIds = Object.keys(blockStore.blocks);
    const idx = shortHashIndex();

    for (const childId of container.childIds) {
      const child = blockStore.blocks[childId];
      if (!child) continue;

      // First wikilink, keeping its alias for the header. `[[id|deep pin]]`
      // resolves on `id` but displays "deep pin".
      const link = extractFirstWikilink(child.content);
      if (!link) continue;
      const target = link.target;

      // Same resolution ladder as BlockItem's wikilink click: short-hash/UUID
      // prefix first, page-name fallback. Both return a real block id.
      let resolvedBlockId = resolveBlockIdPrefix(target, blockIds, idx);
      if (!resolvedBlockId) {
        const page = findPage(target);
        resolvedBlockId = page?.id ?? null;
      }
      if (!resolvedBlockId) continue;

      out.push({
        childBlockId: childId,
        resolvedBlockId,
        target,
        displayTitle: link.alias ?? target,
      });
    }
    return out;
  });

  // ── Drag-to-reorder ──────────────────────────────────────────────────────
  // The pin header doubles as a reorder handle (browser-tab feel). Pins ARE the
  // ordered children of `pinned::`, so a drop is just moveBlock(child → index).
  // Shelf-level state because a drop target spans pins.
  const [draggingChildId, setDraggingChildId] = createSignal<string | null>(null);
  const [dropIndex, setDropIndex] = createSignal<number | null>(null);
  // Set on a drag's pointerup so the header's onClick (collapse) is swallowed —
  // prevents the "reordered AND collapsed" double-fire. Cleared on the next
  // pointerdown so a capture-swallowed click can never leave it stuck true.
  let suppressClick = false;

  const startReorder = (childId: string, e: PointerEvent) => {
    suppressClick = false;
    const headerEl = e.currentTarget as HTMLElement;
    const shelf = headerEl.closest('.pin-shelf') as HTMLElement | null;
    const startY = e.clientY;
    let started = false;
    let lastPointerY = startY;
    let rafId = 0;
    try { headerEl.setPointerCapture(e.pointerId); } catch { /* synthetic */ }

    // Insert-before index in the CURRENT array: first pin whose midpoint is
    // below the pointer, else end. moveBlock handles same-parent shift + no-op.
    const computeDrop = (clientY: number): number => {
      const items = Array.from(
        document.querySelectorAll<HTMLElement>('.pin-shelf > .pin-shelf-item')
      );
      for (let i = 0; i < items.length; i++) {
        const r = items[i].getBoundingClientRect();
        if (clientY < r.top + r.height / 2) return i;
      }
      return items.length;
    };

    // Edge auto-scroll: when the pointer nears the shelf's top/bottom edge while
    // dragging, scroll the shelf so off-screen pins (and their drop boundaries)
    // come into view — e.g. dropping below a tall pin whose bottom is off-screen.
    // A rAF loop keeps scrolling while the pointer is HELD in the edge zone (a
    // still pointer fires no pointermove). isConnected guards mid-drag unmount.
    const EDGE = 48;      // px from edge that triggers scroll
    const MAX_SPEED = 16; // px/frame at the very edge (ramps from 0 at zone entry)
    const autoScrollTick = () => {
      if (!started || !shelf || !shelf.isConnected) { rafId = 0; return; }
      const rect = shelf.getBoundingClientRect();
      let dy = 0;
      if (lastPointerY < rect.top + EDGE) {
        dy = -MAX_SPEED * Math.min(1, (rect.top + EDGE - lastPointerY) / EDGE);
      } else if (lastPointerY > rect.bottom - EDGE) {
        dy = MAX_SPEED * Math.min(1, (lastPointerY - (rect.bottom - EDGE)) / EDGE);
      }
      if (dy !== 0) {
        shelf.scrollTop += dy;
        setDropIndex(computeDrop(lastPointerY)); // re-evaluate target after scroll
      }
      rafId = requestAnimationFrame(autoScrollTick);
    };

    const onMove = (ev: PointerEvent) => {
      lastPointerY = ev.clientY;
      if (!started) {
        if (Math.abs(ev.clientY - startY) < 4) return; // click-vs-drag threshold
        started = true;
        setDraggingChildId(childId);
        if (shelf && !rafId) rafId = requestAnimationFrame(autoScrollTick);
      }
      setDropIndex(computeDrop(ev.clientY));
    };
    const onUp = (ev: PointerEvent) => {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
      try { headerEl.releasePointerCapture(ev.pointerId); } catch { /* not captured */ }
      headerEl.removeEventListener('pointermove', onMove);
      headerEl.removeEventListener('pointerup', onUp);
      headerEl.removeEventListener('pointercancel', onUp);
      if (started) {
        suppressClick = true;
        const target = dropIndex();
        const container = findRootBlockByPrefix(PINNED_PREFIX);
        if (target !== null && container) {
          blockStore.moveBlock(childId, container.id, target);
        }
      }
      setDraggingChildId(null);
      setDropIndex(null);
    };

    headerEl.addEventListener('pointermove', onMove);
    headerEl.addEventListener('pointerup', onUp);
    headerEl.addEventListener('pointercancel', onUp);
  };

  const reorder: ReorderApi = {
    draggingChildId,
    dropIndex,
    pinCount: () => pins().length,
    start: startReorder,
    consumeSuppressClick: () => { const s = suppressClick; suppressClick = false; return s; },
  };

  return (
    <div
      class="pin-shelf"
      classList={{ 'pin-shelf-dragging': draggingChildId() !== null }}
      role="region"
      aria-label="Pinned blocks"
    >
      <Key each={pins()} by={(p) => p.childBlockId}>
        {(pin, index) => <PinItem pin={pin} index={index} reorder={reorder} />}
      </Key>
      {/* Drop indicator for appending after the last pin */}
      <Show when={draggingChildId() !== null && dropIndex() === pins().length}>
        <div class="pin-drop-indicator-end" />
      </Show>
      {/* Empty-state hint */}
      <div class="pin-shelf-hint" hidden={pins().length > 0}>
        Create a root block <code>pinned::</code> and add children like
        {' '}<code>- [[c1ca5a5f]]</code> or <code>- [[Some Page]]</code> to
        populate this shelf.
      </div>
    </div>
  );
}

/**
 * Per-pin height floor (px). Below this any drag clamps — prevents the
 * Outliner from collapsing to a useless sliver.
 */
const PIN_MIN_HEIGHT = 120;

/**
 * Default pin height (px). ~40vh equivalent at a 1000px viewport; chosen
 * as a static pixel value so initial render doesn't have to measure the
 * container. Drag resizes each pin freely above this.
 */
const PIN_DEFAULT_HEIGHT = 400;

function PinItem(props: { pin: () => Pin; index: () => number; reorder: ReorderApi }) {
  // Stable paneId per child-block. Edits to the child's [[target]] reuse the
  // same paneId so the Outliner keeps its scroll/collapse state across a
  // target swap — we just re-point the zoom via the effect below.
  const paneId = `pin-${props.pin().childBlockId}`;

  // Per-pin height signal. Native `resize: vertical` was attempted but
  // WKWebView's `::-webkit-resizer` pseudo-element only paints when the
  // element has a visible scrollbar — and .pin-shelf-item uses overflow:
  // hidden so its inner Outliner owns scrolling. Result: no visible grip.
  // Custom drag handle + signal-driven height is fully reliable.
  const [height, setHeight] = createSignal(PIN_DEFAULT_HEIGHT);

  // Collapse the whole pin down to just its header strip — lets the user park a
  // pin without unpinning it. The dragged height() is preserved so re-expanding
  // returns to the same size. The Outliner stays mounted (CSS display:none, not
  // <Show>) per solidjs-patterns §4 — keeps its zoom/scroll/pane registration.
  // In-memory for v1: persists for the session, resets on reload.
  const [collapsed, setCollapsed] = createSignal(false);

  onMount(() => {
    paneStore.registerPane(paneId, { kind: 'sidebar' });
  });
  onCleanup(() => {
    paneStore.removePane(paneId);
  });

  // Track the current resolved block — if the pin's child content is edited to
  // point at a different block, follow the new target without remounting.
  //
  // setScope sets the pane's navigation FLOOR to the pinned block AND zooms to
  // it (skipHistory inside). The floor is what makes a pin un-escapable upward:
  // breadcrumb segments above it route to the linked pane, Escape clamps to it,
  // Cmd+Enter still descends freely. This replaces the prior direct
  // paneStore.zoomTo call — scope creation is now one centralized primitive
  // (resolves the CodeRabbit "don't call zoomTo directly" note on PR #317;
  // navigateToBlock remains unsuitable — it pushes history + pickZoomTarget).
  //
  // on() is load-bearing (solidjs-patterns.md §7): a bare createEffect here
  // tracks props.pin(), which reads the <Key> item signal — and that signal
  // updates on EVERY pins() recompute (pins() iterates blockStore.blocks).
  // So with a live pinned page (daily note gaining ctx:: markers, sh:: output,
  // or remote edits syncing in), the effect re-fired and snapped the zoom back
  // to the pin's root every time the user Cmd+Enter'd into a child. Restricting
  // the trigger to the resolved-target VALUE changing lets in-pane zoom stick.
  createEffect(on(
    () => props.pin().resolvedBlockId,
    (resolvedBlockId, prevResolvedBlockId) => {
      if (resolvedBlockId && resolvedBlockId !== prevResolvedBlockId) {
        paneStore.setScope(paneId, resolvedBlockId);
      }
    }
  ));

  // Pointer-capture drag pattern. Listeners attach to the handle itself
  // (not window) so capture keeps them live even if the cursor wanders off
  // the handle during a fast drag. Self-contained cleanup in pointerup /
  // pointercancel — no lifecycle hazards.
  //
  // setPointerCapture is wrapped in try/catch: it can throw InvalidStateError
  // on synthetic PointerEvents (the error bit observed in the self-verify
  // simulated-drag run). Real drags via hardware are unaffected. Either way,
  // listener setup must not depend on capture succeeding.
  const onHandlePointerDown = (e: PointerEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = height();
    const handle = e.currentTarget as HTMLElement;
    try { handle.setPointerCapture(e.pointerId); } catch { /* synthetic / already captured */ }

    const onMove = (ev: PointerEvent) => {
      const next = Math.max(PIN_MIN_HEIGHT, startHeight + (ev.clientY - startY));
      setHeight(next);
    };
    const onUp = (ev: PointerEvent) => {
      try { handle.releasePointerCapture(ev.pointerId); } catch { /* not captured */ }
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
    };

    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  };

  return (
    <div
      class="pin-shelf-item"
      classList={{
        'pin-shelf-item-collapsed': collapsed(),
        'pin-shelf-item-dragging': props.reorder.draggingChildId() === props.pin().childBlockId,
        'pin-drop-target':
          props.reorder.draggingChildId() !== null &&
          props.reorder.dropIndex() === props.index(),
      }}
      data-pin-child-id={props.pin().childBlockId}
      style={{ height: collapsed() ? undefined : `${height()}px` }}
    >
      <button
        type="button"
        class="pin-shelf-item-header"
        aria-expanded={!collapsed()}
        aria-label={`${collapsed() ? 'Expand' : 'Collapse'} pin: ${props.pin().displayTitle}`}
        onPointerDown={(e) => {
          e.preventDefault(); // suppress text selection + native focus side-effects
          props.reorder.start(props.pin().childBlockId, e);
        }}
        onClick={() => {
          // Swallow the click that follows a reorder drag (don't also collapse).
          if (props.reorder.consumeSuppressClick()) return;
          setCollapsed((c) => !c);
        }}
      >
        <span class="pin-shelf-item-chevron" aria-hidden="true">
          {collapsed() ? '▶' : '▼'}
        </span>
        <span class="pin-shelf-item-title">{props.pin().displayTitle}</span>
      </button>
      <div class="pin-shelf-item-body">
        <Outliner paneId={paneId} />
        <div
          class="pin-shelf-item-handle"
          role="separator"
          aria-label="Resize pin"
          aria-orientation="horizontal"
          onPointerDown={onHandlePointerDown}
        />
      </div>
    </div>
  );
}
