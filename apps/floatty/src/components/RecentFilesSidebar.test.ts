import { describe, it, expect } from 'vitest';
import { formatRelativeTime, shellQuotePath } from './RecentFilesSidebar';

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
