/**
 * CommandBar component tests
 * FLO-276
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@solidjs/testing-library';

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
    const { getByRole } = render(() => (
      <CommandBar onClose={onClose} onNavigate={onNavigate} onCommand={onCommand} />
    ));
    const listbox = getByRole('listbox');
    // 3 pages + 4 commands = 7
    expect(listbox.children.length).toBe(7);
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
    // Type "export" to filter to only commands
    fireEvent.input(input, { target: { value: 'export json' } });
    // FLO-400: Typed text is position 0, arrow down to reach the command
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommand).toHaveBeenCalledWith('export-json');
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('Enter without ArrowDown on matching command creates page, not command (FLO-400)', () => {
    const { getByPlaceholderText } = render(() => (
      <CommandBar onClose={onClose} onNavigate={onNavigate} onCommand={onCommand} />
    ));
    const input = getByPlaceholderText('Search pages or commands...');
    fireEvent.input(input, { target: { value: 'export json' } });
    // Without ArrowDown, typed text at position 0 is selected — fires onNavigate, not onCommand
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommand).not.toHaveBeenCalled();
    expect(onNavigate).toHaveBeenCalledWith('export json');
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
    // Last item (index 6) should be selected
    expect(options[6].getAttribute('aria-selected')).toBe('true');
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
    expect(shortcuts.length).toBe(4); // 4 commands have shortcuts
  });

  it('command items have command class', () => {
    const { container } = render(() => (
      <CommandBar onClose={onClose} onNavigate={onNavigate} onCommand={onCommand} />
    ));
    const commandItems = container.querySelectorAll('.command-bar-command');
    expect(commandItems.length).toBe(4);
  });
});
