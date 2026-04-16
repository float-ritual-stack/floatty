/**
 * FLO-587 — render:: kanban baseline spec shape.
 *
 * Locks the current (pre-two-way-binding) kanbanSpec output so later units
 * that extend the spec (state + bindings, drag handlers) have a regression
 * fence. Fixtures are synthetic ("Demo Todo", "Card 1") per
 * .claude/rules/test-fixtures-no-pii.md.
 */
import { describe, it, expect, vi } from 'vitest';
import { kanbanSpec, handleRenderStateChange } from './render';

interface Block {
  id: string;
  content: string;
  childIds: string[];
  parentId?: string | null;
}

function makeFixture(): { root: Block; blocks: Map<string, Block> } {
  const blocks = new Map<string, Block>();

  const root: Block = {
    id: 'board-root',
    content: 'Demo Board',
    childIds: ['col-todo', 'col-doing', 'col-done'],
    parentId: null,
  };
  blocks.set(root.id, root);

  const columns = [
    { id: 'col-todo', content: 'Todo', cards: ['t1', 't2'] },
    { id: 'col-doing', content: 'Doing', cards: ['d1', 'd2'] },
    { id: 'col-done', content: 'Done', cards: ['n1'] },
  ];

  for (const col of columns) {
    blocks.set(col.id, {
      id: col.id,
      content: col.content,
      childIds: col.cards,
      parentId: root.id,
    });
    col.cards.forEach((cardId, idx) => {
      blocks.set(cardId, {
        id: cardId,
        content: `Card ${col.content}-${idx + 1}`,
        childIds: [],
        parentId: col.id,
      });
    });
  }

  return { root, blocks };
}

function makeActions(blocks: Map<string, Block>, rootIds: string[]) {
  return {
    getBlock: (id: string) => blocks.get(id),
    getChildren: (id: string) => blocks.get(id)?.childIds ?? [],
    rootIds: () => rootIds,
  };
}

describe('kanbanSpec — baseline shape (pre-FLO-587 wiring)', () => {
  it('produces a layout root with header + columns', () => {
    const { root, blocks } = makeFixture();
    const actions = makeActions(blocks, [root.id]);

    const spec = kanbanSpec(root.id, actions);

    expect(spec.root).toBe('layout');
    expect(spec.elements.layout).toMatchObject({
      type: 'Stack',
      children: ['header', 'columns'],
    });
    expect(spec.elements.header).toMatchObject({
      type: 'Text',
      props: expect.objectContaining({ content: 'Demo Board' }),
    });
  });

  it('produces one column per direct child, panel-wrapped with count in title', () => {
    const { root, blocks } = makeFixture();
    const actions = makeActions(blocks, [root.id]);

    const spec = kanbanSpec(root.id, actions);

    expect(spec.elements.columns).toMatchObject({
      type: 'Stack',
      props: expect.objectContaining({ direction: 'horizontal' }),
      children: ['col-0', 'col-1', 'col-2'],
    });

    expect(spec.elements['col-0']).toMatchObject({
      type: 'TuiPanel',
      props: expect.objectContaining({ title: 'Todo (2)' }),
    });
    expect(spec.elements['col-1'].props.title).toBe('Doing (2)');
    expect(spec.elements['col-2'].props.title).toBe('Done (1)');
  });

  it('produces one card element per grandchild, keyed col-N-card-M', () => {
    const { root, blocks } = makeFixture();
    const actions = makeActions(blocks, [root.id]);

    const spec = kanbanSpec(root.id, actions);

    expect(spec.elements['col-0-card-0']).toMatchObject({
      type: 'Text',
      props: expect.objectContaining({ content: 'Card Todo-1' }),
    });
    expect(spec.elements['col-0-card-1'].props.content).toBe('Card Todo-2');
    expect(spec.elements['col-2-card-0'].props.content).toBe('Card Done-1');
  });

  it('populates spec.state.cards keyed by block id with current content', () => {
    const { root, blocks } = makeFixture();
    const actions = makeActions(blocks, [root.id]);

    const spec = kanbanSpec(root.id, actions);

    expect(spec.state).toBeDefined();
    expect(spec.state!.cards).toEqual({
      t1: { content: 'Card Todo-1' },
      t2: { content: 'Card Todo-2' },
      d1: { content: 'Card Doing-1' },
      d2: { content: 'Card Doing-2' },
      n1: { content: 'Card Done-1' },
    });
    // No column or root entries — state.cards is only cards, not columns.
    expect(spec.state!.cards).not.toHaveProperty('col-todo');
    expect(spec.state!.cards).not.toHaveProperty('board-root');
  });

  it('emits bindings: { content: "/cards/<id>/content" } on each card element', () => {
    const { root, blocks } = makeFixture();
    const actions = makeActions(blocks, [root.id]);

    const spec = kanbanSpec(root.id, actions);

    expect(spec.elements['col-0-card-0'].bindings).toEqual({
      content: '/cards/t1/content',
    });
    expect(spec.elements['col-1-card-1'].bindings).toEqual({
      content: '/cards/d2/content',
    });
    expect(spec.elements['col-2-card-0'].bindings).toEqual({
      content: '/cards/n1/content',
    });
  });

  it('does not bind non-card elements (header, columns, panels, stacks)', () => {
    const { root, blocks } = makeFixture();
    const actions = makeActions(blocks, [root.id]);

    const spec = kanbanSpec(root.id, actions);

    expect(spec.elements.header.bindings).toBeUndefined();
    expect(spec.elements.layout.bindings).toBeUndefined();
    expect(spec.elements.columns.bindings).toBeUndefined();
    expect(spec.elements['col-0'].bindings).toBeUndefined();
    expect(spec.elements['col-0-stack'].bindings).toBeUndefined();
  });

  it('state.cards keys match blockIds referenced in bindings paths (round-trip consistency)', () => {
    const { root, blocks } = makeFixture();
    const actions = makeActions(blocks, [root.id]);

    const spec = kanbanSpec(root.id, actions);

    // For every card element, the blockId in its binding path MUST exist
    // in spec.state.cards — otherwise outside-in updates can't hydrate
    // and inside-out writes can't be round-tripped back through.
    for (const [, element] of Object.entries(spec.elements)) {
      const el = element as { type: string; bindings?: { content?: string } };
      const binding = el.bindings?.content;
      if (!binding) continue;
      const match = /^\/cards\/([^/]+)\/content$/.exec(binding);
      expect(match, `binding path ${binding} must match /cards/<id>/content`).not.toBeNull();
      const blockId = match![1];
      expect(spec.state!.cards).toHaveProperty(blockId);
    }
  });

  it('applies KANBAN_COLORS by normalized column title', () => {
    const { root, blocks } = makeFixture();
    const actions = makeActions(blocks, [root.id]);

    const spec = kanbanSpec(root.id, actions);

    expect(spec.elements['col-0'].props.titleColor).toBe('#ffb300'); // todo
    expect(spec.elements['col-1'].props.titleColor).toBe('#00e5ff'); // doing
    expect(spec.elements['col-2'].props.titleColor).toBe('#98c379'); // done
  });

  it('throws when the referenced block has no children', () => {
    const blocks = new Map<string, Block>();
    blocks.set('empty-root', {
      id: 'empty-root',
      content: 'Empty Board',
      childIds: [],
      parentId: null,
    });
    const actions = makeActions(blocks, ['empty-root']);

    expect(() => kanbanSpec('empty-root', actions)).toThrow(/No children/);
  });

  it('throws when the referenced block is not found', () => {
    const { blocks } = makeFixture();
    const actions = makeActions(blocks, []);

    expect(() => kanbanSpec('missing-block-id', actions)).toThrow(/not found/i);
  });
});

