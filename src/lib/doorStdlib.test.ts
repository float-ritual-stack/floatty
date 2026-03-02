import { describe, it, expect } from 'vitest';
import {
  findWikilinkEnd,
  parseWikilinkInner,
  extractAllWikilinkTargets,
  parseBracketedWikilink,
  findPagesContainer,
  findPageBlock,
  localDateStr,
  resolveDate,
} from './doorStdlib';

describe('doorStdlib', () => {
  // ── Wikilink parsing (re-exported from wikilinkUtils) ──────

  it('findWikilinkEnd handles simple wikilink', () => {
    expect(findWikilinkEnd('[[hello]]', 0)).toBe(9);
  });

  it('findWikilinkEnd handles nested', () => {
    expect(findWikilinkEnd('[[outer [[inner]]]]', 0)).toBe(19);
  });

  it('parseWikilinkInner extracts target and alias', () => {
    expect(parseWikilinkInner('Page|alias')).toEqual({ target: 'Page', alias: 'alias' });
    expect(parseWikilinkInner('Page')).toEqual({ target: 'Page', alias: null });
  });

  it('extractAllWikilinkTargets finds all targets including nested', () => {
    const targets = extractAllWikilinkTargets('see [[outer [[inner]]]] and [[simple]]');
    expect(targets).toContain('outer [[inner]]');
    expect(targets).toContain('inner');
    expect(targets).toContain('simple');
  });

  // ── parseBracketedWikilink (was inline in extractTo) ───────

  it('parseBracketedWikilink parses simple', () => {
    expect(parseBracketedWikilink('[[Page]]', 0)).toEqual({ target: 'Page', end: 8 });
  });

  it('parseBracketedWikilink parses nested', () => {
    expect(parseBracketedWikilink('[[outer [[inner]]]]', 0)).toEqual({ target: 'outer [[inner]]', end: 19 });
  });

  it('parseBracketedWikilink returns null at non-bracket position', () => {
    expect(parseBracketedWikilink('hello', 0)).toBeNull();
  });

  it('parseBracketedWikilink returns null for unbalanced', () => {
    expect(parseBracketedWikilink('[[unbalanced', 0)).toBeNull();
  });

  it('parseBracketedWikilink works at offset', () => {
    expect(parseBracketedWikilink('prefix [[target]]', 7)).toEqual({ target: 'target', end: 17 });
  });

  // ── Page helpers ───────────────────────────────────────────

  it('findPagesContainer finds pages:: block', () => {
    const actions = {
      rootIds: () => ['a', 'b', 'c'] as const,
      getBlock: (id: string) => {
        if (id === 'b') return { content: 'pages::' };
        return { content: `block ${id}` };
      },
      getChildren: () => [],
    };
    expect(findPagesContainer(actions)).toBe('b');
  });

  it('findPagesContainer returns null when missing', () => {
    const actions = {
      rootIds: () => ['a'] as const,
      getBlock: () => ({ content: 'not pages' }),
      getChildren: () => [],
    };
    expect(findPagesContainer(actions)).toBeNull();
  });

  it('findPageBlock matches case-insensitively, strips heading prefix', () => {
    const actions = {
      rootIds: () => [] as readonly string[],
      getBlock: (id: string) => {
        if (id === 'p1') return { content: '# My Page' };
        if (id === 'p2') return { content: '# Other' };
        return undefined;
      },
      getChildren: () => ['p1', 'p2'],
    };
    expect(findPageBlock(actions, 'pages', 'my page')).toBe('p1');
    expect(findPageBlock(actions, 'pages', 'My Page')).toBe('p1');
    expect(findPageBlock(actions, 'pages', 'nope')).toBeNull();
  });

  // ── Date helpers ───────────────────────────────────────────

  it('localDateStr formats correctly', () => {
    const d = new Date(2026, 2, 1); // March 1, 2026
    expect(localDateStr(d)).toBe('2026-03-01');
  });

  it('localDateStr pads single digits', () => {
    const d = new Date(2026, 0, 5); // Jan 5
    expect(localDateStr(d)).toBe('2026-01-05');
  });

  it('resolveDate handles today', () => {
    const today = localDateStr(new Date());
    expect(resolveDate('today')).toBe(today);
    expect(resolveDate('')).toBe(today);
  });

  it('resolveDate handles yesterday', () => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    expect(resolveDate('yesterday')).toBe(localDateStr(d));
  });

  it('resolveDate passes through YYYY-MM-DD', () => {
    expect(resolveDate('2026-01-15')).toBe('2026-01-15');
  });
});
