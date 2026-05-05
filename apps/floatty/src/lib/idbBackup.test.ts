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

    // Format: floatty-backup-{build}|{encodedWorkspace}
    // End-anchored so a regression to the legacy 3-part `…|default` namespace fails.
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringMatching(/floatty-backup-dev\|my-workspace$/)
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
    // Format: floatty-backup-{build}|{workspace} — end-anchored so a regression to
    // the legacy 3-part `…|default` namespace fails.
    expect(relevantCall![0]).toMatch(/floatty-backup-(dev|release)\|format-test-ws$/);
  });
});
