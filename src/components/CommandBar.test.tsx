/**
 * CommandBar component tests
 * FLO-276
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@solidjs/testing-library';
import type { JSX } from 'solid-js';

// Mock dependencies
vi.mock('../hooks/useBlockStore', () => ({
  blockStore: {},
}));

vi.mock('../hooks/useWikilinkAutocomplete', () => ({
  getPageNamesWithTimestamps: vi.fn(() => [
    { name: 'Daily Notes', updatedAt: 100 },
    { name: 'Project Ideas', updatedAt: 300 },
    { name: 'Meeting Notes', updatedAt: 200 },
  ]),
}));

// Mock cmdk-solid: thin wrappers that let our component logic run without
// pulling in @kobalte/core and its directory-import incompatibilities in jsdom.
// We simulate cmdk's controlled `value` / `onValueChange` / keyboard navigation.
vi.mock('cmdk-solid', () => {
  type ItemProps = {
    value?: string;
    onSelect?: () => void;
    class?: string;
    classList?: Record<string, boolean>;
    children?: JSX.Element;
  };
  type InputProps = {
    ref?: (el: HTMLInputElement) => void;
    value?: string;
    onValueChange?: (v: string) => void;
    onKeyDown?: (e: KeyboardEvent) => void;
    placeholder?: string;
    class?: string;
    autocomplete?: string;
    spellcheck?: boolean;
  };
  type RootProps = {
    class?: string;
    shouldFilter?: boolean;
    loop?: boolean;
    value?: string;
    onValueChange?: (v: string) => void;
    onClick?: (e: MouseEvent) => void;
    children?: JSX.Element;
  };
  type ListProps = { class?: string; children?: JSX.Element };
  type EmptyProps = { class?: string; children?: JSX.Element };

  // Track registered items for keyboard navigation (ArrowUp/Down/Enter on root)
  // Scoped per Command instance, cleaned up via onCleanup in Item
  let itemRegistry: Map<string, { onSelect: () => void; el: HTMLElement }> = new Map();

  const Input = (props: InputProps) => {
    return (
      <input
        ref={props.ref}
        class={props.class}
        placeholder={props.placeholder}
        value={props.value ?? ''}
        autocomplete={props.autocomplete}
        spellcheck={props.spellcheck}
        onInput={(e) => props.onValueChange?.(e.currentTarget.value)}
        onKeyDown={(e) => props.onKeyDown?.(e)}
      />
    );
  };

  const Item = (props: ItemProps) => {
    const classObj: Record<string, boolean> = {
      ...(props.class ? { [props.class]: true } : {}),
      ...(props.classList ?? {}),
    };
    const classStr = Object.keys(classObj).filter(k => classObj[k]).join(' ');

    return (
      <div
        ref={(r) => {
          if (props.value) {
            // Register for keyboard nav. Enter uses props.value lookup, so stale
            // entries are harmless — the correct entry wins by key.
            itemRegistry.set(props.value, { onSelect: props.onSelect ?? (() => {}), el: r });
          }
        }}
        role="option"
        aria-selected={false}
        class={classStr}
        data-value={props.value}
        onClick={() => props.onSelect?.()}
        onPointerMove={() => {}}
      >
        {props.children}
      </div>
    );
  };

  const List = (props: ListProps) => (
    <div role="listbox" class={props.class}>
      {props.children}
    </div>
  );

  const Empty = (props: EmptyProps) => (
    <div role="status" class={props.class}>{props.children}</div>
  );

  const Command = (props: RootProps) => {
    itemRegistry = new Map();
    let currentIndex = 0;

    const getOrderedItems = () => Array.from(itemRegistry.values());

    const handleKeyDown = (e: KeyboardEvent) => {
      const items = getOrderedItems();
      if (items.length === 0) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        currentIndex = props.loop
          ? (currentIndex + 1) % items.length
          : Math.min(currentIndex + 1, items.length - 1);
        items.forEach((item, i) => {
          item.el.setAttribute('aria-selected', String(i === currentIndex));
        });
        const keys = Array.from(itemRegistry.keys());
        props.onValueChange?.(keys[currentIndex]);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        currentIndex = props.loop
          ? (currentIndex - 1 + items.length) % items.length
          : Math.max(currentIndex - 1, 0);
        items.forEach((item, i) => {
          item.el.setAttribute('aria-selected', String(i === currentIndex));
        });
        const keys = Array.from(itemRegistry.keys());
        props.onValueChange?.(keys[currentIndex]);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        // Use controlled value (props.value = selectedId() signal) to find selected item.
        // Props in SolidJS are reactive getters — reads current signal value.
        const v = props.value;
        const byValue = v ? itemRegistry.get(v) : undefined;
        const selected = byValue ?? getOrderedItems()[currentIndex];
        if (selected) selected.onSelect();
      }
    };

    return (
      <div
        class={props.class}
        onClick={props.onClick}
        onKeyDown={handleKeyDown}
      >
        {props.children}
      </div>
    );
  };

  Command.Input = Input;
  Command.List = List;
  Command.Item = Item;
  Command.Empty = Empty;

  return { Command };
});

import { CommandBar } from './CommandBar';

describe('CommandBar', () => {
  let onClose: ReturnType<typeof vi.fn>;
  let onNavigate: ReturnType<typeof vi.fn>;
  let onCommand: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onClose = vi.fn();
    onNavigate = vi.fn();
    onCommand = vi.fn();
  });

  it('renders input with placeholder', () => {
    const { getByPlaceholderText } = render(() => (
      <CommandBar onClose={onClose} onNavigate={onNavigate} onCommand={onCommand} />
    ));
    expect(getByPlaceholderText('Search pages or commands...')).toBeTruthy();
  });

  it('shows pages and commands when query is empty', () => {
    const { getAllByRole } = render(() => (
      <CommandBar onClose={onClose} onNavigate={onNavigate} onCommand={onCommand} />
    ));
    // 3 pages + 13 commands = 16 options
    // (Command.List wraps items in a cmdk-list-sizer div, so count via role)
    expect(getAllByRole('option').length).toBe(16);
  });

  it('Escape calls onClose', () => {
    const { getByPlaceholderText } = render(() => (
      <CommandBar onClose={onClose} onNavigate={onNavigate} onCommand={onCommand} />
    ));
    fireEvent.keyDown(getByPlaceholderText('Search pages or commands...'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('Enter with page selected calls onNavigate', () => {
    const { getByPlaceholderText } = render(() => (
      <CommandBar onClose={onClose} onNavigate={onNavigate} onCommand={onCommand} />
    ));
    // Default selection is first item (most recent page)
    fireEvent.keyDown(getByPlaceholderText('Search pages or commands...'), { key: 'Enter' });
    expect(onNavigate).toHaveBeenCalledWith('Project Ideas');
    expect(onCommand).not.toHaveBeenCalled();
  });

  it('Enter with command selected calls onCommand', () => {
    const { getByPlaceholderText } = render(() => (
      <CommandBar onClose={onClose} onNavigate={onNavigate} onCommand={onCommand} />
    ));
    const input = getByPlaceholderText('Search pages or commands...');
    fireEvent.input(input, { target: { value: 'export json' } });
    // FLO-466: Commands are at position 0 when matched — Enter fires command without ArrowDown
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommand).toHaveBeenCalledWith('export-json');
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('Enter without ArrowDown on matching command selects command (FLO-466)', () => {
    const { getByPlaceholderText } = render(() => (
      <CommandBar onClose={onClose} onNavigate={onNavigate} onCommand={onCommand} />
    ));
    const input = getByPlaceholderText('Search pages or commands...');
    fireEvent.input(input, { target: { value: 'export json' } });
    // FLO-466: Commands first — Enter selects command at position 0, not create-page
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommand).toHaveBeenCalledWith('export-json');
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('Enter with novel query navigates to typed text (create page) (FLO-400)', () => {
    const { getByPlaceholderText } = render(() => (
      <CommandBar onClose={onClose} onNavigate={onNavigate} onCommand={onCommand} />
    ));
    const input = getByPlaceholderText('Search pages or commands...');
    fireEvent.input(input, { target: { value: 'brand new page' } });
    // Typed text is position 0 (selectedIndex defaults to 0), so Enter selects it
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onNavigate).toHaveBeenCalledWith('brand new page');
  });

  it('ArrowDown moves selection', () => {
    const { getByPlaceholderText, getAllByRole } = render(() => (
      <CommandBar onClose={onClose} onNavigate={onNavigate} onCommand={onCommand} />
    ));
    const input = getByPlaceholderText('Search pages or commands...');
    fireEvent.keyDown(input, { key: 'ArrowDown' });

    const options = getAllByRole('option');
    expect(options[1].getAttribute('aria-selected')).toBe('true');
  });

  it('ArrowUp wraps to last item', () => {
    const { getByPlaceholderText, getAllByRole } = render(() => (
      <CommandBar onClose={onClose} onNavigate={onNavigate} onCommand={onCommand} />
    ));
    const input = getByPlaceholderText('Search pages or commands...');
    fireEvent.keyDown(input, { key: 'ArrowUp' });

    const options = getAllByRole('option');
    // Last item should be selected (wraps around from top)
    expect(options[15].getAttribute('aria-selected')).toBe('true');
  });

  it('clicking scrim calls onClose', () => {
    const { container } = render(() => (
      <CommandBar onClose={onClose} onNavigate={onNavigate} onCommand={onCommand} />
    ));
    const scrim = container.querySelector('.command-bar-scrim')!;
    fireEvent.click(scrim);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('clicking a page result calls onNavigate', () => {
    const { getAllByRole } = render(() => (
      <CommandBar onClose={onClose} onNavigate={onNavigate} onCommand={onCommand} />
    ));
    const options = getAllByRole('option');
    fireEvent.click(options[1]); // "Meeting Notes" (second by recency)
    expect(onNavigate).toHaveBeenCalledWith('Meeting Notes');
  });

  it('clicking a command result calls onCommand', () => {
    const { getAllByRole } = render(() => (
      <CommandBar onClose={onClose} onNavigate={onNavigate} onCommand={onCommand} />
    ));
    const options = getAllByRole('option');
    fireEvent.click(options[3]); // First command (Export JSON)
    expect(onCommand).toHaveBeenCalledWith('export-json');
  });

  it('shows Create badge on typed text item for novel query (FLO-400)', () => {
    const { getByPlaceholderText, container } = render(() => (
      <CommandBar onClose={onClose} onNavigate={onNavigate} onCommand={onCommand} />
    ));
    fireEvent.input(getByPlaceholderText('Search pages or commands...'), { target: { value: 'zzz' } });
    // Typed text item should have .command-bar-create class and Create badge
    const createItem = container.querySelector('.command-bar-create');
    expect(createItem).toBeTruthy();
    const badge = createItem!.querySelector('.command-bar-item-badge');
    expect(badge).toBeTruthy();
    expect(badge!.textContent).toBe('Create');
    expect(createItem!.textContent).toContain('zzz');
  });

  it('commands show shortcut hints', () => {
    const { container } = render(() => (
      <CommandBar onClose={onClose} onNavigate={onNavigate} onCommand={onCommand} />
    ));
    const shortcuts = container.querySelectorAll('.command-bar-item-shortcut');
    expect(shortcuts.length).toBe(6); // 6 commands have shortcuts
  });

  it('command items have command class', () => {
    const { container } = render(() => (
      <CommandBar onClose={onClose} onNavigate={onNavigate} onCommand={onCommand} />
    ));
    const commandItems = container.querySelectorAll('.command-bar-command');
    expect(commandItems.length).toBe(13);
  });
});
