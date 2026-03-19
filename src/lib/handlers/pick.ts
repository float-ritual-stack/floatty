/**
 * Pick Handler (pick::)
 *
 * Quick-jump handler that spawns fzf with search results.
 * Navigates to selected block.
 *
 * Pattern:
 *   pick:: floatty           ← User types query
 *   [Enter] → fzf picker     ← Spawns fzf with search API results
 *   [select] → navigate      ← Zooms to selected block
 */

import type { BlockHandler, ExecutorActions } from './types';
import { navigateToBlock } from '../navigation';
import { paneLinkStore } from '../../hooks/usePaneLinkStore';
import { findTabIdByPaneId } from '../../hooks/useBacklinkNavigation';
import { terminalManager } from '../terminalManager';
import { invoke } from '../tauriTypes';
import type { ServerInfo } from '../httpClient';

// ═══════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════

const PICK_PREFIX = 'pick::';

/**
 * Extract query from pick:: block content
 */
function extractQuery(content: string): string {
  const trimmed = content.trim();
  const prefixEnd = trimmed.toLowerCase().indexOf(PICK_PREFIX) + PICK_PREFIX.length;
  return trimmed.slice(prefixEnd).trim();
}

/**
 * Build fzf search command
 * Uses FLOATTY_API_KEY and FLOATTY_SERVER_URL env vars
 */
function buildSearchCommand(query: string): string {
  // Escape query for shell
  const escapedQuery = query.replace(/'/g, "'\\''");

  // Shell pipeline:
  // 1. curl the search API with auth
  // 2. jq filters to hits WITH content, formats as "content\tblockId"
  //    - gsub newlines AND tabs to spaces (tabs would confuse fzf delimiter)
  // 3. fzf shows content (--with-nth=1), uses last field as delimiter
  // 4. cut extracts blockId (last field)
  return `curl -s -H "Authorization: Bearer $FLOATTY_API_KEY" "$FLOATTY_SERVER_URL/api/v1/search?q=${encodeURIComponent(escapedQuery)}&limit=50" | jq -r '.hits[] | select(.content) | "\\((.content) | gsub("[\\n\\t]"; " "))\\t\\(.blockId)"' | fzf --height=100% --layout=reverse --with-nth=1 --delimiter='\\t' | cut -f2`;
}

/**
 * Spawn fzf picker with search results
 */
async function spawnSearchPicker(
  pickerId: string,
  query: string,
  paneId?: string
): Promise<string> {
  return new Promise((resolve) => {
    // Find picker container (with retry for SolidJS reactivity)
    const findContainer = (): HTMLElement | null => {
      const selector = paneId
        ? `.picker-terminal[data-block-id="${CSS.escape(pickerId)}"][data-pane-id="${CSS.escape(paneId)}"]`
        : `.picker-terminal[data-block-id="${CSS.escape(pickerId)}"]`;
      const container = document.querySelector(selector);
      return container instanceof HTMLElement ? container : null;
    };

    const trySpawn = async (attempts = 0) => {
      const container = findContainer();
      if (!container) {
        if (attempts < 10) {
          setTimeout(() => trySpawn(attempts + 1), 50);
          return;
        }
        console.error('[pick] Picker container not found');
        resolve('');
        return;
      }

      container.classList.add('picker-terminal--active');
      container.scrollIntoView({ behavior: 'smooth', block: 'center' });

      try {
        // Get server info for auth
        const serverInfo = await invoke('get_server_info', {}) as ServerInfo;

        const command = buildSearchCommand(query);
        const result = await terminalManager.spawnInteractivePicker(
          pickerId,
          container,
          command,
          undefined,
          undefined,
          {
            FLOATTY_API_KEY: serverInfo.api_key,
            FLOATTY_SERVER_URL: serverInfo.url,
          }
        );

        if (result.exitCode === 0 && result.output) {
          resolve(result.output);
        } else {
          resolve('');
        }
      } catch (err) {
        console.error('[pick] Picker failed:', err);
        resolve('');
      }
    };

    trySpawn(0);
  });
}

// ═══════════════════════════════════════════════════════════════
// HANDLER IMPLEMENTATION
// ═══════════════════════════════════════════════════════════════

export const pickHandler: BlockHandler = {
  prefixes: ['pick::'],

  async execute(blockId: string, content: string, actions: ExecutorActions): Promise<void> {
    const query = extractQuery(content);

    if (!query) {
      console.log('[pick] No query specified');
      return;
    }

    console.log('[pick] Executing:', { query });

    if (actions.setBlockStatus) {
      actions.setBlockStatus(blockId, 'running');
    }

    // Create picker block as child
    const pickerId = actions.createBlockInsideAtTop?.(blockId) ?? actions.createBlockInside(blockId);
    actions.updateBlockContent(pickerId, `picker::${query}`);

    try {
      const selectedBlockId = await spawnSearchPicker(pickerId, query, actions.paneId);

      if (selectedBlockId) {
        console.log('[pick] Navigating to:', selectedBlockId);
        // FLO-378: Resolve pane link at call site (FM #7)
        let targetPaneId = actions.paneId;
        const linkedPaneId = paneLinkStore.resolveLink(actions.paneId);
        if (linkedPaneId) {
          const sourceTab = findTabIdByPaneId(actions.paneId);
          const linkedTab = findTabIdByPaneId(linkedPaneId);
          if (sourceTab && sourceTab === linkedTab) {
            targetPaneId = linkedPaneId;
          }
        }
        navigateToBlock(selectedBlockId, {
          paneId: targetPaneId,
          highlight: true,
        });

        if (actions.setBlockStatus) {
          actions.setBlockStatus(blockId, 'complete');
        }
      } else {
        console.log('[pick] Picker cancelled');
        if (actions.setBlockStatus) {
          actions.setBlockStatus(blockId, 'idle');
        }
      }
    } catch (err) {
      console.error('[pick] Error:', err);
      if (actions.setBlockStatus) {
        actions.setBlockStatus(blockId, 'error');
      }
    } finally {
      // Clean up picker block
      actions.deleteBlock?.(pickerId);
    }
  },
};
