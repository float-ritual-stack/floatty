/**
 * Info Handler - dumps diagnostic info into the outliner
 *
 * Uses child-output pattern (like backup::):
 *   Single heading + table body child, idempotent re-run via findOutputChild.
 *
 * Usage:
 *   info::           → dump all diagnostic info
 *   info:: sync      → sync status only
 *   info:: config    → config info only
 *   info:: build     → build info only
 */

import type { BlockHandler, ExecutorActions } from './types';
import type { AggregatorConfig } from '../tauriTypes';
import { getConfig } from '../../context/ConfigContext';
import { getSyncStatus, getPendingCount, getLastSyncError } from '../../hooks/useSyncedYDoc';
import { findOutputChild } from './utils';
import { createLogger } from '../logger';

const logger = createLogger('info');

// ═══════════════════════════════════════════════════════════════
// PURE COMMAND FUNCTIONS
// ═══════════════════════════════════════════════════════════════

async function handleBuild(config: AggregatorConfig): Promise<string> {
  let version = '(health endpoint unreachable)';
  try {
    const resp = await fetch(`http://127.0.0.1:${config.server_port}/api/v1/health`);
    if (resp.ok) {
      const health = await resp.json() as { version?: string; gitSha?: string; gitDirty?: boolean };
      version = `${health.version || 'unknown'}${health.gitSha ? ` (${health.gitSha}${health.gitDirty ? '-dirty' : ''})` : ''}`;
    }
  } catch {
    // leave default
  }

  return [
    '## Build',
    '',
    '| Property | Value |',
    '|----------|-------|',
    `| Build | ${config.is_dev_build ? 'dev (debug)' : 'release'} |`,
    `| Data dir | \`${config.data_dir}\` |`,
    `| Version | ${version} |`,
    `| Diagnostics | ${config.show_diagnostics ? 'on' : 'off'} |`,
  ].join('\n');
}

function handleConfig(config: AggregatorConfig): string {
  return [
    '## Config',
    '',
    '| Property | Value |',
    '|----------|-------|',
    `| Server port | ${config.server_port} |`,
    `| Workspace | ${config.workspace_name} |`,
    `| Ollama | ${config.ollama_endpoint} |`,
    `| Model | ${config.ollama_model} |`,
    `| Config path | \`${config.data_dir}/config.toml\` |`,
  ].join('\n');
}

function handleSync(snapshot: { status: string; pending: number; lastError: string | null }): string {
  const rows = [
    `| Status | ${snapshot.status} |`,
  ];

  if (snapshot.pending > 0) {
    rows.push(`| Pending updates | ${snapshot.pending} |`);
  }
  if (snapshot.lastError) {
    rows.push(`| Last error | ${snapshot.lastError} |`);
  }

  return [
    '## Sync',
    '',
    '| Property | Value |',
    '|----------|-------|',
    ...rows,
  ].join('\n');
}

// ═══════════════════════════════════════════════════════════════
// HANDLER IMPLEMENTATION
// ═══════════════════════════════════════════════════════════════

export const infoHandler: BlockHandler = {
  prefixes: ['info::'],

  async execute(blockId: string, content: string, actions: ExecutorActions) {
    const topic = content.replace(/^info::\s*/i, '').trim().toLowerCase();

    // Snapshot sync state BEFORE creating child blocks.
    // Each createBlockInside/updateBlockContent generates Y.Doc transactions
    // that inflate pendingCount — reading live signals would show our own writes.
    const syncSnapshot = {
      status: getSyncStatus(),
      pending: getPendingCount(),
      lastError: getLastSyncError(),
    };

    // Find or create heading child — set outputType immediately so re-runs
    // find it even if the handler is interrupted before completion
    let headingId = findOutputChild(blockId, actions, 'info-');
    if (!headingId) {
      headingId = actions.createBlockInside(blockId);
      if (actions.setBlockOutput) {
        actions.setBlockOutput(headingId, { topic: topic || 'all' }, `info-${topic || 'all'}`);
      }
    }

    // Show loading
    actions.updateBlockContent(headingId, '## Running...');
    if (actions.setBlockStatus) {
      actions.setBlockStatus(headingId, 'running');
    }

    try {
      const config = getConfig();
      if (!config) {
        actions.updateBlockContent(headingId, '## Config unavailable');
        if (actions.setBlockStatus) actions.setBlockStatus(headingId, 'idle');
        return;
      }

      const showBuild = !topic || topic === 'build';
      const showConfig = !topic || topic === 'config';
      const showSync = !topic || topic === 'sync';

      // Build markdown sections
      const sections: string[] = [];
      if (showBuild) sections.push(await handleBuild(config));
      if (showConfig) sections.push(handleConfig(config));
      if (showSync) sections.push(handleSync(syncSnapshot));

      const result = sections.join('\n\n');

      // Split result: first line is heading, rest is table body
      const lines = result.split('\n');
      const heading = lines[0] || '## System Info';
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
        actions.setBlockOutput(headingId, { topic: topic || 'all' }, `info-${topic || 'all'}`);
        actions.setBlockStatus(headingId, 'complete');
      }
    } catch (err) {
      logger.error('Error', { err });
      actions.updateBlockContent(headingId, '## error::info');

      // Reuse existing child for error message (idempotent on repeated failures)
      const parent = actions.getBlock?.(headingId) as { childIds?: string[] } | undefined;
      const errorId = parent?.childIds?.[0] ?? actions.createBlockInside(headingId);
      actions.updateBlockContent(errorId, `> ${String(err)}`);

      if (actions.setBlockOutput && actions.setBlockStatus) {
        actions.setBlockOutput(headingId, { error: String(err) }, 'info-error');
        actions.setBlockStatus(headingId, 'error');
      }
    }
  },
};
