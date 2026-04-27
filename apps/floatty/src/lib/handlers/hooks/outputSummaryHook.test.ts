import { describe, expect, it } from 'vitest';
import { flattenSpecToMarkdown } from './outputSummaryHook';

function makeDoorOutput(elements: Record<string, unknown>, root: string, title?: string) {
  return {
    kind: 'view',
    data: {
      ...(title ? { title } : {}),
      spec: { root, elements },
    },
  };
}

describe('flattenSpecToMarkdown — generic fallback (FLO-echo-fallback)', () => {
  it('emits text-bearing props for unknown component types', () => {
    const out = makeDoorOutput(
      {
        root: { type: 'NotInCatalog', props: { title: 'Unknown title', description: 'body text' } },
      },
      'root',
    );
    const md = flattenSpecToMarkdown(out);
    expect(md).toContain('<!-- NotInCatalog -->');
    expect(md).toContain('Unknown title');
    expect(md).toContain('body text');
  });

  it('handles {label, value} array shapes generically', () => {
    const out = makeDoorOutput(
      {
        root: {
          type: 'CustomBars',
          props: {
            bars: [
              { label: 'Apples', value: 12 },
              { label: 'Oranges', value: 7 },
            ],
          },
        },
      },
      'root',
    );
    const md = flattenSpecToMarkdown(out);
    expect(md).toContain('- **Apples**: 12');
    expect(md).toContain('- **Oranges**: 7');
  });

  it('pure layout chrome with no text props emits nothing but recurses children', () => {
    const out = makeDoorOutput(
      {
        root: { type: 'Stack', props: {}, children: ['child'] },
        child: { type: 'Text', props: { content: 'inner content' } },
      },
      'root',
    );
    const md = flattenSpecToMarkdown(out);
    expect(md).not.toContain('<!-- Stack -->');
    expect(md).toContain('inner content');
  });

  it('skips empty / whitespace-only string props in fallback', () => {
    const out = makeDoorOutput(
      {
        root: { type: 'EmptyMystery', props: { title: '   ', description: '' } },
      },
      'root',
    );
    // Nothing emits, top-level result is empty → flatten returns null
    expect(flattenSpecToMarkdown(out)).toBeNull();
  });
});

