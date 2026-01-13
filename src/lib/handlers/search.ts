/**
 * Search Handler (search::)
 *
 * Lens-type handler that queries Tantivy and displays results inline.
 * Uses child-output pattern (output renders in a child block) like daily::.
 *
 * Pattern:
 *   search:: floatty           ← Parent stays editable for query refinement
 *   └── [child output block]   ← outputType='search-results', renders SearchResultsView
 */

import type { BlockHandler, ExecutorActions } from './types';
import { invoke } from '../tauriTypes';
import type { ServerInfo } from '../httpClient';

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

/** Single search hit from Tantivy */
export interface SearchHit {
  blockId: string;
  content: string;
  score: number;
}

/** Search results data for SearchResultsView */
export interface SearchResults {
  query: string;
  hits: SearchHit[];
  totalHits: number;
  searchTimeMs: number;
}

// ═══════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════

const SEARCH_PREFIX = 'search::';

/**
 * Extract query from search:: block content
 */
function extractQuery(content: string): string {
  const trimmed = content.trim();
  const prefixEnd = trimmed.toLowerCase().indexOf(SEARCH_PREFIX) + SEARCH_PREFIX.length;
  return trimmed.slice(prefixEnd).trim();
}

/**
 * Find existing output child block (for re-run replacement)
 */
function findOutputChild(parentId: string, actions: ExecutorActions): string | null {
  if (!actions.getBlock) return null;

  const parent = actions.getBlock(parentId) as { childIds?: string[] };
  if (!parent || !parent.childIds) return null;

  for (const childId of parent.childIds) {
    const child = actions.getBlock(childId) as { outputType?: string };
    if (child?.outputType === 'search-results' || child?.outputType === 'search-error') {
      return childId;
    }
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════
// HANDLER IMPLEMENTATION
// ═══════════════════════════════════════════════════════════════

export const searchHandler: BlockHandler = {
  prefixes: ['search::'],

  async execute(blockId: string, content: string, actions: ExecutorActions): Promise<void> {
    const startTime = performance.now();
    const query = extractQuery(content);

    // Find or create output child
    let outputId = findOutputChild(blockId, actions);
    if (!outputId) {
      outputId = actions.createBlockInside(blockId);
    }

    if (!query) {
      // No query specified - show error in child
      actions.updateBlockContent(outputId, 'error::No query specified. Use search:: your query here');
      if (actions.setBlockOutput && actions.setBlockStatus) {
        actions.setBlockOutput(outputId, { error: 'No query specified' }, 'search-error');
        actions.setBlockStatus(outputId, 'error');
      }
      return;
    }

    // Show loading indicator in child
    actions.updateBlockContent(outputId, 'output::Searching...');
    if (actions.setBlockStatus) {
      actions.setBlockStatus(outputId, 'running');
    }

    try {
      console.log('[search] Executing:', { query });

      // Get server info for auth
      const serverInfo = await invoke<ServerInfo>('get_server_info', {});

      // Query the search API with auth
      const response = await fetch(
        `${serverInfo.url}/api/v1/search?q=${encodeURIComponent(query)}&limit=20`,
        {
          headers: {
            'Authorization': `Bearer ${serverInfo.api_key}`,
          },
        }
      );

      if (!response.ok) {
        throw new Error(`Search failed: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      const duration = performance.now() - startTime;

      // API returns { hits: [{blockId, score, content}], total }
      // Content is hydrated server-side from Y.Doc (truncated to 200 chars)
      // Deduplicate by blockId (same block should only appear once)
      const seenIds = new Set<string>();
      const hits: SearchHit[] = (data.hits || [])
        .filter((hit: { blockId: string }) => {
          if (seenIds.has(hit.blockId)) {
            console.warn('[search] Duplicate blockId filtered:', hit.blockId);
            return false;
          }
          seenIds.add(hit.blockId);
          return true;
        })
        .map((hit: { blockId: string; score: number; content?: string }) => ({
          blockId: hit.blockId,
          content: hit.content ?? '(content unavailable)',
          score: hit.score,
        }));

      // Transform response to SearchResults
      const results: SearchResults = {
        query,
        hits,
        totalHits: data.total || hits.length,
        searchTimeMs: duration,
      };

      console.log('[search] Complete:', {
        duration: `${duration.toFixed(1)}ms`,
        hits: results.hits.length,
      });

      // Store structured output in child block
      actions.updateBlockContent(outputId, ''); // Clear loading text, view renders from output
      if (actions.setBlockOutput && actions.setBlockStatus) {
        actions.setBlockOutput(outputId, results, 'search-results');
        actions.setBlockStatus(outputId, 'complete');
      }
    } catch (err) {
      console.error('[search] Error:', err);
      actions.updateBlockContent(outputId, `error::${String(err)}`);
      if (actions.setBlockOutput && actions.setBlockStatus) {
        actions.setBlockOutput(outputId, { error: String(err), query }, 'search-error');
        actions.setBlockStatus(outputId, 'error');
      }
    }
  },
};
