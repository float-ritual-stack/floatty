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
 * child shows ONCE, in place. `[create_block:: …]` is read and carried on the
 * parse but NOT acted on here — the redirect is brief D/F territory.
 */

import { createMemo, Show } from 'solid-js';
import { Key } from '@solid-primitives/keyed';
import { useWorkspace } from '../../context/WorkspaceContext';
import { BlockRefList } from '../BlockRefList';
import { groupsEqual, type BacklinkGroup } from '../../lib/backlinkScope';
import { followWikilinkTarget, navigateToBlock, resolveSameTabLink } from '../../lib/navigation';
import { isMac } from '../../lib/keybinds';
import { parseQuery } from '../../lib/queryPredicate';
import { evaluateQuery } from '../../lib/queryEval';

interface QueryBlockDisplayProps {
  blockId: string;
  paneId: string;
}

export function QueryBlockDisplay(props: QueryBlockDisplayProps) {
  const {
    blockStore, backlinks, pagesContainerId, pageNameSet, stubPageNameSet, shortHashIndex,
  } = useWorkspace();

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

  // Keyed by position + text: the same message can legitimately repeat
  // (two malformed terms of one kind), and <Key> needs distinct identities.
  const errors = createMemo(() => [...parse().errors, ...result().errors]
    .map((message, index) => ({ key: `${index}:${message}`, message })));

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
      class="query-block-display"
      // A row click already navigated; letting it bubble to .block-item would
      // re-focus the query block and undo the navigation's focus.
      onClick={(event) => event.stopPropagation()}
    >
      <div class="query-block-header">
        <span class="query-block-count">
          {result().ids.length} of {result().total}
        </span>
        <Show when={result().truncated}>
          <span class="query-block-truncated">· truncated at {parse().options.limit}</span>
        </Show>
        <Show when={parse().options.display === 'titles'}>
          <span class="query-block-mode">titles</span>
        </Show>
      </div>
      <Show when={errors().length > 0}>
        <div class="query-block-errors" role="status" aria-live="polite">
          <Key each={errors()} by={(entry) => entry.key}>
            {(entry) => <div class="query-block-error">⚠ {entry().message}</div>}
          </Key>
        </div>
      </Show>
      <BlockRefList
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
    </div>
  );
}
