/**
 * CommandBar - Modal command palette overlay (⌘K)
 *
 * Unified list: pages (goto) + built-in commands (export, etc.)
 * Uses useCommandBar hook for state, delegates actions to parent.
 *
 * FLO-276
 */

import { Show, For, onMount, createEffect, on } from 'solid-js';
import { useCommandBar } from '../hooks/useCommandBar';
import type { ResultItem } from '../hooks/useCommandBar';

interface CommandBarProps {
  onClose: () => void;
  onNavigate: (pageName: string) => void;
  onCommand: (commandId: string) => void;
}

export function CommandBar(props: CommandBarProps) {
  const bar = useCommandBar();
  let inputRef: HTMLInputElement | undefined;
  let listRef: HTMLUListElement | undefined;

  onMount(() => {
    inputRef?.focus();
  });

  // Scroll selected item into view
  createEffect(on(() => bar.selectedIndex(), () => {
    const el = listRef?.children[bar.selectedIndex()] as HTMLElement | undefined;
    el?.scrollIntoView?.({ block: 'nearest' });
  }, { defer: true }));

  const handleSelect = (item: ResultItem) => {
    if (item.type === 'command') {
      props.onCommand(item.id);
    } else {
      props.onNavigate(item.label);
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        bar.navigate('down');
        break;
      case 'ArrowUp':
        e.preventDefault();
        bar.navigate('up');
        break;
      case 'Enter': {
        e.preventDefault();
        const selected = bar.getSelection();
        if (selected) {
          handleSelect(selected);
        }
        break;
      }
      case 'Escape':
        e.preventDefault();
        props.onClose();
        break;
    }
  };

  const hasResults = () => bar.filteredResults().length > 0;

  return (
    <div class="command-bar-scrim" onClick={() => props.onClose()}>
      <div class="command-bar" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          class="command-bar-input"
          type="text"
          placeholder="Search pages or commands..."
          value={bar.query()}
          onInput={(e) => bar.setQuery(e.currentTarget.value)}
          onKeyDown={handleKeyDown}
          role="combobox"
          aria-expanded={hasResults()}
          aria-controls="command-bar-listbox"
          aria-activedescendant={
            hasResults()
              ? `command-bar-item-${bar.selectedIndex()}`
              : undefined
          }
          autocomplete="off"
          spellcheck={false}
        />
        <Show when={hasResults()}>
          <ul ref={listRef} class="command-bar-list" role="listbox" id="command-bar-listbox">
            <For each={bar.filteredResults()}>
              {(item, i) => (
                <li
                  id={`command-bar-item-${i()}`}
                  class="command-bar-item"
                  classList={{
                    'command-bar-selected': i() === bar.selectedIndex(),
                    'command-bar-command': item.type === 'command',
                    'command-bar-create': item.isCreate === true,
                  }}
                  role="option"
                  aria-selected={i() === bar.selectedIndex()}
                  onPointerMove={() => bar.setSelectedIndex(i())}
                  onClick={() => handleSelect(item)}
                >
                  <span class="command-bar-item-label">{item.label}</span>
                  <Show when={item.isCreate}>
                    <span class="command-bar-item-badge">Create</span>
                  </Show>
                  <Show when={item.shortcut}>
                    <span class="command-bar-item-shortcut">{item.shortcut}</span>
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </div>
    </div>
  );
}
