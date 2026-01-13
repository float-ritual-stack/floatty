/**
 * Search Handler (search::)
 *
 * Full-text search across blocks using Tantivy.
 * Uses lens pattern: renders results in-place via setBlockOutput.
 *
 * Usage:
 *   search:: project floatty
 *   search:: ctx:: issue
 *   search:: meeting notes
 *
 * Results are shown inline with click-to-navigate functionality.
 *
 * @see docs/handoffs/search-plugin-spec.md
 */

import type { BlockHandler, ExecutorActions } from './types';

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

/** Search hit from API */
export interface SearchHit {
  blockId: string;
  score: number;
}

/** Hydrated search result (with block content) */
export interface SearchResult {
  blockId: string;
  content: string;
  score: number;
  /** Block type (text, sh, ai, ctx, etc.) */
  blockType?: string;
}

/** Search results data for view */
export interface SearchResultsData {
  query: string;
  results: SearchResult[];
  total: number;
  /** Search duration in ms */
  durationMs: number;
}

/** Search error data */
export interface SearchErrorData {
  error: string;
  query?: string;
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
 * Get server URL from window global (set by httpClient)
 */
function getServerUrl(): string {
  const url = (window as unknown as { __FLOATTY_SERVER_URL__?: string }).__FLOATTY_SERVER_URL__;
  if (!url) {
    throw new Error('Server URL not available. Is floatty-server running?');
  }
  return url;
}

/**
 * Get API key from window global (set by httpClient)
 */
function getApiKey(): string {
  const key = (window as unknown as { __FLOATTY_API_KEY__?: string }).__FLOATTY_API_KEY__;
  if (!key) {
    throw new Error('API key not available. Is floatty-server running?');
  }
  return key;
}

/**
 * Search blocks via REST API
 */
async function searchBlocks(query: string, limit: number = 20): Promise<{ hits: SearchHit[]; total: number }> {
  const url = getServerUrl();
  const apiKey = getApiKey();
  const params = new URLSearchParams({
    q: query,
    limit: String(limit),
  });

  const response = await fetch(`${url}/api/v1/search?${params}`, {
    headers: {
      'Authorization': `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    if (response.status === 503) {
      throw new Error('Search index not available. Try again in a moment.');
    }
    throw new Error(`Search failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  return {
    hits: data.hits.map((h: { block_id: string; score: number }) => ({
      blockId: h.block_id,
      score: h.score,
    })),
    total: data.total,
  };
}

/**
 * Hydrate search hits with block content
 * Fetches full block data from Y.Doc via getBlock action
 */
function hydrateResults(
  hits: SearchHit[],
  getBlock: (id: string) => unknown
): SearchResult[] {
  return hits.map(hit => {
    const block = getBlock(hit.blockId) as {
      content?: string;
      type?: string;
    } | undefined;

    return {
      blockId: hit.blockId,
      content: block?.content || '[Block not found]',
      score: hit.score,
      blockType: block?.type,
    };
  });
}

/**
 * Truncate content for display (first line, max 100 chars)
 */
export function truncateContent(content: string, maxLen: number = 100): string {
  // Get first line
  const firstLine = content.split('\n')[0];
  if (firstLine.length <= maxLen) return firstLine;
  return firstLine.slice(0, maxLen - 3) + '...';
}

// ═══════════════════════════════════════════════════════════════
// HANDLER IMPLEMENTATION
// ═══════════════════════════════════════════════════════════════

export const searchHandler: BlockHandler = {
  prefixes: ['search::'],

  async execute(blockId: string, content: string, actions: ExecutorActions): Promise<void> {
    const startTime = performance.now();
    const query = extractQuery(content);

    // Validate query
    if (!query) {
      if (actions.setBlockOutput && actions.setBlockStatus) {
        actions.setBlockOutput(blockId, { error: 'No search query. Usage: search:: your query' } as SearchErrorData, 'search-error');
        actions.setBlockStatus(blockId, 'error');
      }
      return;
    }

    // Show loading state
    if (actions.setBlockStatus) {
      actions.setBlockStatus(blockId, 'running');
    }

    try {
      // Execute search
      const { hits, total } = await searchBlocks(query);

      // Hydrate with block content
      const results = actions.getBlock
        ? hydrateResults(hits, actions.getBlock)
        : hits.map(h => ({ ...h, content: '[Loading...]' }));

      const durationMs = performance.now() - startTime;

      console.log('[search] Complete:', {
        query,
        results: results.length,
        duration: `${durationMs.toFixed(1)}ms`,
      });

      // Store results for view
      const data: SearchResultsData = {
        query,
        results,
        total,
        durationMs,
      };

      if (actions.setBlockOutput && actions.setBlockStatus) {
        actions.setBlockOutput(blockId, data, 'search-results');
        actions.setBlockStatus(blockId, 'complete');
      }
    } catch (err) {
      console.error('[search] Error:', err);
      if (actions.setBlockOutput && actions.setBlockStatus) {
        actions.setBlockOutput(
          blockId,
          { error: String(err), query } as SearchErrorData,
          'search-error'
        );
        actions.setBlockStatus(blockId, 'error');
      }
    }
  },
};
