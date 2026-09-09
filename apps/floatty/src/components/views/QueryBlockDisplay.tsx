/**
 * QueryBlockDisplay — the `query::` sibling view (query-views track, brief E,
 * FLO-947). Mounted by BlockItem next to the picker branch; the block's own
 * contentEditable stays live above it so the predicate is edited in place.
 *
 * A standing query = predicate × scope × render, the same machinery as the
 * backlink drawer with a user-written predicate: parse (`queryPredicate.ts`)
 * + evaluate (`queryEval.ts`) inside ONE memo that reads the store — P1,
 * fine-grained reactivity is the invalidation, no subscriptions, nothing
 * persisted — and the resulting id set renders through `BlockRefList` (P3)
 * as a `{ kind: 'query' }` group. Navigation is the drawer's wiring verbatim:
 * pane-link resolution at THIS call site, then the funnel. Zero new nav code.
 *
 * Real children of the query block are normal blocks (adding one is plain
 * editing); the evaluator excludes the query block's subtree so a matching
 * child shows ONCE, in place. `[create_block:: …]` is acted on by
 * `useBlockInput` (brief F, `queryCreate.ts`); this view only reports an
 * unresolvable target so the fallback (create in place) is visible.
 */

import { createMemo, createSignal, onMount, Show } from 'solid-js';
import { Key } from '@solid-primitives/keyed';
import { useWorkspace } from '../../context/WorkspaceContext';
import { useBlockDrag } from '../../hooks/useBlockDrag';
import { useOutputRowNavigation } from '../../hooks/useOutputRowNavigation';
import { BlockRefList, type RefListRows } from '../BlockRefList';
import { groupsEqual, type BacklinkGroup } from '../../lib/backlinkScope';
import { followWikilinkTarget, navigateToBlock, resolveSameTabLink } from '../../lib/navigation';
import { isMac } from '../../lib/keybinds';
import { parseQuery, setQueryOption } from '../../lib/queryPredicate';
import { evaluateQuery } from '../../lib/queryEval';
import { resolveCreateBlockTarget } from '../../lib/queryCreate';

export interface QueryRowFocus {
  enter: (edge: 'first' | 'last') => boolean;
}

interface QueryBlockDisplayProps {
  onRegisterRowFocus?: (focus: QueryRowFocus) => void;
  onReturnToLine?: () => void;
  onFocusNext?: () => void;
  blockId: string;
  paneId: string;
}

