import { Component, For, Show, createMemo } from 'solid-js';
import { useBlockStore } from '../hooks/useBlockStore';

interface BlockItemProps {
  id: string;
  depth: number;
  isFocused: boolean;
  onFocus: (id: string) => void;
}

export const BlockItem: Component<BlockItemProps> = (props) => {
  const store = useBlockStore();
  const block = createMemo(() => store.blocks.get(props.id));

  const handleKeyDown = (e: KeyboardEvent) => {
    if (!block()) return;

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const newId = store.createBlockAfter(props.id);
      if (newId) {
        props.onFocus(newId);
      }
    } else if (e.key === 'Tab') {
      e.preventDefault();
      if (e.shiftKey) {
        store.outdentBlock(props.id);
      } else {
        store.indentBlock(props.id);
      }
    } else if (e.key === 'Backspace' && block()?.content === '' && block()?.childIds.length === 0) {
      // Logic for deletion on backspace if empty
      // Need to find previous block to focus first
      // store.deleteBlock(props.id);
    }
  };

  const handleInput = (e: InputEvent) => {
    const target = e.target as HTMLDivElement;
    store.updateBlockContent(props.id, target.innerText);
  };

  const indicatorClass = () => {
    const type = block()?.type;
    if (!type) return '';
    return `block-indicator-${type}`;
  };

  return (
    <div class="block-wrapper">
      <div 
        class="block-item" 
        classList={{ 'block-focused': props.isFocused }}
        onClick={() => props.onFocus(props.id)}
      >
        <div 
          class="block-bullet"
          onClick={(e) => {
            e.stopPropagation();
            store.toggleCollapsed(props.id);
          }}
        >
          <Show when={block()?.childIds.length && block()?.childIds.length > 0}>
            {block()?.collapsed ? '▸' : '▾'}
          </Show>
        </div>

        <div class={`block-indicator ${indicatorClass()}`} />

        <div class="block-content-wrapper">
          <div
            contentEditable
            class="block-content"
            onInput={handleInput}
            onKeyDown={handleKeyDown}
            onFocus={() => props.onFocus(props.id)}
          >
            {block()?.content}
          </div>
        </div>
      </div>

      <Show when={!block()?.collapsed && block()?.childIds.length && block()?.childIds.length > 0}>
        <div class="block-children">
          <For each={block()?.childIds}>
            {(childId) => (
              <BlockItem
                id={childId}
                depth={props.depth + 1}
                isFocused={false} // Focus state handled by parent for now
                onFocus={props.onFocus}
              />
            )}
          </For>
        </div>
      </Show>
    </div>
  );
};
