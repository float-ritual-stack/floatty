import { describe, it, expect, vi } from 'vitest';
import {
  formatRelativeTime,
  shellQuotePath,
  catCommand,
  sortFiles,
  resolveInsertTarget,
  insertCatBlockAt,
  FILTER_KEYS,
  type SortMode,
} from './RecentFilesSidebar';
import { fuzzyFilter } from '../lib/fuzzyFilter';
import type { FileEvent } from '../lib/tauriTypes';

// ── fixtures ──────────────────────────────────────────────────────────

function file(over: Partial<FileEvent> & { id: string; filePath: string }): FileEvent {
  return {
    toolName: 'Write',
    sessionFile: '/path/to/session.jsonl',
    createdAt: '2026-07-12 10:00:00',
    ...over,
  };
}

// ── sort ──────────────────────────────────────────────────────────────

describe('sortFiles', () => {
  const older = file({ id: 'a', filePath: '/path/to/zebra.md', eventTime: '2026-07-12T10:00:00.000Z' });
  const newer = file({ id: 'b', filePath: '/path/to/apple.md', eventTime: '2026-07-12T12:00:00.000Z' });

  const paths = (list: FileEvent[]) => list.map((f) => f.filePath);

  it('sorts by recency, newest first, by default', () => {
    expect(paths(sortFiles([older, newer], 'date'))).toEqual([
      '/path/to/apple.md',
      '/path/to/zebra.md',
    ]);
  });

  it('sorts by basename when in name mode', () => {
    expect(paths(sortFiles([older, newer], 'name'))).toEqual([
      '/path/to/apple.md',
      '/path/to/zebra.md',
    ]);
  });

  it('sorts by BASENAME, not full path', () => {
    // 'z/apple.md' would sort after 'a/zebra.md' on full path, but its basename
    // is what the user reads, so apple must win.
    const a = file({ id: '1', filePath: '/zzz/apple.md' });
    const b = file({ id: '2', filePath: '/aaa/zebra.md' });
    expect(paths(sortFiles([b, a], 'name'))).toEqual(['/zzz/apple.md', '/aaa/zebra.md']);
  });

  it('does not mutate the input array (Fuse caches by array identity)', () => {
    const input = [older, newer];
    const snapshot = [...input];
    sortFiles(input, 'name');
    expect(input).toEqual(snapshot);
  });

  it('breaks ties deterministically so rows never reshuffle', () => {
    const tie = '2026-07-12T12:00:00.000Z';
    const x = file({ id: 'aaa', filePath: '/path/to/same.md', eventTime: tie });
    const y = file({ id: 'zzz', filePath: '/path/to/same.md', eventTime: tie });

    for (const mode of ['date', 'name'] as SortMode[]) {
      const first = sortFiles([x, y], mode).map((f) => f.id);
      const second = sortFiles([y, x], mode).map((f) => f.id);
      expect(first).toEqual(second);
    }
  });

  it('treats missing/unparseable timestamps as oldest rather than throwing', () => {
    const undated = file({ id: 'c', filePath: '/path/to/undated.md', createdAt: '' });
    expect(paths(sortFiles([undated, newer], 'date'))).toEqual([
      '/path/to/apple.md',
      '/path/to/undated.md',
    ]);
  });
});

// ── insert target resolution ──────────────────────────────────────────

describe('resolveInsertTarget', () => {
  const deps = (over: Partial<Parameters<typeof resolveInsertTarget>[0]> = {}) => ({
    activeTabId: () => 'tab-1',
    resolveSidebarTarget: () => 'pane-1',
    getFocusedBlockId: () => 'block-1',
    ...over,
  });

  it('resolves tab → pane → focused block', () => {
    expect(resolveInsertTarget(deps())).toEqual({ paneId: 'pane-1', focusedBlockId: 'block-1' });
  });

  it('returns null when there is no active tab', () => {
    expect(resolveInsertTarget(deps({ activeTabId: () => null }))).toBeNull();
  });

  it('returns null when the tab has no outliner pane', () => {
    expect(resolveInsertTarget(deps({ resolveSidebarTarget: () => null }))).toBeNull();
  });

  it('returns null when nothing is focused — the "pick a destination" case', () => {
    expect(resolveInsertTarget(deps({ getFocusedBlockId: () => null }))).toBeNull();
  });

  it('passes the resolved pane id through to the focus lookup', () => {
    const getFocusedBlockId = vi.fn(() => 'block-9');
    resolveInsertTarget(deps({ resolveSidebarTarget: () => 'pane-42', getFocusedBlockId }));
    expect(getFocusedBlockId).toHaveBeenCalledWith('pane-42');
  });
});

