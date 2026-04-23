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
import { createMemo, createEffect, createSignal, onMount, onCleanup } from 'solid-js';
import { Outliner } from './Outliner';
import { blockStore } from '../hooks/useBlockStore';
import { paneStore } from '../hooks/usePaneStore';
import { useWorkspace } from '../context/WorkspaceContext';
import { extractAllWikilinkTargets } from '../lib/wikilinkUtils';
import { resolveBlockIdPrefix } from '../lib/blockTypes';
import { findPage } from '../hooks/useBacklinkNavigation';
import './pin-shelf.css';

const PINNED_PREFIX = 'pinned::';

interface Pin {
  /** Stable id — the pinned::-child block whose content carries the [[X]] ref */
  childBlockId: string;
  /** Resolved block id to zoom the Outliner at */
  resolvedBlockId: string;
  /** Original wikilink target text — surfaced if we later want to show a header */
  target: string;
}

function findPinnedContainer() {
  for (const rootId of blockStore.rootIds) {
    const block = blockStore.blocks[rootId];
    if (block && block.content.trim() === PINNED_PREFIX) return block;
  }
  return null;
}

export function PinShelfView() {
  const { shortHashIndex } = useWorkspace();

  const pins = createMemo<Pin[]>(() => {
    const container = findPinnedContainer();
    if (!container) return [];

    const out: Pin[] = [];
    const blockIds = Object.keys(blockStore.blocks);
    const idx = shortHashIndex();

    for (const childId of container.childIds) {
      const child = blockStore.blocks[childId];
      if (!child) continue;

      const targets = extractAllWikilinkTargets(child.content);
      if (targets.length === 0) continue;
      const target = targets[0];

      // Same resolution ladder as BlockItem's wikilink click: short-hash/UUID
      // prefix first, page-name fallback. Both return a real block id.
      let resolvedBlockId = resolveBlockIdPrefix(target, blockIds, idx);
      if (!resolvedBlockId) {
        const page = findPage(target);
        resolvedBlockId = page?.id ?? null;
      }
      if (!resolvedBlockId) continue;

      out.push({ childBlockId: childId, resolvedBlockId, target });
    }
    return out;
  });

  return (
    <div class="pin-shelf" role="region" aria-label="Pinned blocks">
      <Key each={pins()} by={(p) => p.childBlockId}>
        {(pin) => <PinItem pin={pin} />}
      </Key>
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

function PinItem(props: { pin: () => Pin }) {
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

  onMount(() => {
    paneStore.registerPane(paneId, { kind: 'sidebar' });
  });
  onCleanup(() => {
    paneStore.removePane(paneId);
  });

  // Track the current resolved block — if the pin's child content is edited
  // to point at a different block, follow the new target without remounting.
  createEffect(() => {
    paneStore.setZoomedRoot(paneId, props.pin().resolvedBlockId);
  });

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
      data-pin-child-id={props.pin().childBlockId}
      style={{ height: `${height()}px` }}
    >
      <Outliner paneId={paneId} />
      <div
        class="pin-shelf-item-handle"
        role="separator"
        aria-label="Resize pin"
        aria-orientation="horizontal"
        onPointerDown={onHandlePointerDown}
      />
    </div>
  );
}
