/**
 * Tests for filterParser.ts
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import {
  parseFilterRule,
  parseFilterFromChildren,
  matchesPattern,
  blockMatchesFilter,
  executeFilter,
  type ParsedFilter,
} from './filterParser';
import type { Block } from './blockTypes';
import type { Marker } from '../generated/Marker';

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════

function makeBlock(id: string, markers: Marker[], extra: Partial<Block> = {}): Block {
  return {
    id,
    parentId: null,
    childIds: [],
    content: `Block ${id}`,
    type: 'text',
    collapsed: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    metadata: {
      markers,
      outlinks: [],
      isStub: false,
      extractedAt: Date.now(),
    },
    ...extra,
  };
}

function makeChild(content: string): Block {
  return makeBlock(`child-${Math.random().toString(36).slice(2)}`, [], { content });
}

// ═══════════════════════════════════════════════════════════════
// parseFilterRule
// ═══════════════════════════════════════════════════════════════

describe('parseFilterRule', () => {
  it('parses include rule', () => {
    const result = parseFilterRule('include(project::floatty)');
    expect(result).toEqual({
      operator: 'include',
      markerType: 'project',
      pattern: 'floatty',
    });
  });

  it('parses include rule with trailing notes', () => {
    const result = parseFilterRule('include(project::floatty) <-- matches all floatty blocks');
    expect(result).toEqual({
      operator: 'include',
      markerType: 'project',
      pattern: 'floatty',
    });
  });

  it('parses exclude rule with trailing comments', () => {
    const result = parseFilterRule('exclude(status::archived) // hide archived');
    expect(result).toEqual({
      operator: 'exclude',
      markerType: 'status',
      pattern: 'archived',
    });
  });

  it('parses exclude rule', () => {
    const result = parseFilterRule('exclude(status::archived)');
    expect(result).toEqual({
      operator: 'exclude',
      markerType: 'status',
      pattern: 'archived',
    });
  });

  it('parses rule with wildcard pattern', () => {
    const result = parseFilterRule('include(project::*)');
    expect(result).toEqual({
      operator: 'include',
      markerType: 'project',
      pattern: '*',
    });
  });

  it('defaults to * pattern when empty', () => {
    const result = parseFilterRule('include(project::)');
    expect(result).toEqual({
      operator: 'include',
      markerType: 'project',
      pattern: '*',
    });
  });

  it('parses rule with prefix wildcard', () => {
    const result = parseFilterRule('include(project::float*)');
    expect(result).toEqual({
      operator: 'include',
      markerType: 'project',
      pattern: 'float*',
    });
  });

  it('strips leading bullet', () => {
    const result = parseFilterRule('- include(project::test)');
    expect(result).toEqual({
      operator: 'include',
      markerType: 'project',
      pattern: 'test',
    });
  });

  it('handles whitespace', () => {
    const result = parseFilterRule('  include( project :: value )  ');
    // Note: whitespace inside parens is trimmed
    expect(result).toEqual({
      operator: 'include',
      markerType: 'project',
      pattern: 'value',
    });
  });

  it('parses limit option', () => {
    const result = parseFilterRule('limit(20)');
    expect(result).toEqual({ option: 'limit', value: 20 });
  });

  it('parses sort option with direction', () => {
    const result = parseFilterRule('sort(updatedAt, desc)');
    expect(result).toEqual({
      option: 'sort',
      value: { field: 'updatedAt', direction: 'desc' },
    });
  });

  it('parses sort option without direction (defaults to desc)', () => {
    const result = parseFilterRule('sort(createdAt)');
    expect(result).toEqual({
      option: 'sort',
      value: { field: 'createdAt', direction: 'desc' },
    });
  });

  it('parses any() combinator option', () => {
    const result = parseFilterRule('any()');
    expect(result).toEqual({ option: 'combinator', value: 'any' });
  });

  it('is case-insensitive', () => {
    expect(parseFilterRule('INCLUDE(project::test)')).toEqual({
      operator: 'include',
      markerType: 'project',
      pattern: 'test',
    });
    expect(parseFilterRule('LIMIT(10)')).toEqual({ option: 'limit', value: 10 });
  });

  it('returns null for unrecognized content', () => {
    expect(parseFilterRule('random text')).toBeNull();
    expect(parseFilterRule('project::floatty')).toBeNull(); // Missing include/exclude
  });
});

// ═══════════════════════════════════════════════════════════════
// parseFilterFromChildren
// ═══════════════════════════════════════════════════════════════

describe('parseFilterFromChildren', () => {
  it('parses multiple rules from children', () => {
    const children = [
      makeChild('include(project::floatty)'),
      makeChild('include(type::task)'),
      makeChild('exclude(status::archived)'),
    ];

    const filter = parseFilterFromChildren(children);

    expect(filter.combinator).toBe('all');
    expect(filter.rules).toHaveLength(3);
    expect(filter.rules[0]).toEqual({
      operator: 'include',
      markerType: 'project',
      pattern: 'floatty',
    });
    expect(filter.errors).toHaveLength(0);
  });

  it('parses options from children', () => {
    const children = [
      makeChild('include(project::*)'),
      makeChild('limit(10)'),
      makeChild('sort(updatedAt, asc)'),
      makeChild('any()'),
    ];

    const filter = parseFilterFromChildren(children);

    expect(filter.combinator).toBe('any');
    expect(filter.limit).toBe(10);
    expect(filter.sort).toEqual({ field: 'updatedAt', direction: 'asc' });
    expect(filter.rules).toHaveLength(1);
  });

  it('collects errors for invalid children', () => {
    const children = [
      makeChild('include(project::floatty)'),
      makeChild('this is invalid'),
      makeChild('exclude(status::done)'),
    ];

    const filter = parseFilterFromChildren(children);

    expect(filter.rules).toHaveLength(2);
    expect(filter.errors).toHaveLength(1);
    expect(filter.errors[0].content).toBe('this is invalid');
  });

  it('ignores empty and comment children', () => {
    const children = [
      makeChild(''),
      makeChild('   '),
      makeChild('# This is a comment'),
      makeChild('include(type::task)'),
    ];

    const filter = parseFilterFromChildren(children);

    expect(filter.rules).toHaveLength(1);
    expect(filter.errors).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// matchesPattern
// ═══════════════════════════════════════════════════════════════

describe('matchesPattern', () => {
  it('* matches any value', () => {
    expect(matchesPattern('anything', '*')).toBe(true);
    expect(matchesPattern('', '*')).toBe(true);
    expect(matchesPattern(null, '*')).toBe(true);
  });

  it('null only matches * pattern', () => {
    expect(matchesPattern(null, 'something')).toBe(false);
    expect(matchesPattern(null, 'prefix*')).toBe(false);
  });

  it('prefix* matches values starting with prefix', () => {
    expect(matchesPattern('floatty', 'float*')).toBe(true);
    expect(matchesPattern('floating', 'float*')).toBe(true);
    expect(matchesPattern('unfloat', 'float*')).toBe(false);
  });

  it('*suffix matches values ending with suffix', () => {
    expect(matchesPattern('floatty', '*ty')).toBe(true);
    expect(matchesPattern('pretty', '*ty')).toBe(true);
    expect(matchesPattern('float', '*ty')).toBe(false);
  });

  it('exact pattern requires exact match', () => {
    expect(matchesPattern('floatty', 'floatty')).toBe(true);
    expect(matchesPattern('floatty-extra', 'floatty')).toBe(false);
    expect(matchesPattern('pre-floatty', 'floatty')).toBe(false);
  });
});


// ═══════════════════════════════════════════════════════════════
// blockMatchesFilter
// ═══════════════════════════════════════════════════════════════

describe('blockMatchesFilter', () => {
  const floattyTask = makeBlock('1', [
    { markerType: 'project', value: 'floatty' },
    { markerType: 'type', value: 'task' },
    { markerType: 'status', value: 'active' },
  ]);

  const archivedTask = makeBlock('2', [
    { markerType: 'project', value: 'floatty' },
    { markerType: 'type', value: 'task' },
    { markerType: 'status', value: 'archived' },
  ]);

  const rangleTask = makeBlock('3', [
    { markerType: 'project', value: 'rangle' },
    { markerType: 'type', value: 'task' },
  ]);

  it('passes blocks matching all include rules (AND)', () => {
    const filter: ParsedFilter = {
      combinator: 'all',
      rules: [
        { operator: 'include', markerType: 'project', pattern: 'floatty' },
        { operator: 'include', markerType: 'type', pattern: 'task' },
      ],
      errors: [],
    };

    expect(blockMatchesFilter(floattyTask, filter)).toBe(true);
    expect(blockMatchesFilter(archivedTask, filter)).toBe(true);
    expect(blockMatchesFilter(rangleTask, filter)).toBe(false);
  });

  it('passes blocks matching any include rule (OR)', () => {
    const filter: ParsedFilter = {
      combinator: 'any',
      rules: [
        { operator: 'include', markerType: 'project', pattern: 'floatty' },
        { operator: 'include', markerType: 'project', pattern: 'rangle' },
      ],
      errors: [],
    };

    expect(blockMatchesFilter(floattyTask, filter)).toBe(true);
    expect(blockMatchesFilter(rangleTask, filter)).toBe(true);
  });

  it('excludes take precedence (short-circuit)', () => {
    const filter: ParsedFilter = {
      combinator: 'all',
      rules: [
        { operator: 'include', markerType: 'project', pattern: 'floatty' },
        { operator: 'exclude', markerType: 'status', pattern: 'archived' },
      ],
      errors: [],
    };

    expect(blockMatchesFilter(floattyTask, filter)).toBe(true);
    expect(blockMatchesFilter(archivedTask, filter)).toBe(false);
  });

  it('passes all blocks when no include rules (only excludes)', () => {
    const filter: ParsedFilter = {
      combinator: 'all',
      rules: [{ operator: 'exclude', markerType: 'status', pattern: 'archived' }],
      errors: [],
    };

    expect(blockMatchesFilter(floattyTask, filter)).toBe(true);
    expect(blockMatchesFilter(rangleTask, filter)).toBe(true);
    expect(blockMatchesFilter(archivedTask, filter)).toBe(false);
  });

  it('handles blocks without metadata', () => {
    const noMetadata = makeBlock('4', []);
    noMetadata.metadata = undefined;

    const filter: ParsedFilter = {
      combinator: 'all',
      rules: [{ operator: 'include', markerType: 'project', pattern: '*' }],
      errors: [],
    };

    expect(blockMatchesFilter(noMetadata, filter)).toBe(false);
  });

  it('handles wildcard patterns in rules', () => {
    const filter: ParsedFilter = {
      combinator: 'all',
      rules: [{ operator: 'include', markerType: 'project', pattern: 'float*' }],
      errors: [],
    };

    expect(blockMatchesFilter(floattyTask, filter)).toBe(true);
    expect(blockMatchesFilter(rangleTask, filter)).toBe(false);
  });

  it('returns false when metadata is empty (no fallback to content)', () => {
    // Block with markers in content but no metadata
    // Without metadata extraction hook, block won't match
    const blockWithNoMetadata = makeBlock('no-metadata', []);
    blockWithNoMetadata.content = 'ctx::2026-01-15 - [project::floatty] stuff!';
    blockWithNoMetadata.metadata = undefined;

    const filter: ParsedFilter = {
      combinator: 'all',
      rules: [{ operator: 'include', markerType: 'project', pattern: 'floatty' }],
      errors: [],
    };

    // Should NOT match - metadata extraction is server-side responsibility
    expect(blockMatchesFilter(blockWithNoMetadata, filter)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// executeFilter
// ═══════════════════════════════════════════════════════════════

describe('executeFilter', () => {
  const blocks = [
    makeBlock('1', [
      { markerType: 'project', value: 'floatty' },
      { markerType: 'type', value: 'task' },
    ]),
    makeBlock('2', [
      { markerType: 'project', value: 'floatty' },
      { markerType: 'type', value: 'bug' },
    ]),
    makeBlock('3', [
      { markerType: 'project', value: 'rangle' },
      { markerType: 'type', value: 'task' },
    ]),
  ];

  it('filters blocks by rules', () => {
    const filter: ParsedFilter = {
      combinator: 'all',
      rules: [{ operator: 'include', markerType: 'project', pattern: 'floatty' }],
      errors: [],
    };

    const results = executeFilter(filter, blocks);
    expect(results).toHaveLength(2);
    expect(results.map((b) => b.id)).toEqual(['1', '2']);
  });

  it('respects limit', () => {
    const filter: ParsedFilter = {
      combinator: 'all',
      rules: [{ operator: 'include', markerType: 'project', pattern: '*' }],
      limit: 2,
      errors: [],
    };

    const results = executeFilter(filter, blocks);
    expect(results).toHaveLength(2);
  });

  it('sorts results', () => {
    const blocksWithTime = [
      makeBlock('1', [{ markerType: 'type', value: 'task' }], { updatedAt: 100 }),
      makeBlock('2', [{ markerType: 'type', value: 'task' }], { updatedAt: 300 }),
      makeBlock('3', [{ markerType: 'type', value: 'task' }], { updatedAt: 200 }),
    ];

    const filter: ParsedFilter = {
      combinator: 'all',
      rules: [{ operator: 'include', markerType: 'type', pattern: 'task' }],
      sort: { field: 'updatedAt', direction: 'desc' },
      errors: [],
    };

    const results = executeFilter(filter, blocksWithTime);
    expect(results.map((b) => b.id)).toEqual(['2', '3', '1']);
  });

  it('excludes specified block IDs', () => {
    const filter: ParsedFilter = {
      combinator: 'all',
      rules: [{ operator: 'include', markerType: 'project', pattern: '*' }],
      errors: [],
    };

    const results = executeFilter(filter, blocks, new Set(['1', '3']));
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('2');
  });

  it('excludes filter:: type blocks', () => {
    const blocksWithFilter = [
      ...blocks,
      makeBlock('filter-1', [{ markerType: 'project', value: 'floatty' }], { type: 'filter' }),
    ];

    const filter: ParsedFilter = {
      combinator: 'all',
      rules: [{ operator: 'include', markerType: 'project', pattern: 'floatty' }],
      errors: [],
    };

    const results = executeFilter(filter, blocksWithFilter);
    expect(results.map((b) => b.id)).not.toContain('filter-1');
  });

  it('defaults to limit 50', () => {
    const manyBlocks = Array.from({ length: 100 }, (_, i) =>
      makeBlock(`block-${i}`, [{ markerType: 'type', value: 'test' }])
    );

    const filter: ParsedFilter = {
      combinator: 'all',
      rules: [{ operator: 'include', markerType: 'type', pattern: 'test' }],
      errors: [],
    };

    const results = executeFilter(filter, manyBlocks);
    expect(results).toHaveLength(50);
  });
});
