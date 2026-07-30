/**
 * render:: jump — deterministic board jump-menu spec.
 *
 * Replaces a repeated `render:: agent` invocation ("pretty formatted list of
 * links that jump to that location") with a subcommand that re-projects live
 * via the FLO-587 block subscription instead of freezing a snapshot.
 *
 * Fixtures are synthetic ("Demo Board", "Column Todo") per
 * .claude/rules/test-fixtures-no-pii.md.
 */
import { describe, it, expect } from 'vitest';
import { jumpSpec } from './render';
import { bbsCatalog } from './catalog';

interface Block {
  id: string;
  content: string;
  childIds: string[];
  parentId?: string | null;
}

function makeFixture(columns: Array<{ id: string; content: string; cards?: string[] }>): {
  root: Block;
  blocks: Map<string, Block>;
} {
  const blocks = new Map<string, Block>();
  const root: Block = {
    id: 'board-root',
    content: 'Demo Board',
    childIds: columns.map(c => c.id),
    parentId: null,
  };
  blocks.set(root.id, root);

  for (const col of columns) {
    blocks.set(col.id, {
      id: col.id,
      content: col.content,
      childIds: col.cards ?? [],
      parentId: root.id,
    });
    (col.cards ?? []).forEach((cardId, idx) => {
      blocks.set(cardId, { id: cardId, content: `Card ${idx + 1}`, childIds: [], parentId: col.id });
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

const THREE_COLUMNS = [
  { id: 'col-todo', content: '## Todo', cards: ['t1', 't2'] },
  { id: 'col-doing', content: 'Doing', cards: ['d1'] },
  { id: 'col-mystery', content: 'Someday Maybe', cards: [] },
];

describe('jumpSpec — menu shape', () => {
  it('renders a vertical Stack: header, one row per column, divider, footer', () => {
    const { root, blocks } = makeFixture(THREE_COLUMNS);
    const spec = jumpSpec(root.id, makeActions(blocks, [root.id]));

    expect(spec.root).toBe('menu');
    expect(spec.elements.menu).toMatchObject({
      type: 'Stack',
      props: expect.objectContaining({ direction: 'vertical' }),
      children: ['header', 'item-0', 'item-1', 'item-2', 'sep', 'footer'],
    });
  });

  it('header is a SectionLabel derived from the board content', () => {
    const { root, blocks } = makeFixture(THREE_COLUMNS);
    const spec = jumpSpec(root.id, makeActions(blocks, [root.id]));

    expect(spec.elements.header).toMatchObject({
      type: 'SectionLabel',
      props: expect.objectContaining({ label: expect.stringContaining('Demo Board') }),
    });
  });

  it('each row pairs a Chip dot with a WikilinkChip targeting the column BLOCK ID', () => {
    const { root, blocks } = makeFixture(THREE_COLUMNS);
    const spec = jumpSpec(root.id, makeActions(blocks, [root.id]));

    expect(spec.elements['item-0']).toMatchObject({ type: 'Row', children: ['dot-0', 'link-0'] });

    // target = block id (survives rename AND move); label = the pretty name.
    // The agent-generated version used a `>` path here, which breaks on rename.
    expect(spec.elements['link-0']).toMatchObject({
      type: 'WikilinkChip',
      props: expect.objectContaining({ target: 'col-todo', label: 'Todo' }),
    });
    expect(spec.elements['link-1']).toMatchObject({
      type: 'WikilinkChip',
      props: expect.objectContaining({ target: 'col-doing', label: 'Doing' }),
    });
  });

  it('maps column names to kanban color tokens, defaulting to dim', () => {
    const { root, blocks } = makeFixture(THREE_COLUMNS);
    const spec = jumpSpec(root.id, makeActions(blocks, [root.id]));

    expect(spec.elements['dot-0']).toMatchObject({
      type: 'Chip',
      props: expect.objectContaining({ label: '●', color: 'amber' }),
    });
    expect(spec.elements['dot-1']).toMatchObject({
      type: 'Chip',
      props: expect.objectContaining({ color: 'cyan' }),
    });
    // Unknown column name → dim, never undefined (Chip.color is an enum).
    expect(spec.elements['dot-2']).toMatchObject({
      type: 'Chip',
      props: expect.objectContaining({ color: 'dim' }),
    });
  });

  it('footer links back to the board itself', () => {
    const { root, blocks } = makeFixture(THREE_COLUMNS);
    const spec = jumpSpec(root.id, makeActions(blocks, [root.id]));

    expect(spec.elements.footer).toMatchObject({ type: 'Row', children: ['footer-link'] });
    expect(spec.elements['footer-link']).toMatchObject({
      type: 'WikilinkChip',
      props: expect.objectContaining({ target: 'board-root' }),
    });
  });

  it('strips markdown heading markers from the displayed label', () => {
    const { root, blocks } = makeFixture([{ id: 'c1', content: '### Blocked' }]);
    const spec = jumpSpec(root.id, makeActions(blocks, [root.id]));

    expect(spec.elements['link-0']).toMatchObject({
      props: expect.objectContaining({ label: 'Blocked' }),
    });
    expect(spec.elements['dot-0']).toMatchObject({
      props: expect.objectContaining({ color: 'coral' }),
    });
  });

  it('skips children that cannot be resolved', () => {
    const { root, blocks } = makeFixture([{ id: 'c1', content: 'Todo' }]);
    root.childIds.push('ghost-id'); // referenced but absent from the store
    const spec = jumpSpec(root.id, makeActions(blocks, [root.id]));

    expect(spec.elements.menu.children).toEqual(['header', 'item-0', 'sep', 'footer']);
  });
});

describe('jumpSpec — edge cases', () => {
  it('renders an empty state instead of throwing when the board has no columns', () => {
    // Deliberate divergence from kanbanSpec (which throws). refresh() errors are
    // log-only, so a throw would leave a STALE menu on screen after the last
    // column is deleted — the exact failure this view exists to prevent.
    const { root, blocks } = makeFixture([]);
    const spec = jumpSpec(root.id, makeActions(blocks, [root.id]));

    expect(spec.elements.menu.children).toEqual(['header', 'empty', 'sep', 'footer']);
    expect(spec.elements.empty).toBeDefined();
  });

  it('throws when the block ref cannot be resolved', () => {
    const { root, blocks } = makeFixture(THREE_COLUMNS);
    expect(() => jumpSpec('no-such-block', makeActions(blocks, [root.id]))).toThrow(/not found/i);
  });

  it('resolves a [[wikilink]]-wrapped ref', () => {
    const { root, blocks } = makeFixture(THREE_COLUMNS);
    const spec = jumpSpec(`[[${root.id}]]`, makeActions(blocks, [root.id]));
    expect(spec.root).toBe('menu');
  });
});

describe('spec functions emit only catalog-registered components', () => {
  // Generalizes the `Text` trap: kanbanSpec emits type 'Text', which is NOT in
  // the catalog, so json-render silently renders nothing. The agent path can't
  // make this mistake (schema-constrained); hand-written specs had no check.
  it('every jumpSpec element type exists in the catalog', () => {
    const { root, blocks } = makeFixture(THREE_COLUMNS);
    const spec = jumpSpec(root.id, makeActions(blocks, [root.id]));

    const registered = new Set(bbsCatalog.componentNames);
    const emitted = [...new Set(Object.values(spec.elements).map(el => el.type))];
    const unregistered = emitted.filter(t => !registered.has(t));

    expect(unregistered).toEqual([]);
  });
});
