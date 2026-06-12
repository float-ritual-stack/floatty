/**
 * idbBackup.test.ts - Tests for IndexedDB namespace isolation
 *
 * Note: Full IndexedDB tests require browser environment.
 * These tests verify the namespace logic and module behavior.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the logger module so tests can verify logging
const mockLogger = vi.hoisted(() => ({
  trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
}));
vi.mock('./logger', () => ({
  createLogger: () => mockLogger,
}));

// We need to mock IndexedDB since it's not available in Node
const mockIndexedDB = {
  open: vi.fn(),
  // Stubbed for the ADR-006 migration in initBackupNamespace — fire-and-forget
  // deleteDatabase that lets the production code's `req.onsuccess = …` assignment
  // succeed without erroring.
  deleteDatabase: vi.fn(() => ({ onsuccess: null, onerror: null, onblocked: null })),
};

// Mock the global indexedDB
vi.stubGlobal('indexedDB', mockIndexedDB);

describe('idbBackup namespace', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('initBackupNamespace creates correct name for dev build', async () => {
    // Mock DEV mode
    vi.stubGlobal('import', { meta: { env: { DEV: true } } });

    // Fresh import to get clean module state
    const { initBackupNamespace } = await import('./idbBackup');

    mockLogger.info.mockClear();

    initBackupNamespace('my-workspace');

    // Format: floatty-backup-{build}|{encodedWorkspace}|{serverSlug}
    // End-anchored so the third segment is verifiably the server slug
    // ('local' when no slug is passed), not the retired ADR-006 outline name.
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringMatching(/floatty-backup-dev\|my-workspace\|local$/)
    );
  });

  it('initBackupNamespace handles special characters in workspace name', async () => {
    const { initBackupNamespace } = await import('./idbBackup');
    mockLogger.info.mockClear();

    // Workspace names with spaces get encoded so they don't collide with the | delimiter
    initBackupNamespace('work space-with_chars');

    // encodeURIComponent turns ' ' → '%20', but '-' and '_' stay literal
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('work%20space-with_chars')
    );
  });

  it('initBackupNamespace does not log if name unchanged', async () => {
    const { initBackupNamespace } = await import('./idbBackup');
    mockLogger.info.mockClear();

    // First call - should log
    initBackupNamespace('same-workspace');
    expect(mockLogger.info).toHaveBeenCalledTimes(1);

    // Second call with same name - should not log again
    initBackupNamespace('same-workspace');
    expect(mockLogger.info).toHaveBeenCalledTimes(1);
  });

  it('initBackupNamespace logs when switching workspaces', async () => {
    const { initBackupNamespace } = await import('./idbBackup');
    mockLogger.info.mockClear();

    initBackupNamespace('workspace-a');
    initBackupNamespace('workspace-b');

    expect(mockLogger.info).toHaveBeenCalledTimes(2);
    expect(mockLogger.info).toHaveBeenNthCalledWith(1, expect.stringContaining('workspace-a'));
    expect(mockLogger.info).toHaveBeenNthCalledWith(2, expect.stringContaining('workspace-b'));
  });
});

describe('idbBackup namespace format', () => {
  it('namespace follows pattern: floatty-backup-{build}|{workspace}', async () => {
    // Reset modules to get fresh state
    vi.resetModules();
    const { initBackupNamespace } = await import('./idbBackup');
    mockLogger.info.mockClear();

    initBackupNamespace('format-test-ws');

    // Find the log call for our specific workspace
    const relevantCall = mockLogger.info.mock.calls.find(
      (call: unknown[]) => typeof call[0] === 'string' && call[0].includes('format-test-ws')
    );

    expect(relevantCall).toBeDefined();
    // Format: floatty-backup-{build}|{workspace}|{serverSlug} — end-anchored so
    // the server-identity segment (FLO-762) is always present.
    expect(relevantCall![0]).toMatch(/floatty-backup-(dev|release)\|format-test-ws\|local$/);
  });
});

describe('deriveServerSlug (FLO-762)', () => {
  it('returns "local" when URL is absent', async () => {
    const { deriveServerSlug } = await import('./idbBackup');
    expect(deriveServerSlug(undefined)).toBe('local');
    expect(deriveServerSlug(null)).toBe('local');
    expect(deriveServerSlug('')).toBe('local');
  });

  it('derives host:port from a remote URL', async () => {
    const { deriveServerSlug } = await import('./idbBackup');
    // ':' encodes to %3A — keeps the | namespace delimiter unambiguous
    expect(deriveServerSlug('http://float-box:8765')).toBe('float-box%3A8765');
    expect(deriveServerSlug('http://127.0.0.1:33333')).toBe('127.0.0.1%3A33333');
  });

  it('fills default port from protocol when URL omits it', async () => {
    const { deriveServerSlug } = await import('./idbBackup');
    expect(deriveServerSlug('https://floatty.example.com')).toBe('floatty.example.com%3A443');
    expect(deriveServerSlug('http://floatty.example.com')).toBe('floatty.example.com%3A80');
  });

  it('distinct servers produce distinct slugs (the whole point)', async () => {
    const { deriveServerSlug } = await import('./idbBackup');
    expect(deriveServerSlug('http://127.0.0.1:8765')).not.toBe(
      deriveServerSlug('http://float-box:8765')
    );
  });

  it('falls back to encoded raw string for unparseable URLs', async () => {
    const { deriveServerSlug } = await import('./idbBackup');
    expect(deriveServerSlug('not a url')).toBe(encodeURIComponent('not a url'));
  });

  it('namespace incorporates the server slug — server flip = fresh namespace', async () => {
    const { initBackupNamespace, deriveServerSlug } = await import('./idbBackup');
    mockLogger.info.mockClear();

    initBackupNamespace('slug-ws', deriveServerSlug('http://127.0.0.1:8765'));
    initBackupNamespace('slug-ws', deriveServerSlug('http://float-box:8765'));

    // Two distinct namespaces → two namespace-change logs
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringMatching(/floatty-backup-(dev|release)\|slug-ws\|127\.0\.0\.1%3A8765$/)
    );
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringMatching(/floatty-backup-(dev|release)\|slug-ws\|float-box%3A8765$/)
    );
  });
});
