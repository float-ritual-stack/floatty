import { describe, it, expect } from 'vitest';
import { formatRelativeTime } from './RecentFilesSidebar';

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
