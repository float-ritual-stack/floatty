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

/** Clickable segment in parent path breadcrumb */
export interface PathSegment {
  blockId: string;
  label: string;
}

/** Hydrated search result (with block content) */
export interface SearchResult {
  blockId: string;
  content: string;
  score: number;
  /** Block type (text, sh, ai, ctx, etc.) */
  blockType?: string;
  /** Parent path segments for context (clickable breadcrumb) */
  parentPath?: PathSegment[];
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
  const lower = trimmed.toLowerCase();
  const idx = lower.indexOf(SEARCH_PREFIX);

  // If prefix not found, return empty (will trigger validation error)
  if (idx < 0) return '';

  const prefixEnd = idx + SEARCH_PREFIX.length;
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

/** Default search timeout in ms */
const SEARCH_TIMEOUT_MS = 10000;

/** Track active searches per block for cancellation */
const activeSearches = new Map<string, AbortController>();

/**
 * Search blocks via REST API
 * @param signal - Optional AbortSignal for cancellation
 */
async function searchBlocks(
  query: string,
  limit: number = 20,
  signal?: AbortSignal
): Promise<{ hits: SearchHit[]; total: number }> {
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
    signal,
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

/** Block shape for hydration */
interface HydratableBlock {
  content?: string;
  type?: string;
  parentId?: string;
}

/**
 * Build parent path by walking up the tree (max 3 ancestors)
 * Returns array of PathSegment for clickable breadcrumb
 */
function buildParentPath(blockId: string, getBlock: (id: string) => unknown): PathSegment[] | undefined {
  const ancestors: PathSegment[] = [];
  let currentId = blockId;
  let depth = 0;
  const maxDepth = 3;

  while (depth < maxDepth) {
    const block = getBlock(currentId) as HydratableBlock | undefined;
    if (!block?.parentId) break;

    const parent = getBlock(block.parentId) as HydratableBlock | undefined;
    if (!parent) break;

    // Get first line of parent content, truncated
    const parentContent = parent.content || '';
    const firstLine = parentContent.split('\n')[0];
    const label = firstLine.length > 30 ? firstLine.slice(0, 27) + '...' : firstLine;

    if (label) {
      ancestors.unshift({
        blockId: block.parentId,
        label,
      });
    }

    currentId = block.parentId;
    depth++;
  }

  return ancestors.length > 0 ? ancestors : undefined;
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
    const block = getBlock(hit.blockId) as HydratableBlock | undefined;

    return {
      blockId: hit.blockId,
      content: block?.content || '[Block not found]',
      score: hit.score,
      blockType: block?.type,
      parentPath: buildParentPath(hit.blockId, getBlock),
    };
  });
}

/**
 * Truncate content for display (multiple lines, preserving structure)
 * Shows up to maxLines lines and maxLen total chars
 */
export function truncateContent(content: string, maxLen: number = 200, maxLines: number = 3): string {
  const lines = content.split('\n');
  let result = '';
  let lineCount = 0;

  for (const line of lines) {
    if (lineCount >= maxLines) break;
    if (result.length + line.length > maxLen) {
      // Add partial line if we have room
      const remaining = maxLen - result.length;
      if (remaining > 20) {
        result += (result ? '\n' : '') + line.slice(0, remaining - 3) + '...';
      }
      break;
    }
    result += (result ? '\n' : '') + line;
    lineCount++;
  }

  // If we hit maxLines but there's more content, add ellipsis
  if (lineCount >= maxLines && lines.length > maxLines) {
    result += '\n...';
  }

  return result || content.slice(0, maxLen);
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

    // Cancel any existing search for this block (prevents race conditions)
    const existing = activeSearches.get(blockId);
    if (existing) {
      existing.abort();
      activeSearches.delete(blockId);
    }

    // Create new controller with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
    activeSearches.set(blockId, controller);

    // Show loading state
    if (actions.setBlockStatus) {
      actions.setBlockStatus(blockId, 'running');
    }

    try {
      // Execute search with abort signal
      const { hits, total } = await searchBlocks(query, 20, controller.signal);

      // Check if this search was superseded (another search started for same block)
      if (activeSearches.get(blockId) !== controller) {
        return; // Silently exit - newer search will handle results
      }

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
      // Handle abort specially
      if (err instanceof DOMException && err.name === 'AbortError') {
        // Check if aborted due to timeout vs superseded
        if (activeSearches.get(blockId) === controller) {
          // Timeout - show error
          console.warn('[search] Timed out:', query);
          if (actions.setBlockOutput && actions.setBlockStatus) {
            actions.setBlockOutput(
              blockId,
              { error: 'Search timed out. Try a simpler query.', query } as SearchErrorData,
              'search-error'
            );
            actions.setBlockStatus(blockId, 'error');
          }
        }
        // If superseded, silently return - newer search handles UI
        return;
      }

      console.error('[search] Error:', err);
      if (actions.setBlockOutput && actions.setBlockStatus) {
        actions.setBlockOutput(
          blockId,
          { error: String(err), query } as SearchErrorData,
          'search-error'
        );
        actions.setBlockStatus(blockId, 'error');
      }
    } finally {
      clearTimeout(timeoutId);
      // Only delete if this is still the active search
      if (activeSearches.get(blockId) === controller) {
        activeSearches.delete(blockId);
      }
    }
  },
};
