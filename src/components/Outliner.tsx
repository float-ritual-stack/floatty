import { createSignal, createEffect, onMount, onCleanup, Show } from 'solid-js';
import { Key } from '@solid-primitives/keyed';
import { useSyncedYDoc } from '../hooks/useSyncedYDoc';
import { useWorkspace } from '../context/WorkspaceContext';
import { useBlockOperations } from '../hooks/useBlockOperations';
import { BlockItem } from './BlockItem';
import { Breadcrumb } from './Breadcrumb';

interface OutlinerProps {
  paneId: string;
}

export function Outliner(props: OutlinerProps) {
  const { doc, isLoaded } = useSyncedYDoc();
  const { blockStore, paneStore } = useWorkspace();
  const store = blockStore;
  const { findNextVisibleBlock, findPrevVisibleBlock } = useBlockOperations();
  const [focusedBlockId, setFocusedBlockId] = createSignal<string | null>(null);
  const [confirmClear, setConfirmClear] = createSignal(false);

  // Get current zoomed root for this pane (null = show all roots)
  const zoomedRootId = () => paneStore.getZoomedRootId(props.paneId);

  onMount(() => {
    console.log('Outliner mounted for pane:', props.paneId);
    const dispose = store.initFromYDoc(doc);
    onCleanup(dispose);
  });

  // Auto-create first block when workspace is empty
  createEffect(() => {
    if (isLoaded() && store.rootIds.length === 0) {
      const id = store.createInitialBlock();
      if (id) setFocusedBlockId(id);
    }
  });

  const handleFocus = (id: string) => {
    setFocusedBlockId(id);
  };

  const handleNavigateUp = (id: string) => {
    const prev = findPrevVisibleBlock(id, props.paneId);
    if (prev) setFocusedBlockId(prev);
  };

  const handleNavigateDown = (id: string) => {
    const next = findNextVisibleBlock(id, props.paneId);
    if (next) setFocusedBlockId(next);
  };

  return (
    <div class="outliner-container">
      <Show when={isLoaded()} fallback={<div class="ctx-empty-state">Loading workspace...</div>}>
        <Show when={store.rootIds.length > 0 || zoomedRootId()}>
          {/* Clear button - only show when not zoomed */}
          <Show when={!zoomedRootId()}>
            <div style={{ display: 'flex', "justify-content": 'flex-end', "margin-bottom": '4px', "padding-right": '4px' }}>
              <button
                class="ctx-retry-button"
                style={{
                  "font-size": "10px",
                  padding: "2px 6px",
                  border: '1px solid',
                  color: confirmClear() ? '#ef4444' : '#888',
                  "border-color": confirmClear() ? '#ef4444' : '#555',
                  background: confirmClear() ? 'rgba(239, 68, 68, 0.1)' : 'transparent'
                }}
                title="Clear entire workspace"
                onClick={() => {
                  if (confirmClear()) {
                    store.clearWorkspace();
                    setConfirmClear(false);
                  } else {
                    setConfirmClear(true);
                  }
                }}
                onMouseLeave={() => setConfirmClear(false)}
              >
                {confirmClear() ? 'Confirm?' : 'Clear'}
              </button>
            </div>
          </Show>

          {/* Zoomed view or full tree */}
          <Show
            when={zoomedRootId()}
            fallback={
              <Key each={store.rootIds} by={(id) => id}>
                {(rootId) => {
                  const id = rootId();
                  return (
                    <BlockItem
                      id={id}
                      paneId={props.paneId}
                      depth={0}
                      focusedBlockId={focusedBlockId()}
                      onFocus={handleFocus}
                      onNavigateUp={() => handleNavigateUp(id)}
                      onNavigateDown={() => handleNavigateDown(id)}
                    />
                  );
                }}
              </Key>
            }
          >
            {/* Zoomed: breadcrumb + single block subtree */}
            <Breadcrumb blockId={zoomedRootId()!} paneId={props.paneId} />
            <BlockItem
              id={zoomedRootId()!}
              paneId={props.paneId}
              depth={0}
              focusedBlockId={focusedBlockId()}
              onFocus={handleFocus}
              onNavigateUp={() => handleNavigateUp(zoomedRootId()!)}
              onNavigateDown={() => handleNavigateDown(zoomedRootId()!)}
            />
          </Show>
        </Show>
      </Show>
    </div>
  );
};
