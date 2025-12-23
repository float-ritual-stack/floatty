import { For, createSignal, onMount, Show } from 'solid-js';
import { useSyncedYDoc } from '../hooks/useSyncedYDoc';
import { blockStore } from '../hooks/useBlockStore';
import { useBlockOperations } from '../hooks/useBlockOperations';
import { BlockItem } from './BlockItem';

interface OutlinerProps {
  paneId: string;
}

export function Outliner(props: OutlinerProps) {
  const { doc, isLoaded } = useSyncedYDoc();
  const store = blockStore;
  const { findNextVisibleBlock, findPrevVisibleBlock } = useBlockOperations();
  const [focusedBlockId, setFocusedBlockId] = createSignal<string | null>(null);

  onMount(() => {
    console.log('Outliner mounted for pane:', props.paneId);
    store.initFromYDoc(doc);
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
        <Show 
          when={store.rootIds.length > 0} 
          fallback={
            <div class="ctx-empty-state">
              Empty workspace. 
              <button 
                class="ctx-retry-button" 
                style="margin-top: 8px"
                onClick={() => {
                  const id = store.createInitialBlock();
                  if (id) setFocusedBlockId(id);
                }}
              >
                Create first block
              </button>
            </div>
          }
        >
          <div style={{ display: 'flex', "justify-content": 'flex-end', "margin-bottom": '4px', "padding-right": '4px' }}>
            <button 
              class="ctx-retry-button"
              style={{ "font-size": "10px", padding: "2px 6px", opacity: 0.6, border: '1px solid #2a2a4a' }}
              title="Clear entire workspace"
              onClick={() => {
                if (confirm('Clear entire workspace? This cannot be undone.')) {
                  store.clearWorkspace();
                }
              }}
            >
              Clear All
            </button>
          </div>
          <For each={store.rootIds}>
            {(rootId) => (
              <BlockItem
                id={rootId}
                paneId={props.paneId}
                depth={0}
                focusedBlockId={focusedBlockId()}
                onFocus={handleFocus}
                onNavigateUp={() => handleNavigateUp(rootId)}
                onNavigateDown={() => handleNavigateDown(rootId)}
              />
            )}
          </For>
        </Show>
      </Show>
    </div>
  );
};
