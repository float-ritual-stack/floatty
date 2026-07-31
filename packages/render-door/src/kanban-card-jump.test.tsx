/**
 * KanbanCard jump-to-block affordance.
 *
 * A card is a handle for a subtree, not a leaf — detail accumulates under it
 * and the board had no way to reach it. Plain click is already edit and drag is
 * already move, so the jump gets its own ↗ affordance + ⌘/Ctrl+Enter.
 *
 * These assert the gesture contract (which event produces a navigate chirp, and
 * which must NOT), since that's where this feature can silently break.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render } from 'solid-js/web';
import { StateProvider } from '@json-render/solid';
import { KanbanCard } from './components';

let dispose: (() => void) | undefined;
let host: HTMLDivElement | undefined;

// `null` = "explicitly no block id". Passing `undefined` would re-apply the
// default, which is exactly how the no-id case silently passed at first.
function mountCard(blockIdArg: string | null = 'card-block-1') {
  const blockId = blockIdArg ?? undefined;
  host = document.createElement('div');
  document.body.appendChild(host);

  const chirps: Array<{ message: string; target?: string }> = [];
  host.addEventListener('chirp', (e: Event) => {
    const detail = (e as CustomEvent).detail as { message: string; target?: string };
    chirps.push({ message: detail.message, target: detail.target });
  });

  // KanbanCard uses useBoundProp → useStateStore, which requires the provider.
  dispose = render(
    () => (
      <StateProvider initialState={{}}>
        {KanbanCard({ props: { content: 'Demo Card', blockId }, bindings: undefined } as never)}
      </StateProvider>
    ),
    host
  );

  const card = host.querySelector<HTMLElement>('[data-kanban-card-id]') ?? host.firstElementChild as HTMLElement;
  return { card, chirps, host: host! };
}

afterEach(() => {
  dispose?.();
  host?.remove();
  dispose = undefined;
  host = undefined;
});

describe('KanbanCard — jump affordance', () => {
  it('renders an accessible ↗ button carrying the card block id', () => {
    const { host } = mountCard();
    const btn = host.querySelector<HTMLButtonElement>('button[aria-label*="outline" i]');
    expect(btn).toBeTruthy();
    expect(btn!.textContent).toContain('↗');
    // Native button, not a span+role: keyboard focus and Enter/Space activation
    // come for free, and `type` must be explicit so it never submits a form.
    expect(btn!.type).toBe('button');
  });

  it('keydown on the affordance does not leak to the card handler', () => {
    // The button turns Enter into a click itself; if the keydown also reached
    // the card, bare Enter would open the editor and ⌘↵ would double-navigate.
    const { host, chirps } = mountCard('card-block-1');
    const btn = host.querySelector<HTMLButtonElement>('button')!;

    btn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(host.querySelector('input')).toBeNull();

    btn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }));
    expect(chirps.filter(c => c.message === 'navigate')).toEqual([]);
  });

  it('clicking the affordance emits a navigate chirp for the card block', () => {
    const { host, chirps } = mountCard('card-block-1');
    const btn = host.querySelector<HTMLButtonElement>('button')!;

    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));

    expect(chirps).toContainEqual({ message: 'navigate', target: 'card-block-1' });
  });

  it('clicking the affordance does NOT enter edit mode (no input appears)', () => {
    // The card's own onClick enters edit; the affordance must stopPropagation.
    const { host } = mountCard();
    const btn = host.querySelector<HTMLButtonElement>('button')!;

    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));

    expect(host.querySelector('input')).toBeNull();
  });

  it('clicking the card BODY still edits and emits no navigate', () => {
    const { card, chirps, host } = mountCard();

    card.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));

    expect(host.querySelector('input')).toBeTruthy();
    expect(chirps.filter(c => c.message === 'navigate')).toEqual([]);
  });

  it('⌘/Ctrl+Enter navigates; bare Enter edits', () => {
    const { card, chirps, host } = mountCard('card-block-1');

    card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }));
    expect(chirps).toContainEqual({ message: 'navigate', target: 'card-block-1' });
    expect(host.querySelector('input')).toBeNull();

    card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(host.querySelector('input')).toBeTruthy();
  });

  it('omits the affordance when the card has no block id to jump to', () => {
    const { host } = mountCard(null);
    expect(host.querySelector('button')).toBeNull();
  });
});
