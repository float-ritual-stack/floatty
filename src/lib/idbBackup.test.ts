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

    // Should log the new namespace via logger.info
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('floatty-backup-dev-my-workspace')
    );
  });

  it('initBackupNamespace handles special characters in workspace name', async () => {
    const { initBackupNamespace } = await import('./idbBackup');
    mockLogger.info.mockClear();

    // Workspace names might have special chars
    initBackupNamespace('work space-with_chars');

    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('work space-with_chars')
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
  it('namespace follows pattern: floatty-backup-{build}-{workspace}', async () => {
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
    expect(relevantCall![0]).toMatch(/floatty-backup-(dev|release)-format-test-ws/);
  });
});
