/**
 * Filter Parser - Parses filter rules from child blocks and matches against block markers
 *
 * Syntax:
 *   filter:: tasks for floatty        ← Parent block (title/description)
 *     - include(project::floatty)     ← Child block as rule
 *     - include(type::task)           ← Child block as rule
 *     - exclude(status::archived)     ← Child block as rule
 *     - limit(20)                     ← Options as children too
 *     - sort(updatedAt, desc)
 *     - any()                         ← Use OR instead of AND
 *
 * Reference: tauri-mast-year prototype /client/src/lib/filters.ts
 */

import type { Block } from './blockTypes';
import type { Marker } from '../generated/Marker';

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

export type FilterOperator = 'include' | 'exclude';
export type FilterCombinator = 'all' | 'any';

export interface FilterRule {
  operator: FilterOperator;
  /** The marker type to match (e.g., 'project', 'status', 'type') */
  markerType: string;
  /** The pattern to match against marker value. Supports: *, prefix*, *suffix */
  pattern: string;
}

export interface ParsedFilter {
  combinator: FilterCombinator;
  rules: FilterRule[];
  limit?: number;
  sort?: { field: string; direction: 'asc' | 'desc' };
  /** Child blocks that couldn't be parsed as rules */
  errors: Array<{ content: string; error: string }>;
}

// ═══════════════════════════════════════════════════════════════
// RULE PARSING
// ═══════════════════════════════════════════════════════════════

/**
 * Parse a single child block's content as a filter rule.
 *
 * Supported formats:
 *   include(marker::pattern)
 *   exclude(marker::pattern)
 *   include(marker::*)
 *   include(marker::prefix*)
 *   limit(N)
 *   sort(field, asc|desc)
 *   any()
 *
 * Content is trimmed and leading "- " bullet is stripped.
 */
export function parseFilterRule(content: string): FilterRule | { option: string; value: unknown } | null {
  // Normalize: trim and strip leading bullet
  let text = content.trim();
  if (text.startsWith('- ')) {
    text = text.slice(2).trim();
  }

  // include(marker::pattern)
  const includeMatch = text.match(/^include\(([^:]+)::([^)]*)\)$/i);
  if (includeMatch) {
    return {
      operator: 'include',
      markerType: includeMatch[1].trim(),
      pattern: includeMatch[2].trim() || '*',
    };
  }

  // exclude(marker::pattern)
  const excludeMatch = text.match(/^exclude\(([^:]+)::([^)]*)\)$/i);
  if (excludeMatch) {
    return {
      operator: 'exclude',
      markerType: excludeMatch[1].trim(),
      pattern: excludeMatch[2].trim() || '*',
    };
  }

  // limit(N)
  const limitMatch = text.match(/^limit\((\d+)\)$/i);
  if (limitMatch) {
    return { option: 'limit', value: parseInt(limitMatch[1], 10) };
  }

  // sort(field, direction)
  const sortMatch = text.match(/^sort\(([^,]+),?\s*(asc|desc)?\)$/i);
  if (sortMatch) {
    return {
      option: 'sort',
      value: {
        field: sortMatch[1].trim(),
        direction: (sortMatch[2]?.toLowerCase() ?? 'desc') as 'asc' | 'desc',
      },
    };
  }

  // any() - switch to OR combinator
  if (/^any\(\)$/i.test(text)) {
    return { option: 'combinator', value: 'any' as FilterCombinator };
  }

  // Not a recognized rule
  return null;
}

/**
 * Parse filter configuration from child blocks.
 */
