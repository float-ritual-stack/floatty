import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  advanceToNextInput,
  findWikilinkEnd,
  parseWikilinkInner,
  extractAllWikilinkTargets,
  parseBracketedWikilink,
  createFocusedChild,
  findPagesContainer,
  findPageBlock,
  localDateStr,
  resolveDate,
} from './doorStdlib';

describe('doorStdlib', () => {
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

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

  it('findPageBlock matches multi-hash ATX headings (## / ###), not just `# `', () => {
    // Regression: the old single-`# ` strip mismatched `## Foo` / `### Foo`
    // pages. getSectionKey strips any ATX level (`/^#+\s+/`), matching findPage.
    const actions = {
      rootIds: () => [] as readonly string[],
      getBlock: (id: string) => {
        if (id === 'p1') return { content: '## Demo Page' };
        if (id === 'p2') return { content: '### Deep Section' };
        return undefined;
      },
      getChildren: () => ['p1', 'p2'],
    };
    expect(findPageBlock(actions, 'pages', 'demo page')).toBe('p1');
    expect(findPageBlock(actions, 'pages', 'deep section')).toBe('p2');
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

  // ── Async continuation helpers ─────────────────────────────

  it('createFocusedChild creates an empty child, schedules focus, and returns id', () => {
    const focused: string[] = [];
    const actions = {
      createBlockInside: (parentId: string) => `${parentId}-child`,
      updateBlockContent: (id: string, content: string) => {
        expect(id).toBe('parent-child');
        expect(content).toBe('');
      },
      focusBlock: (id: string) => focused.push(id),
    };

    const id = createFocusedChild(actions, 'parent');

    expect(id).toBe('parent-child');
    expect(focused).toEqual(['parent-child']);
  });

  it('createFocusedChild writes custom content', () => {
    const updates: Array<[string, string]> = [];
    const actions = {
      createBlockInside: () => 'child',
      updateBlockContent: (id: string, content: string) => updates.push([id, content]),
      focusBlock: () => {},
    };

    expect(createFocusedChild(actions, 'parent', 'draft')).toBe('child');
    expect(updates).toEqual([['child', 'draft']]);
  });

  it('advanceToNextInput focuses a supplied next block', () => {
    const focused: string[] = [];
    const actions = {
      createBlockAfter: () => {
        throw new Error('should not create');
      },
      focusBlock: (id: string) => focused.push(id),
    };

    expect(advanceToNextInput(actions, 'current', { nextId: 'next' })).toBe('next');
    expect(focused).toEqual(['next']);
  });

  it('advanceToNextInput does not treat a supplied empty next id as missing', () => {
    const focused: string[] = [];
    const updates: Array<[string, string]> = [];
    const actions = {
      createBlockAfter: () => {
        throw new Error('should not create');
      },
      updateBlockContent: (id: string, content: string) => updates.push([id, content]),
      focusBlock: (id: string) => focused.push(id),
    };

    expect(advanceToNextInput(actions, 'current', { nextId: '', content: 'ignored' })).toBe('');
    expect(updates).toEqual([]);
    expect(focused).toEqual(['']);
  });

  it('advanceToNextInput resolves an existing next block', () => {
    const focused: string[] = [];
    const actions = {
      createBlockAfter: () => {
        throw new Error('should not create');
      },
      focusBlock: (id: string) => focused.push(id),
    };

    expect(advanceToNextInput(actions, 'current', { findNextId: () => 'resolved' })).toBe('resolved');
    expect(focused).toEqual(['resolved']);
  });

  it('advanceToNextInput creates and focuses a sibling when no next block exists', () => {
    const focused: string[] = [];
    const updates: Array<[string, string]> = [];
    const actions = {
      createBlockAfter: (id: string) => `${id}-after`,
      updateBlockContent: (id: string, content: string) => updates.push([id, content]),
      focusBlock: (id: string) => focused.push(id),
    };

    expect(advanceToNextInput(actions, 'current', { content: 'next thought' })).toBe('current-after');
    expect(updates).toEqual([['current-after', 'next thought']]);
    expect(focused).toEqual(['current-after']);
  });

  it('continuation helpers do not throw when focusBlock is missing', () => {
    const actions = {
      createBlockInside: () => 'child',
      createBlockAfter: () => 'after',
      updateBlockContent: () => {},
    };

    expect(() => createFocusedChild(actions, 'parent')).not.toThrow();
    expect(() => advanceToNextInput(actions, 'current')).not.toThrow();
  });
});