// ── insert ────────────────────────────────────────────────────────────

describe('insertCatBlockAt', () => {
  const target = { paneId: 'pane-1', focusedBlockId: 'block-1' };

  const storeWith = (focusedContent: string | undefined) => ({
    getBlock: vi.fn((id: string) =>
      id === 'block-1' && focusedContent !== undefined ? { content: focusedContent } : undefined
    ),
    createBlockAfter: vi.fn(() => 'new-block'),
    updateBlockContent: vi.fn(),
  });

  it('fills the focused block IN PLACE when it is empty', () => {
    // The common case: user hits Enter for a fresh block, then mod-clicks a
    // file. Creating a sibling here would strand an empty block above it.
    const store = storeWith('');

    const id = insertCatBlockAt(target, '/path/to/design.md', store);

    expect(id).toBe('block-1');
    expect(store.createBlockAfter).not.toHaveBeenCalled();
    expect(store.updateBlockContent).toHaveBeenCalledWith(
      'block-1',
      `sh:: cat '/path/to/design.md'`
    );
  });

  it('treats a whitespace-only block as empty', () => {
    const store = storeWith('   \n  ');

    expect(insertCatBlockAt(target, '/path/to/x.md', store)).toBe('block-1');
    expect(store.createBlockAfter).not.toHaveBeenCalled();
  });

  it('creates a sibling BELOW when the focused block has content — never clobbers', () => {
    const store = storeWith('notes the user already typed');

    const id = insertCatBlockAt(target, '/path/to/design.md', store);

    expect(id).toBe('new-block');
    expect(store.createBlockAfter).toHaveBeenCalledWith('block-1');
    expect(store.updateBlockContent).toHaveBeenCalledWith(
      'new-block',
      `sh:: cat '/path/to/design.md'`
    );
    // The pre-existing content was never written over.
    expect(store.updateBlockContent).not.toHaveBeenCalledWith('block-1', expect.anything());
  });

  it('falls back to creating a sibling when the focused block cannot be read', () => {
    const store = storeWith(undefined);

    expect(insertCatBlockAt(target, '/path/to/x.md', store)).toBe('new-block');
    expect(store.createBlockAfter).toHaveBeenCalledWith('block-1');
  });

  it('shell-quotes the inserted path too — an inserted sh:: block is one Enter from running', () => {
    const store = storeWith('has content');

    insertCatBlockAt(target, '/tmp/$(rm -rf ~)/my notes.md', store);

    expect(store.updateBlockContent).toHaveBeenCalledWith(
      'new-block',
      `sh:: cat '/tmp/$(rm -rf ~)/my notes.md'`
    );
  });

  it('returns null and writes no content when the store refuses the insert', () => {
    // createBlockAfter returns '' when the anchor (or its parent) vanished.
    const store = {
      getBlock: vi.fn(() => ({ content: 'has content' })),
      createBlockAfter: vi.fn(() => ''),
      updateBlockContent: vi.fn(),
    };

    expect(insertCatBlockAt(target, '/path/to/x.md', store)).toBeNull();
    expect(store.updateBlockContent).not.toHaveBeenCalled();
  });
});

describe('catCommand', () => {
  it('is the single source of the command string for copy and insert alike', () => {
    expect(catCommand('/path/to/a b.md')).toBe(`sh:: cat '/path/to/a b.md'`);
  });
});

// ── metadata filter ───────────────────────────────────────────────────

