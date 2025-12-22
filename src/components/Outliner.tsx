import { Component, For, createSignal, onMount, Show } from 'solid-js';
import { useSyncedYDoc } from '../hooks/useSyncedYDoc';
import { useBlockStore } from '../hooks/useBlockStore';
import { BlockItem } from './BlockItem';

interface OutlinerProps {
  paneId: string;
}

export const Outliner: Component<OutlinerProps> = (props) => {
  const { doc, isLoaded } = useSyncedYDoc();
  const store = useBlockStore();
  const [focusedBlockId, setFocusedBlockId] = createSignal<string | null>(null);

  onMount(() => {
    console.log('Outliner mounted for pane:', props.paneId);
    store.initFromYDoc(doc);
  });

  const handleFocus = (id: string) => {
    setFocusedBlockId(id);
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
                  // Create first block if empty
                  // const id = store.createInitialBlock();
                }}
              >
                Create first block
              </button>
            </div>
          }
        >
          <For each={store.rootIds}>
            {(rootId) => (
              <BlockItem
                id={rootId}
                depth={0}
                isFocused={focusedBlockId() === rootId}
                onFocus={handleFocus}
              />
            )}
          </For>
        </Show>
      </Show>
    </div>
  );
};