export function parseFilterFromChildren(children: Block[]): ParsedFilter {
  const result: ParsedFilter = {
    combinator: 'all',
    rules: [],
    errors: [],
  };

  for (const child of children) {
    const content = child.content;
    const parsed = parseFilterRule(content);

    if (parsed === null) {
      // Skip empty/whitespace-only children
      if (content.trim() && !content.trim().startsWith('#')) {
        result.errors.push({ content, error: 'Unrecognized filter syntax' });
      }
      continue;
    }

    // Handle options
    if ('option' in parsed) {
      switch (parsed.option) {
        case 'limit':
          result.limit = parsed.value as number;
          break;
        case 'sort':
          result.sort = parsed.value as { field: string; direction: 'asc' | 'desc' };
          break;
        case 'combinator':
          result.combinator = parsed.value as FilterCombinator;
          break;
      }
      continue;
    }

    // It's a rule
    result.rules.push(parsed);
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════
// PATTERN MATCHING
// ═══════════════════════════════════════════════════════════════

/**
 * Match a value against a pattern with wildcard support.
 *
 * Patterns:
 *   * - Match any value
 *   prefix* - Match values starting with prefix
 *   *suffix - Match values ending with suffix
 *   exact - Exact match
 */
export function matchesPattern(value: string | null, pattern: string): boolean {
  // * matches anything including null
  if (pattern === '*') {
    return true;
  }

  // Null value only matches * pattern
  if (value === null) {
    return false;
  }

  // Prefix match: pattern*
  if (pattern.endsWith('*')) {
    const prefix = pattern.slice(0, -1);
    return value.startsWith(prefix);
  }

  // Suffix match: *pattern
  if (pattern.startsWith('*')) {
    const suffix = pattern.slice(1);
    return value.endsWith(suffix);
  }

  // Exact match
  return value === pattern;
}

/**
 * Check if markers match a filter rule.
 */
export function markersMatchRule(markers: Marker[], rule: FilterRule): boolean {
  return markers.some(
    (m) => m.markerType === rule.markerType && matchesPattern(m.value, rule.pattern)
  );
}

/**
 * Extract markers from block content as fallback when metadata is empty.
 * Looks for patterns like [marker::value] and marker:: prefix.
 *
 * This is a temporary fallback until MetadataExtractionHook populates block.metadata.markers.
 */
export function extractMarkersFromContent(content: string): Marker[] {
  const markers: Marker[] = [];

  // Match [marker::value] patterns (bracketed markers)
  const bracketPattern = /\[([a-zA-Z]+)::([^\]]*)\]/g;
  let match;
  while ((match = bracketPattern.exec(content)) !== null) {
    markers.push({
      markerType: match[1].toLowerCase(),
      value: match[2].trim() || null,
    });
  }

  // Match prefix markers at start of line: marker:: or marker::value
  // But not if already captured by bracket pattern
  const prefixPattern = /(?:^|\n)\s*([a-zA-Z]+)::\s*(\S*)/g;
  while ((match = prefixPattern.exec(content)) !== null) {
    const markerType = match[1].toLowerCase();
    // Skip common block type prefixes (handled separately)
    if (['sh', 'ai', 'filter', 'search', 'daily', 'web', 'link', 'output', 'error', 'picker', 'ran', 'dispatch'].includes(markerType)) {
      continue;
    }
    markers.push({
      markerType,
      value: match[2].trim() || null,
    });
  }

  return markers;
}

// ═══════════════════════════════════════════════════════════════
// FILTER EVALUATION
// ═══════════════════════════════════════════════════════════════

/**
 * Evaluate whether a block matches the filter.
 *
 * Logic:
 *   1. Check excludes first (short-circuit if any match)
 *   2. If no include rules, block passes
 *   3. For 'all' combinator: ALL include rules must match
 *   4. For 'any' combinator: ANY include rule must match
 */
export function blockMatchesFilter(block: Block, filter: ParsedFilter): boolean {
  // Use metadata markers if available, otherwise extract from content
  // Content extraction is a fallback until MetadataExtractionHook is implemented
  const markers = (block.metadata?.markers?.length ?? 0) > 0
    ? block.metadata!.markers
    : extractMarkersFromContent(block.content);

  const includeRules = filter.rules.filter((r) => r.operator === 'include');
  const excludeRules = filter.rules.filter((r) => r.operator === 'exclude');

  // Short-circuit: if any exclude matches, reject
  for (const rule of excludeRules) {
    if (markersMatchRule(markers, rule)) {
      return false;
    }
  }

  // No include rules = pass (excludes already checked)
  if (includeRules.length === 0) {
    return true;
  }

  // Apply combinator logic
  if (filter.combinator === 'any') {
    // OR: at least one include rule must match
    return includeRules.some((rule) => markersMatchRule(markers, rule));
  } else {
    // AND: all include rules must match
    return includeRules.every((rule) => markersMatchRule(markers, rule));
  }
}

/**
 * Execute filter against a collection of blocks.
 *
 * @param filter - Parsed filter configuration
 * @param blocks - All blocks to filter (typically from blockStore)
 * @param excludeIds - Block IDs to exclude (e.g., the filter block itself and its children)
 * @returns Matching blocks, sorted and limited per filter options
 */
export function executeFilter(
  filter: ParsedFilter,
  blocks: Block[],
  excludeIds: Set<string> = new Set()
): Block[] {
  // Filter blocks
  let results = blocks.filter((block) => {
    // Skip excluded blocks (filter block itself, its children)
    if (excludeIds.has(block.id)) return false;

    // Skip filter:: blocks (don't filter filters)
    if (block.type === 'filter') return false;

    // Apply filter rules
    return blockMatchesFilter(block, filter);
  });

  // Sort if specified
  if (filter.sort) {
    const { field, direction } = filter.sort;
    results = results.sort((a, b) => {
      let aVal: number | string | undefined;
      let bVal: number | string | undefined;

      // Handle known fields
      switch (field) {
        case 'updatedAt':
          aVal = a.updatedAt;
          bVal = b.updatedAt;
          break;
        case 'createdAt':
          aVal = a.createdAt;
          bVal = b.createdAt;
          break;
        case 'content':
          aVal = a.content;
          bVal = b.content;
          break;
        default:
          // Unknown field - no sorting
          return 0;
      }

      if (aVal === undefined || bVal === undefined) return 0;

      const comparison = aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
      return direction === 'asc' ? comparison : -comparison;
    });
  }

  // Apply limit
  const limit = filter.limit ?? 50; // Default limit to prevent huge result sets
  return results.slice(0, limit);
}

/**
 * Collect all descendant IDs of a block (for exclusion).
 */
export function collectDescendantIds(block: Block, getBlock: (id: string) => Block | undefined): Set<string> {
  const ids = new Set<string>([block.id]);

  function collect(blockId: string) {
    const b = getBlock(blockId);
    if (!b) return;
    for (const childId of b.childIds) {
      ids.add(childId);
      collect(childId);
    }
  }

  collect(block.id);
  return ids;
}