describe('FILTER_KEYS (fuzzy over metadata, not just name)', () => {
  const rows: FileEvent[] = [
    file({
      id: 'a',
      filePath: '/work/alpha/design.md',
      toolName: 'Write',
      sessionId: 'sess-aaaa',
      cwd: '/work/alpha',
      gitBranch: 'feat/pipeline',
      snippet: 'Drafting the ingestion spec.',
    }),
    file({
      id: 'b',
      filePath: '/work/beta/readme.md',
      toolName: 'MultiEdit',
      sessionId: 'sess-bbbb',
      cwd: '/work/beta',
      gitBranch: 'main',
      snippet: 'Fixing the changelog.',
    }),
  ];

  const matchIds = (query: string) =>
    fuzzyFilter(rows, query, { keys: FILTER_KEYS }).map((f) => f.id);

  it('matches on the filename', () => {
    expect(matchIds('readme')).toEqual(['b']);
  });

  it('matches on a path segment that is not the filename', () => {
    expect(matchIds('alpha')).toEqual(['a']);
  });

  it('matches on tool name', () => {
    expect(matchIds('MultiEdit')).toEqual(['b']);
  });

  it('matches on session id', () => {
    expect(matchIds('sess-aaaa')).toEqual(['a']);
  });

  it('matches on git branch', () => {
    expect(matchIds('pipeline')).toEqual(['a']);
  });

  it('matches on the provenance snippet — the whole point of "not just name"', () => {
    expect(matchIds('changelog')).toEqual(['b']);
  });

  it('returns everything for an empty query', () => {
    expect(matchIds('')).toHaveLength(2);
  });
});

describe('shellQuotePath', () => {
  it('wraps a plain path in single quotes', () => {
    expect(shellQuotePath('/path/to/file.md')).toBe(`'/path/to/file.md'`);
  });

  it('keeps paths with spaces as a single argument', () => {
    expect(shellQuotePath('/path/to/my notes.md')).toBe(`'/path/to/my notes.md'`);
  });

  it('neutralizes shell metacharacters', () => {
    // Inside single quotes these are all literal — no command substitution,
    // no command chaining, no globbing.
    expect(shellQuotePath('/tmp/$(rm -rf ~).md')).toBe(`'/tmp/$(rm -rf ~).md'`);
    expect(shellQuotePath('/tmp/`whoami`.md')).toBe(`'/tmp/\`whoami\`.md'`);
    expect(shellQuotePath('/tmp/a;b.md')).toBe(`'/tmp/a;b.md'`);
  });

  it('escapes embedded single quotes via close-escape-reopen', () => {
    // /tmp/it's.md → '/tmp/it'\''s.md' — the only escape single-quoting needs.
    expect(shellQuotePath("/tmp/it's.md")).toBe(`'/tmp/it'\\''s.md'`);
  });

  it('produces a command whose payload cannot break out of the quotes', () => {
    const cmd = `cat ${shellQuotePath("/tmp/x'; rm -rf ~ #.md")}`;
    // The injected quote is escaped, so the `; rm` stays inside the argument.
    expect(cmd).toBe(`cat '/tmp/x'\\''; rm -rf ~ #.md'`);
  });
});

describe('formatRelativeTime', () => {
  // Fixed "now" so these never go flaky.
  const now = Date.parse('2026-07-12T12:00:00.000Z');

  it('returns empty string for missing or unparseable timestamps', () => {
    expect(formatRelativeTime(undefined, now)).toBe('');
    expect(formatRelativeTime('not a date', now)).toBe('');
  });

  it('formats sub-minute ages as "just now"', () => {
    expect(formatRelativeTime('2026-07-12T11:59:30.000Z', now)).toBe('just now');
  });

  it('formats minutes, hours, and days', () => {
    expect(formatRelativeTime('2026-07-12T11:57:00.000Z', now)).toBe('3m ago');
    expect(formatRelativeTime('2026-07-12T10:00:00.000Z', now)).toBe('2h ago');
    expect(formatRelativeTime('2026-07-09T12:00:00.000Z', now)).toBe('3d ago');
  });

  it('floors rather than rounds, so nothing reads as older than it is', () => {
    // 59m59s must not round up to "1h ago".
    expect(formatRelativeTime('2026-07-12T11:00:01.000Z', now)).toBe('59m ago');
  });

  it('falls back to a date past a week', () => {
    expect(formatRelativeTime('2026-06-01T12:00:00.000Z', now)).not.toMatch(/ago/);
  });

  it('never reports a future write as a negative age', () => {
    expect(formatRelativeTime('2026-07-12T12:05:00.000Z', now)).toBe('just now');
  });
});
