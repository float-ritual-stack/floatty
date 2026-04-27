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