describe('flattenSpecToMarkdown — added explicit cases', () => {
  it('Section emits ## heading from title', () => {
    const out = makeDoorOutput(
      { root: { type: 'Section', props: { title: 'Highlights' } } },
      'root',
    );
    expect(flattenSpecToMarkdown(out)).toContain('## Highlights');
  });

  it('Card emits ### title + description + content', () => {
    const out = makeDoorOutput(
      {
        root: {
          type: 'Card',
          props: { title: 'Decision', description: 'Why', content: 'Details here' },
        },
      },
      'root',
    );
    const md = flattenSpecToMarkdown(out)!;
    expect(md).toMatch(/### Decision/);
    expect(md).toContain('Why');
    expect(md).toContain('Details here');
  });

  it('KanbanColumn emits ### title and KanbanCard emits bullet with status', () => {
    const out = makeDoorOutput(
      {
        col: {
          type: 'KanbanColumn',
          props: { title: 'In Progress' },
          children: ['cardA'],
        },
        cardA: {
          type: 'KanbanCard',
          props: { title: 'Ship echoCopy fix', status: 'review', description: 'fallback walker' },
        },
      },
      'col',
    );
    const md = flattenSpecToMarkdown(out)!;
    expect(md).toContain('### In Progress');
    expect(md).toContain('- **Ship echoCopy fix** _(review)_');
    expect(md).toContain('fallback walker');
  });

  it('GapItem emits severity + label + description', () => {
    const out = makeDoorOutput(
      {
        root: {
          type: 'GapItem',
          props: { severity: 'high', label: 'No tests', description: 'Coverage drift' },
        },
      },
      'root',
    );
    expect(flattenSpecToMarkdown(out)).toContain('- **[high]** No tests — Coverage drift');
  });

  it('TimeEntry emits time + activity + project', () => {
    const out = makeDoorOutput(
      {
        root: {
          type: 'TimeEntry',
          props: { time: '14:30', activity: 'review PR', project: 'floatty' },
        },
      },
      'root',
    );
    expect(flattenSpecToMarkdown(out)).toContain('- 14:30: review PR _(floatty)_');
  });

  it('Image emits markdown image syntax when src present', () => {
    const out = makeDoorOutput(
      { root: { type: 'Image', props: { src: 'https://x/y.png', alt: 'logo' } } },
      'root',
    );
    expect(flattenSpecToMarkdown(out)).toContain('![logo](https://x/y.png)');
  });

  it('TagChip / ModeTag emit inline code', () => {
    const out = makeDoorOutput(
      {
        root: { type: 'Stack', props: {}, children: ['t1', 'm1'] },
        t1: { type: 'TagChip', props: { label: 'feat' } },
        m1: { type: 'ModeTag', props: { mode: 'review' } },
      },
      'root',
    );
    const md = flattenSpecToMarkdown(out)!;
    expect(md).toContain('`feat`');
    expect(md).toContain('`review`');
  });

  it('RefCard emits ### title, ref wikilink, and summary', () => {
    const out = makeDoorOutput(
      {
        root: {
          type: 'RefCard',
          props: { title: 'FLO-633', ref: 'FLO-633', summary: 'door projection' },
        },
      },
      'root',
    );
    const md = flattenSpecToMarkdown(out)!;
    expect(md).toContain('### FLO-633');
    expect(md).toContain('ref: [[FLO-633]]');
    expect(md).toContain('door projection');
  });
});

describe('flattenSpecToMarkdown — TreeView round-trips as nested bullets', () => {
  it('flat tree with status emits bullets with status symbols', () => {
    const out = makeDoorOutput(
      {
        root: {
          type: 'TreeView',
          props: {
            title: 'Sprint',
            nodes: [
              { id: 'a', label: 'Done thing', status: 'done' },
              { id: 'b', label: 'In progress', status: 'active', detail: 'half landed' },
              { id: 'c', label: 'Up next', status: 'pending' },
              { id: 'd', label: 'Punted', status: 'deferred' },
            ],
          },
        },
      },
      'root',
    );
    const md = flattenSpecToMarkdown(out)!;
    expect(md).toContain('## Sprint');
    expect(md).toContain('- ✓ Done thing');
    expect(md).toContain('- ▸ In progress — half landed');
    expect(md).toContain('- ○ Up next');
    expect(md).toContain('- ⊘ Punted');
  });

  it('nested tree emits 2-space indentation per level', () => {
    const out = makeDoorOutput(
      {
        root: {
          type: 'TreeView',
          props: {
            nodes: [
              {
                id: '1',
                label: 'Top',
                children: [
                  { id: '1a', label: 'Mid', children: [{ id: '1a1', label: 'Leaf' }] },
                ],
              },
            ],
          },
        },
      },
      'root',
    );
    const md = flattenSpecToMarkdown(out)!;
    expect(md).toContain('- Top');
    expect(md).toContain('  - Mid');
    expect(md).toContain('    - Leaf');
  });

  it('connectsTo emits as wikilink footer', () => {
    const out = makeDoorOutput(
      {
        root: {
          type: 'TreeView',
          props: {
            nodes: [{ id: '1', label: 'item' }],
            connectsTo: ['FLO-100', 'FLO-200'],
          },
        },
      },
      'root',
    );
    const md = flattenSpecToMarkdown(out)!;
    expect(md).toContain('connects: [[FLO-100]], [[FLO-200]]');
  });

  it('round-trips through parseMarkdownTree with correct depth', async () => {
    // The point of bullet-indentation: when echoCopy materializes the
    // projection back into the outline, parseMarkdownTree reconstructs
    // nested child blocks at the original tree depth.
    const { parseMarkdownTree } = await import('../../markdownParser');
    const out = makeDoorOutput(
      {
        root: {
          type: 'TreeView',
          props: {
            nodes: [
              {
                id: '1',
                label: 'Parent',
                status: 'active',
                children: [
                  { id: '1a', label: 'Child', status: 'done' },
                  {
                    id: '1b',
                    label: 'Sibling',
                    children: [{ id: '1b1', label: 'Grandchild' }],
                  },
                ],
              },
            ],
          },
        },
      },
      'root',
    );
    const md = flattenSpecToMarkdown(out)!;
    const parsed = parseMarkdownTree(md);

    // Find the Parent node and check it has 2 children, one of which has 1 grandchild.
    const findByContent = (
      nodes: { content: string; children: { content: string; children: unknown[] }[] }[],
      needle: string,
    ): { content: string; children: { content: string; children: unknown[] }[] } | null => {
      for (const n of nodes) {
        if (n.content.includes(needle)) return n;
        const inner = findByContent(n.children, needle);
        if (inner) return inner;
      }
      return null;
    };
    const parent = findByContent(parsed, 'Parent');
    expect(parent).not.toBeNull();
    expect(parent!.children.length).toBe(2);
    const sibling = parent!.children.find((c) => c.content.includes('Sibling'));
    expect(sibling).toBeDefined();
    expect(sibling!.children.length).toBe(1);
    expect(sibling!.children[0].content).toContain('Grandchild');
  });
});

describe('flattenSpecToMarkdown — existing cases regression', () => {
  it('still handles EntryHeader / EntryBody / Code', () => {
    const out = makeDoorOutput(
      {
        root: { type: 'Stack', props: {}, children: ['h', 'b', 'c'] },
        h: { type: 'EntryHeader', props: { title: 'Daily', date: '2026-04-27' } },
        b: { type: 'EntryBody', props: { markdown: '## Notes\n\nbody' } },
        c: { type: 'Code', props: { content: 'echo hi' } },
      },
      'root',
      'Top',
    );
    const md = flattenSpecToMarkdown(out)!;
    expect(md).toContain('# Top');
    expect(md).toContain('## Daily (2026-04-27)');
    expect(md).toContain('## Notes');
    expect(md).toContain('```');
    expect(md).toContain('echo hi');
  });

  it('returns null when output is not a view-kind door envelope', () => {
    expect(flattenSpecToMarkdown(null)).toBeNull();
    expect(flattenSpecToMarkdown({ kind: 'exec', data: {} })).toBeNull();
    expect(flattenSpecToMarkdown({ kind: 'view', data: { spec: {} } })).toBeNull();
  });
});
