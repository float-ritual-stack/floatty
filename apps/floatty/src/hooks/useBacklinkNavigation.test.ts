import { describe, it, expect } from 'vitest';
import { getPageTitle } from './useBacklinkNavigation';

describe('getPageTitle', () => {
  it('strips heading prefix from single-line content', () => {
    expect(getPageTitle('# My Page')).toBe('My Page');
    expect(getPageTitle('## Sub Page')).toBe('Sub Page');
    expect(getPageTitle('### Deep')).toBe('Deep');
  });

  it('returns first line only from multi-line content', () => {
    const content = '# Pebble Exchange Summary\n[board:: recon] [date:: 2026-02-24]';
    expect(getPageTitle(content)).toBe('Pebble Exchange Summary');
  });

  it('strips heading AND takes first line for multi-line with metadata', () => {
    const content = '# Summary: 2026-02-24 — Agent Tooling\n[board:: recon]\n[relates:: [[other]]]';
    expect(getPageTitle(content)).toBe('Summary: 2026-02-24 — Agent Tooling');
  });

  it('returns content as-is when no heading prefix', () => {
    expect(getPageTitle('No prefix here')).toBe('No prefix here');
  });

  it('returns empty string for empty input', () => {
    expect(getPageTitle('')).toBe('');
  });

  it('preserves wikilinks in heading', () => {
    expect(getPageTitle('# meeting:: [[nick <--> evan]]')).toBe('meeting:: [[nick <--> evan]]');
  });

  it('trims whitespace', () => {
    expect(getPageTitle('#   Spaced Out  ')).toBe('Spaced Out');
  });

  it('handles content with only newlines after first line', () => {
    expect(getPageTitle('# Title\n\n\n')).toBe('Title');
  });

  it('handles first line without heading but multi-line', () => {
    const content = 'plain title\nsome metadata';
    expect(getPageTitle(content)).toBe('plain title');
  });

  // FLO-573: bare "#name" (no whitespace after #) is a page name, not a heading
  it('preserves # prefix on names without whitespace (FLO-573)', () => {
    expect(getPageTitle('#2817')).toBe('#2817');
    expect(getPageTitle('#tag')).toBe('#tag');
    expect(getPageTitle('##nested')).toBe('##nested');
  });

  it('strips heading but preserves inner # on pages named #NNN (FLO-573)', () => {
    // createPage writes "# ${name}" into the page block. For a page named
    // "#2817" the stored content is "# #2817" — title should be "#2817".
    expect(getPageTitle('# #2817')).toBe('#2817');
    expect(getPageTitle('# #tag')).toBe('#tag');
    expect(getPageTitle('## #2817')).toBe('#2817');
  });
});

// ─── findBacklinks (2026-06-12 keyboard-lag recon) ──────────────────────────
// The backlinks memo re-runs on any block change while a page is zoomed, over
// EVERY block in the store (~25.7k at measurement time). The '[[' fast-path
// gate added in the perf bundle must not change results — these tests pin the
// behavior contract.

import * as Y from 'yjs';
import { findBacklinks } from './useBacklinkNavigation';
import { blockStore } from './useBlockStore';

function seedBlock(
  blocksMap: Y.Map<unknown>,
  rootIds: Y.Array<string>,
  id: string,
  content: string,
): void {
  const map = new Y.Map<unknown>();
  map.set('id', id);
  map.set('parentId', null);
  map.set('content', content);
  map.set('type', 'text');
  map.set('metadata', null);
  map.set('collapsed', false);
  map.set('createdAt', 1);
  map.set('updatedAt', 1);
  map.set('childIds', new Y.Array<string>());
  blocksMap.set(id, map);
  rootIds.push([id]);
}

describe('findBacklinks', () => {
  it('finds wikilink references, skips bracket-free blocks and the page itself', () => {
    const doc = new Y.Doc();
    const blocksMap = doc.getMap<unknown>('blocks');
    const rootIds = doc.getArray<string>('rootIds');

    doc.transact(() => {
      seedBlock(blocksMap, rootIds, 'page-block', '# Target Page');
      seedBlock(blocksMap, rootIds, 'linker-1', 'see [[Target Page]] for context');
      seedBlock(blocksMap, rootIds, 'linker-2', 'case test [[target page]]');
      seedBlock(blocksMap, rootIds, 'plain', 'no brackets here at all');
      seedBlock(blocksMap, rootIds, 'other-link', 'mentions [[Some Other Page]] only');
    });
    blockStore.initFromYDoc(doc);

    const hits = findBacklinks('# Target Page').map((b) => b.id).sort();

    expect(hits).toEqual(['linker-1', 'linker-2']);
  });

  it('returns empty array when nothing links to the page', () => {
    const doc = new Y.Doc();
    const blocksMap = doc.getMap<unknown>('blocks');
    const rootIds = doc.getArray<string>('rootIds');

    doc.transact(() => {
      seedBlock(blocksMap, rootIds, 'lonely-page', '# Lonely Page');
      seedBlock(blocksMap, rootIds, 'unrelated', 'plain text without links');
    });
    blockStore.initFromYDoc(doc);

    expect(findBacklinks('# Lonely Page')).toEqual([]);
  });
});
