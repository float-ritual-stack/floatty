/**
 * Backup Handler (backup::)
 *
 * Commands for interacting with the backup daemon.
 * Uses child-output pattern like search::
 *
 * Commands:
 *   backup::status   - Show daemon status and timing
 *   backup::list     - List backup files
 *   backup::trigger  - Force immediate backup
 *   backup::config   - Show backup configuration
 *   backup::restore <filename> - Restore from backup (requires --confirm)
 */

import type { BlockHandler, ExecutorActions } from './types';
import { invoke } from '../tauriTypes';
import type { ServerInfo } from '../httpClient';
import { findOutputChild, formatBytes, formatRelativeTime } from './utils';

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

/** Backup daemon status */
export interface BackupStatus {
  running: boolean;
  lastBackup: string | null;
  nextBackup: string | null;
  backupCount: number;
  totalSizeBytes: number;
  backupDir: string;
}

/** Backup file info */
export interface BackupFile {
  filename: string;
  sizeBytes: number;
  created: string;
}

/** Backup trigger response */
export interface BackupTriggerResult {
  filename: string;
  sizeBytes: number;
}

/** Backup restore response */
export interface BackupRestoreResult {
  blockCount: number;
  rootCount: number;
}

/** Backup config response */
export interface BackupConfigInfo {
  enabled: boolean;
  intervalHours: number;
  retainHourly: number;
  retainDaily: number;
  retainWeekly: number;
  backupDir: string;
}

// ═══════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════

const BACKUP_PREFIX = 'backup::';

/**
 * Extract command and args from backup:: block content
 */
function parseCommand(content: string): { command: string; args: string[] } {
  const trimmed = content.trim();
  const prefixEnd = trimmed.toLowerCase().indexOf(BACKUP_PREFIX) + BACKUP_PREFIX.length;
  const rest = trimmed.slice(prefixEnd).trim();
  const parts = rest.split(/\s+/);
  return {
    command: parts[0]?.toLowerCase() || 'help',
    args: parts.slice(1),
  };
}


/**
 * Make authenticated API request
 */
