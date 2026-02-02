/**
 * idbBackup.test.ts - Tests for IndexedDB namespace isolation
 *
 * Note: Full IndexedDB tests require browser environment.
 * These tests verify the namespace logic and module behavior.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

    // Spy on console.log to capture the namespace
    const logSpy = vi.spyOn(console, 'log');

    initBackupNamespace('my-workspace');

    // Should log the new namespace
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('floatty-backup-dev-my-workspace')
    );
  });

  it('initBackupNamespace handles special characters in workspace name', async () => {
    const { initBackupNamespace } = await import('./idbBackup');
    const logSpy = vi.spyOn(console, 'log');

    // Workspace names might have special chars
    initBackupNamespace('work space-with_chars');

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('work space-with_chars')
    );
  });

  it('initBackupNamespace does not log if name unchanged', async () => {
    const { initBackupNamespace } = await import('./idbBackup');
    const logSpy = vi.spyOn(console, 'log');

    // First call - should log
    initBackupNamespace('same-workspace');
    expect(logSpy).toHaveBeenCalledTimes(1);

    // Second call with same name - should not log again
    initBackupNamespace('same-workspace');
    expect(logSpy).toHaveBeenCalledTimes(1);
  });

  it('initBackupNamespace logs when switching workspaces', async () => {
    const { initBackupNamespace } = await import('./idbBackup');
    const logSpy = vi.spyOn(console, 'log');

    initBackupNamespace('workspace-a');
    initBackupNamespace('workspace-b');

    expect(logSpy).toHaveBeenCalledTimes(2);
    expect(logSpy).toHaveBeenNthCalledWith(1, expect.stringContaining('workspace-a'));
    expect(logSpy).toHaveBeenNthCalledWith(2, expect.stringContaining('workspace-b'));
  });
});

describe('idbBackup namespace format', () => {
  it('namespace follows pattern: floatty-backup-{build}-{workspace}', async () => {
    // Reset modules to get fresh state
    vi.resetModules();
    const { initBackupNamespace } = await import('./idbBackup');
    const logSpy = vi.spyOn(console, 'log');

    initBackupNamespace('format-test-ws');

    // Find the log call for our specific workspace
    const relevantCall = logSpy.mock.calls.find(
      call => typeof call[0] === 'string' && call[0].includes('format-test-ws')
    );

    expect(relevantCall).toBeDefined();
    expect(relevantCall![0]).toMatch(/floatty-backup-(dev|release)-format-test-ws/);
  });
});