describe('handleRenderStateChange — FLO-587 path → chirp translation', () => {
  it('translates /cards/<id>/content → update-block chirp', () => {
    const onChirp = vi.fn();
    handleRenderStateChange(
      [{ path: '/cards/abc-123/content', value: 'new card text' }],
      onChirp,
    );
    expect(onChirp).toHaveBeenCalledTimes(1);
    expect(onChirp).toHaveBeenCalledWith('update-block', {
      blockId: 'abc-123',
      content: 'new card text',
    });
  });

  it('handles multiple changes in one batch', () => {
    const onChirp = vi.fn();
    handleRenderStateChange(
      [
        { path: '/cards/card-1/content', value: 'first' },
        { path: '/cards/card-2/content', value: 'second' },
      ],
      onChirp,
    );
    expect(onChirp).toHaveBeenCalledTimes(2);
    expect(onChirp).toHaveBeenNthCalledWith(1, 'update-block', {
      blockId: 'card-1',
      content: 'first',
    });
    expect(onChirp).toHaveBeenNthCalledWith(2, 'update-block', {
      blockId: 'card-2',
      content: 'second',
    });
  });

  it('silently ignores unknown paths (e.g. demo-mode state)', () => {
    const onChirp = vi.fn();
    handleRenderStateChange(
      [{ path: '/count', value: 7 }, { path: '/user/name', value: 'Demo' }],
      onChirp,
    );
    expect(onChirp).not.toHaveBeenCalled();
  });

  it('ignores non-string values on /cards paths (defensive)', () => {
    const onChirp = vi.fn();
    handleRenderStateChange(
      [{ path: '/cards/card-1/content', value: 42 }],
      onChirp,
    );
    expect(onChirp).not.toHaveBeenCalled();
  });

  it('is a no-op when onChirp is undefined', () => {
    // Should not throw
    expect(() =>
      handleRenderStateChange(
        [{ path: '/cards/card-1/content', value: 'x' }],
        undefined,
      ),
    ).not.toThrow();
  });

  it('handles uuid-shaped block ids with dashes', () => {
    const onChirp = vi.fn();
    handleRenderStateChange(
      [{ path: '/cards/a1b2c3d4-e5f6-7890-abcd-ef1234567890/content', value: 'x' }],
      onChirp,
    );
    expect(onChirp).toHaveBeenCalledWith('update-block', {
      blockId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      content: 'x',
    });
  });
});
