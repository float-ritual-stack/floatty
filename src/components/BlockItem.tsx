import { For, Show, createMemo, createEffect } from 'solid-js';
import { blockStore } from '../hooks/useBlockStore';
import { paneStore } from '../hooks/usePaneStore';
import { useBlockOperations } from '../hooks/useBlockOperations';
import { 
  isExecutableShellBlock, extractShellCommand, executeShellBlock,
  isExecutableAiBlock, extractAiPrompt, executeAiBlock
} from '../lib/executor';

interface BlockItemProps {
  id: string;
  paneId: string;
  depth: number;
  focusedBlockId: string | null;
  onFocus: (id: string) => void;
}

export function BlockItem(props: BlockItemProps) {
  const store = blockStore;
  const { findNextVisibleBlock, findPrevVisibleBlock } = useBlockOperations();
  const block = createMemo(() => store.blocks[props.id]);
  const isFocused = createMemo(() => props.focusedBlockId === props.id);
  const isCollapsed = createMemo(() => paneStore.isCollapsed(props.paneId, props.id, block()?.collapsed || false));
  let contentRef: HTMLDivElement | undefined;

  // Handle focus changes from props
  createEffect(() => {
    if (isFocused() && contentRef) {
      requestAnimationFrame(() => {
        contentRef?.focus();
      });
    }
  });

  // Sync content from store to DOM, but respect focus to prevent cursor jumps
  createEffect(() => {
    const currentBlock = block();
    if (contentRef && currentBlock) {
      if (contentRef.textContent !== currentBlock.content) {
        if (document.activeElement !== contentRef) {
           contentRef.textContent = currentBlock.content;
        }
      }
    }
  });

  const handleKeyDown = (e: KeyboardEvent) => {
    if (!block()) return;

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prev = findPrevVisibleBlock(props.id, props.paneId);
      if (prev) props.onFocus(prev);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = findNextVisibleBlock(props.id, props.paneId);
      if (next) props.onFocus(next);
    } else if (e.key === 'Enter' && !e.shiftKey) {
      if (e.metaKey || e.ctrlKey) {
        // Execute block if it's executable
        if (block()) {
          const content = block()!.content;
          
          if (isExecutableShellBlock(content)) {
            e.preventDefault();
            const command = extractShellCommand(content);
            if (command) {
              executeShellBlock(props.id, command, {
                createBlockInside: store.createBlockInside,
                createBlockInsideAtTop: store.createBlockInsideAtTop,
                updateBlockContent: store.updateBlockContent
              });
            }
          } else if (isExecutableAiBlock(content)) {
            e.preventDefault();
            const prompt = extractAiPrompt(content);
            if (prompt) {
              executeAiBlock(props.id, prompt, {
                createBlockInside: store.createBlockInside,
                createBlockInsideAtTop: store.createBlockInsideAtTop,
                updateBlockContent: store.updateBlockContent
              });
            }
          }
        }
        return;
      }
      e.preventDefault();
      
      const selection = window.getSelection();
      const offset = selection?.anchorOffset || 0;
      
      const newId = store.splitBlock(props.id, offset);
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
    } else if (e.key === 'Backspace') {
      const selection = window.getSelection();
      const isAtStart = selection?.anchorOffset === 0 && selection?.isCollapsed;
      
      if (isAtStart) {
          // Merge with previous block
          const prevId = findPrevVisibleBlock(props.id, props.paneId);
          if (prevId) {
             const prevBlock = store.blocks[prevId];
             if (prevBlock) {
                e.preventDefault();
                const oldContent = block()?.content || '';
                const prevContentLength = prevBlock.content.length;
                const prevContent = prevBlock.content;
                
                // Update previous block content
                store.updateBlockContent(prevId, prevContent + oldContent);
                
                // Delete current block
                store.deleteBlock(props.id);
                
                // Focus previous block
                props.onFocus(prevId);
                
                // Restore cursor position
                requestAnimationFrame(() => {
                   const el = document.activeElement as HTMLElement;
                   // Use textContent check instead of innerText
                   if (el && el.textContent === prevContent + oldContent) {
                      const range = document.createRange();
                      const sel = window.getSelection();
                      if (el.firstChild) {
                        try {
                          range.setStart(el.firstChild, prevContentLength);
                          range.collapse(true);
                          sel?.removeAllRanges();
                          sel?.addRange(range);
                        } catch {
                          // Ignore range errors
                        }
                      } else if (prevContentLength === 0) {
                         // Empty block, cursor at start
                      }
                   }
                });
             }
          }
      }
    }
  };

  const handleInput = (e: InputEvent) => {
    const target = e.target as HTMLDivElement;
    store.updateBlockContent(props.id, target.textContent || '');
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
        data-type={block()?.type}
        classList={{ 'block-focused': isFocused() }}
        onClick={() => props.onFocus(props.id)}
      >
        <div 
          class="block-bullet"
          onClick={(e) => {
            e.stopPropagation();
            paneStore.toggleCollapsed(props.paneId, props.id);
          }}
        >
          <Show when={block()?.childIds.length && block()?.childIds.length > 0}>
            {isCollapsed() ? '▸' : '▾'}
          </Show>
        </div>

        <div class={`block-indicator ${indicatorClass()}`} />

        <div class="block-content-wrapper">
          <Show when={block()?.type === 'ctx' && block()?.metadata}>
            <div class="block-ctx-meta">
              <span class="ctx-marker-time">{block()?.metadata?.time}</span>
              <div class="ctx-marker-tags">
                <Show when={block()?.metadata?.project}>
                  <span class="ctx-tag ctx-tag-project">{block()?.metadata?.project}</span>
                </Show>
                <Show when={block()?.metadata?.mode}>
                  <span class="ctx-tag ctx-tag-mode">{block()?.metadata?.mode}</span>
                </Show>
                <Show when={block()?.metadata?.issue}>
                  <span class="ctx-tag ctx-tag-issue">{block()?.metadata?.issue}</span>
                </Show>
              </div>
            </div>
          </Show>
          <div
            ref={contentRef}
            contentEditable
            class="block-content"
            spellcheck={false}
            autocapitalize="off"
            autocorrect="off"
            onInput={handleInput}
            onKeyDown={handleKeyDown}
            onFocus={() => props.onFocus(props.id)}
          />
        </div>
      </div>

      <Show when={!isCollapsed() && block()?.childIds.length && block()?.childIds.length > 0}>
        <div class="block-children">
          <For each={block()?.childIds}>
            {(childId) => (
              <BlockItem
                id={childId}
                paneId={props.paneId}
                depth={props.depth + 1}
                focusedBlockId={props.focusedBlockId}
                onFocus={props.onFocus}
              />
            )}
          </For>
        </div>
      </Show>
    </div>
  );
};