/**
 * FLO-587 — render:: kanban baseline spec shape.
 *
 * Locks the current (pre-two-way-binding) kanbanSpec output so later units
 * that extend the spec (state + bindings, drag handlers) have a regression
 * fence. Fixtures are synthetic ("Demo Todo", "Card 1") per
 * .claude/rules/test-fixtures-no-pii.md.
 */
import { describe, it, expect } from 'vitest';
import { kanbanSpec } from './render';

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