async function backupApi<T>(endpoint: string, method = 'GET', body?: unknown): Promise<T> {
  const serverInfo = await invoke<ServerInfo>('get_server_info', {});
  const url = `${serverInfo.url}/api/v1/backup/${endpoint}`;

  const response = await fetch(url, {
    method,
    headers: {
      'Authorization': `Bearer ${serverInfo.api_key}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Backup API error: ${response.status} - ${text}`);
  }

  return response.json();
}

// ═══════════════════════════════════════════════════════════════
// COMMAND IMPLEMENTATIONS
// ═══════════════════════════════════════════════════════════════

async function handleStatus(): Promise<string> {
  const status = await backupApi<BackupStatus>('status');

  return [
    '## Backup Status',
    '',
    '| Property | Value |',
    '|----------|-------|',
    `| Daemon | ${status.running ? '✓ Running' : '✗ Stopped'} |`,
    `| Last backup | ${formatRelativeTime(status.lastBackup)} |`,
    `| Next backup | ${formatRelativeTime(status.nextBackup)} |`,
    `| Total files | ${status.backupCount} |`,
    `| Total size | ${formatBytes(status.totalSizeBytes)} |`,
    `| Backup dir | \`${status.backupDir}\` |`,
  ].join('\n');
}

async function handleList(): Promise<string> {
  const response = await backupApi<{ backups: BackupFile[] }>('list');
  const backups = response.backups;

  if (backups.length === 0) {
    return '> No backups found.';
  }

  const lines = [
    '## Recent Backups',
    '',
    '| Filename | Size | Age |',
    '|----------|------|-----|',
  ];

  // Show up to 15 most recent
  for (const b of backups.slice(0, 15)) {
    lines.push(`| \`${b.filename}\` | ${formatBytes(b.sizeBytes)} | ${formatRelativeTime(b.created)} |`);
  }

  if (backups.length > 15) {
    lines.push('', `*...and ${backups.length - 15} more*`);
  }

  return lines.join('\n');
}

async function handleTrigger(): Promise<string> {
  const result = await backupApi<BackupTriggerResult>('trigger', 'POST');
  return [
    '## ✓ Backup Triggered',
    '',
    '| File | Size |',
    '|------|------|',
    `| \`${result.filename}\` | ${formatBytes(result.sizeBytes)} |`,
  ].join('\n');
}

async function handleConfig(): Promise<string> {
  const config = await backupApi<BackupConfigInfo>('config');

  return [
    '## Backup Configuration',
    '',
    '| Setting | Value |',
    '|---------|-------|',
    `| Enabled | ${config.enabled ? '✓' : '✗'} |`,
    `| Interval | ${config.intervalHours} hour${config.intervalHours === 1 ? '' : 's'} |`,
    `| Retain hourly | ${config.retainHourly} backups |`,
    `| Retain daily | ${config.retainDaily} backups |`,
    `| Retain weekly | ${config.retainWeekly} backups |`,
    `| Backup dir | \`${config.backupDir}\` |`,
  ].join('\n');
}

async function handleRestore(filename: string | undefined, args: string[]): Promise<string> {
  if (!filename) {
    return 'error::Usage: `backup::restore <filename> --confirm`';
  }

  const confirmed = args.includes('--confirm');

  if (!confirmed) {
    // Show warning, require explicit confirmation
    const response = await backupApi<{ backups: BackupFile[] }>('list');
    const backup = response.backups.find(b => b.filename === filename);

    if (!backup) {
      return `error::Backup not found: \`${filename}\``;
    }

    return [
      '## ⚠️ Restore Warning',
      '',
      '> **This will replace ALL current state.**',
      '',
      '| Backup | Size |',
      '|--------|------|',
      `| \`${backup.filename}\` | ${formatBytes(backup.sizeBytes)} |`,
      '',
      `To proceed: \`backup::restore ${filename} --confirm\``,
    ].join('\n');
  }

  // Actually restore
  const result = await backupApi<BackupRestoreResult>('restore', 'POST', { filename });

  return [
    '## ✓ Restore Complete',
    '',
    '| Metric | Count |',
    '|--------|-------|',
    `| Blocks restored | ${result.blockCount} |`,
    `| Root blocks | ${result.rootCount} |`,
  ].join('\n');
}

function handleHelp(): string {
  return [
    '## Backup Commands',
    '',
    '| Command | Description |',
    '|---------|-------------|',
    '| `backup::status` | Daemon status and timing |',
    '| `backup::list` | List backup files |',
    '| `backup::trigger` | Force immediate backup |',
    '| `backup::config` | Show configuration |',
    '| `backup::restore <file> --confirm` | Restore from backup |',
  ].join('\n');
}

// ═══════════════════════════════════════════════════════════════
// HANDLER IMPLEMENTATION
// ═══════════════════════════════════════════════════════════════

export const backupHandler: BlockHandler = {
  prefixes: ['backup::'],

  async execute(blockId: string, content: string, actions: ExecutorActions): Promise<void> {
    const { command, args } = parseCommand(content);

    // Find or create heading child
    let headingId = findOutputChild(blockId, actions, 'backup-');
    if (!headingId) {
      headingId = actions.createBlockInside(blockId);
    }

    // Show loading
    actions.updateBlockContent(headingId, '## Running...');
    if (actions.setBlockStatus) {
      actions.setBlockStatus(headingId, 'running');
    }

    try {
      console.log('[backup] Executing:', { command, args });

      let result: string;
      switch (command) {
        case 'status':
          result = await handleStatus();
          break;
        case 'list':
          result = await handleList();
          break;
        case 'trigger':
          result = await handleTrigger();
          break;
        case 'config':
          result = await handleConfig();
          break;
        case 'restore':
          result = await handleRestore(args[0], args.slice(1));
          break;
        case 'help':
        default:
          result = handleHelp();
          break;
      }

      // Split result: first line is heading, rest is table body
      const lines = result.split('\n');
      const heading = lines[0] || `## backup::${command}`;
      const body = lines.slice(1).join('\n').trim();

      // Set heading content
      actions.updateBlockContent(headingId, heading);

      // Create or find table child under heading
      if (body) {
        const parent = actions.getBlock?.(headingId) as { childIds?: string[] } | undefined;
        let tableId = parent?.childIds?.[0];
        if (!tableId) {
          tableId = actions.createBlockInside(headingId);
        }
        actions.updateBlockContent(tableId, body);
      }

      if (actions.setBlockOutput && actions.setBlockStatus) {
        actions.setBlockOutput(headingId, { command, result }, `backup-${command}`);
        actions.setBlockStatus(headingId, result.startsWith('error::') ? 'error' : 'complete');
      }
    } catch (err) {
      console.error('[backup] Error:', err);
      actions.updateBlockContent(headingId, `## error::${command}`);

      // Put error in child
      const errorId = actions.createBlockInside(headingId);
      actions.updateBlockContent(errorId, `> ${String(err)}`);

      if (actions.setBlockOutput && actions.setBlockStatus) {
        actions.setBlockOutput(headingId, { error: String(err), command }, 'backup-error');
        actions.setBlockStatus(headingId, 'error');
      }
    }
  },
};