export function QueryBlockDisplay(props: QueryBlockDisplayProps) {
  const {
    blockStore, paneStore, backlinks, pagesContainerId, pageNameSet, stubPageNameSet, shortHashIndex,
  } = useWorkspace();

  const drag = useBlockDrag();
  const [movingRow, setMovingRow] = createSignal<string | null>(null);
  const [moveTarget, setMoveTarget] = createSignal('');
  const [moveError, setMoveError] = createSignal('');
  let moveHandle: HTMLElement | null = null;
  const moveBoards = createMemo(() => movingRow() ? Object.values(blockStore.blocks)
    .filter((block) => block.id !== props.blockId && block.id !== movingRow() && parseQuery(block.content).isQuery) : []);
  const closeMovePicker = () => {
    setMovingRow(null);
    queueMicrotask(() => {
      if (moveHandle?.isConnected) moveHandle.focus();
      else outputFocusRef?.focus({ preventScroll: true });
    });
  };
  let outputFocusRef: HTMLDivElement | undefined;
  const [visibleRows, setVisibleRows] = createSignal<RefListRows>({ ids: [], toggleExpanded: () => {} });
  const rowNavigation = useOutputRowNavigation({
    rows: () => visibleRows().ids,
    onNavigate: (id) => handleNavigate(id),
    onExitDown: () => props.onFocusNext?.(),
    onExitUp: () => returnToLine(),
    onEscape: () => returnToLine(),
    toggleOnModPeriod: true,
    onToggle: (id) => visibleRows().toggleExpanded(id),
  });
  const returnToLine = () => {
    rowNavigation.setIndex(-1);
    props.onReturnToLine?.();
  };
  onMount(() => props.onRegisterRowFocus?.({
    enter: (edge) => {
      if (collapsed() || !rowNavigation.enter(edge)) return false;
      outputFocusRef?.focus({ preventScroll: true });
      return true;
    },
  }));

  const collapsed = () => paneStore.isCollapsed(props.paneId, props.blockId, blockStore.getBlock(props.blockId)?.collapsed ?? false);

  const parse = createMemo(() => parseQuery(blockStore.getBlock(props.blockId)?.content ?? ''));

  // One memo over the store: any block change re-evaluates, the `equals`
  // below keeps BlockRefList's rows from rebuilding when the id set is stable.
  const result = createMemo(() => evaluateQuery(parse(), {
    getBlock: (id) => blockStore.getBlock(id),
    blocks: blockStore.blocks,
    backlinks: backlinks(),
    pagesContainerId: pagesContainerId(),
    now: Date.now(),
    queryBlockId: props.blockId,
  }));

  const groups = createMemo<BacklinkGroup[]>(
    () => [{ kind: 'query', targetId: props.blockId, sourceIds: result().ids }],
    undefined,
    { equals: groupsEqual },
  );

  // `[create_block:: …]` that resolves to nothing: never a throw, never a
  // page — the Enter redirect falls back to creating in place, say so here.
  const createBlockWarning = createMemo<string | null>(() => {
    const target = parse().options.createBlock;
    if (!target) return null;
    const resolved = resolveCreateBlockTarget(target, {
      getBlock: (id) => blockStore.getBlock(id),
      canonicalTargetKey: (raw) => backlinks().canonicalTargetKey(raw),
    });
    return resolved ? null : `create_block target not found ("${target}") — new blocks are created in place`;
  });

  // Keyed by position + text: the same message can legitimately repeat
  // (two malformed terms of one kind), and <Key> needs distinct identities.
  const errors = createMemo(() => {
    const warning = createBlockWarning();
    return [...parse().errors, ...result().errors, ...(warning ? [warning] : [])]
      .map((message, index) => ({ key: `${index}:${message}`, message }));
  });

  const labelFor = (): string => {
    const content = blockStore.getBlock(props.blockId)?.content ?? '';
    return content.split('\n')[0].replace(/^query::\s*/i, '').trim() || 'query';
  };

  // Verbatim from BacklinkDrawer: pane-link resolution at the caller, the
  // funnel owns zoom/expand/scroll/highlight. No blockId argument — that
  // keys ORIGIN-block overrides, and the destination must not hijack routing.
  const handleNavigate = (sourceBlockId: string) => {
    const targetPaneId = resolveSameTabLink(props.paneId);
    navigateToBlock(sourceBlockId, { paneId: targetPaneId, highlight: true });
  };

  const handleWikilink = (target: string, event: MouseEvent) => {
    const modKey = isMac ? event.metaKey : event.ctrlKey;
    const splitDirection = modKey || event.altKey
      ? (event.shiftKey ? 'vertical' : 'horizontal')
      : undefined;
    followWikilinkTarget(target, {
      paneId: splitDirection ? props.paneId : resolveSameTabLink(props.paneId),
      splitDirection,
      highlight: true,
      shortHashIndex: shortHashIndex(),
    });
  };

  return (
    <div
      ref={outputFocusRef}
      tabIndex={0}
      class="query-block-display output-block-focus-target"
      classList={{ 'query-drop-target': drag.isQueryDropTarget(props.blockId, props.paneId) }}
      data-query-drop={props.blockId}
      data-pane-id={props.paneId}
      onBlur={(event) => {
        if (event.target === event.currentTarget) rowNavigation.setIndex(-1);
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (!collapsed() && rowNavigation.handleKeyDown(event)) return;
        if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          returnToLine();
          return;
        }
        if (!collapsed() && rowNavigation.index() < 0 && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
          event.preventDefault();
          event.stopPropagation();
          if (!rowNavigation.enter(event.key === 'ArrowDown' ? 'first' : 'last')) {
            if (event.key === 'ArrowDown') props.onFocusNext?.();
            else returnToLine();
          }
          return;
        }
      }}
      // A row click already navigated; letting it bubble to .block-item would
      // re-focus the query block and undo the navigation's focus.
      onClick={(event) => event.stopPropagation()}
    >
      <div class="query-block-header">
        <button
          class="query-header-toggle"
          aria-label={collapsed() ? 'Expand query results' : 'Collapse query results'}
          aria-expanded={!collapsed()}
          onClick={() => paneStore.toggleCollapsed(props.paneId, props.blockId, blockStore.getBlock(props.blockId)?.collapsed ?? false)}
        >{collapsed() ? '▸' : '▾'}</button>
        <span class="query-block-count">
          {result().ids.length} of {result().total}
        </span>
        <Show when={result().truncated}>
          <span class="query-block-truncated">· truncated at {parse().options.limit}</span>
        </Show>
        <Show when={parse().options.display === 'titles'}>
          <span class="query-block-mode">titles</span>
        </Show>
        <button
          class="query-header-toggle"
          aria-label={parse().options.chrome === 'off' ? 'Configure query' : 'Show plain query list'}
          aria-pressed={parse().options.chrome !== 'off'}
          onClick={() => {
            const content = blockStore.getBlock(props.blockId)?.content;
            if (content !== undefined) blockStore.updateBlockContent(props.blockId,
              setQueryOption(content, 'chrome', parse().options.chrome === 'off' ? 'on' : 'off'));
          }}
        >{parse().options.chrome === 'off' ? '⚙' : '≡'}</button>
      </div>
      <Show when={errors().length > 0}>
        <div class="query-block-errors" role="status" aria-live="polite">
          <Key each={errors()} by={(entry) => entry.key}>
            {(entry) => <div class="query-block-error">⚠ {entry().message}</div>}
          </Key>
        </div>
      </Show>
      <Show when={movingRow()}>
        <div class="query-move-picker" role="group" aria-label="Move row to another board" onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            closeMovePicker();
          }
        }}>
          <select
            ref={(element) => queueMicrotask(() => element.focus())}
            aria-label="Destination board"
            value={moveTarget()}
            onChange={(event) => setMoveTarget(event.currentTarget.value)}
          >
            <option value="">Choose a board</option>
            <Key each={moveBoards()} by="id">
              {(board) => <option value={board().id}>{board().content.split('\n')[0]}</option>}
            </Key>
          </select>
          <button type="button" disabled={!moveTarget()} onClick={() => {
            const sourceId = movingRow();
            if (sourceId && drag.moveToQuery(sourceId, props.blockId, moveTarget(), props.paneId)) {
              closeMovePicker();
            } else {
              setMoveError('Cannot move this row to that board. No properties were changed.');
            }
          }}>Move</button>
          <button type="button" onClick={closeMovePicker}>Cancel</button>
          <div role="status" aria-live="polite">{moveError()}</div>
        </div>
      </Show>
      <Show when={!collapsed()}>
      <BlockRefList
        chrome={parse().options.chrome !== 'off'}
        totalAvailable={result().total}
        paneId={props.paneId}
        draggableRows
        onDragHandlePointerDown={drag.onHandlePointerDown}
        onMoveRow={(blockId) => {
          moveHandle = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          setMoveTarget('');
          setMoveError('');
          setMovingRow(blockId);
        }}
        highlightedRowId={visibleRows().ids[rowNavigation.index()]}
        onVisibleRows={setVisibleRows}
        groups={groups()}
        getBlock={(id) => blockStore.getBlock(id)}
        pagesContainerId={pagesContainerId()}
        labelFor={labelFor}
        onNavigate={handleNavigate}
        onNavigateWikilink={handleWikilink}
        pageNameSet={pageNameSet()}
        stubPageNameSet={stubPageNameSet()}
        plainClickNavigates
        display={parse().options.display}
      />
      </Show>
    </div>
  );
}
