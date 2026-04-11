/**
 * CommandBar - Modal command palette overlay (⌘K)
 *
 * Uses cmdk-solid for keyboard navigation + ARIA.
 * Uses useCommandBar for fuzzy filtering and result ordering.
 * shouldFilter={false}: we control what items appear, cmdk controls navigation.
 *
 * FLO-276
 */

import { For, Show, createEffect, createSignal, on, onMount } from 'solid-js';
import { Command } from 'cmdk-solid';
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

  // Track currently highlighted item id (controlled Command value)
  const [selectedId, setSelectedId] = createSignal('');

  // Reset selection to first result whenever results change
  createEffect(on(bar.filteredResults, (results) => {
    setSelectedId(results[0]?.id ?? '');
  }));

  onMount(() => {
    inputRef?.focus();
  });

  const handleSelect = (item: ResultItem) => {
    if (item.type === 'command') {
      props.onCommand(item.id);
    } else {
      props.onNavigate(item.label);
    }
  };

  const handleItemSelect = (id: string) => {
    const item = bar.filteredResults().find(r => r.id === id);
    if (item) handleSelect(item);
  };

  // Tab: autocomplete highlighted item label into query
  // Escape: close bar
  // Arrow/Enter: delegated to cmdk root via event bubbling
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const item = bar.filteredResults().find(r => r.id === selectedId());
      if (item) bar.setQuery(item.label);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      props.onClose();
    }
  };

  return (
    <div class="command-bar-scrim" onClick={() => props.onClose()}>
      <Command
        class="command-bar"
        shouldFilter={false}
        loop
        value={selectedId()}
        onValueChange={setSelectedId}
        onClick={(e) => e.stopPropagation()}
      >
        <Command.Input
          ref={inputRef}
          class="command-bar-input"
          placeholder="Search pages or commands..."
          value={bar.query()}
          onValueChange={bar.setQuery}
          onKeyDown={handleKeyDown}
          autocomplete="off"
          spellcheck={false}
        />
        <Command.List class="command-bar-list">
          <Command.Empty class="command-bar-empty">No results</Command.Empty>
          <For each={bar.filteredResults()}>
            {(item) => (
              <Command.Item
                value={item.id}
                class="command-bar-item"
                classList={{
                  'command-bar-command': item.type === 'command',
                  'command-bar-create': item.isCreate === true,
                }}
                onSelect={() => handleItemSelect(item.id)}
              >
                <span class="command-bar-item-label">{item.label}</span>
                <Show when={item.isCreate}>
                  <span class="command-bar-item-badge">Create</span>
                </Show>
                <Show when={item.shortcut}>
                  <span class="command-bar-item-shortcut">{item.shortcut}</span>
                </Show>
              </Command.Item>
            )}
          </For>
        </Command.List>
      </Command>
    </div>
  );
}
