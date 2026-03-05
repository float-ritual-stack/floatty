import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  scanFuncPrefixes,
  findFuncBlock,
  parseFuncChildren,
  parseFuncArgs,
  funcMetaHandler,
} from './funcRegistry';
import { HandlerRegistry } from './registry';
import type { ExecutorActions } from './types';

// ═══════════════════════════════════════════════════════════════
// UNIT: scanFuncPrefixes
// ═══════════════════════════════════════════════════════════════

describe('scanFuncPrefixes', () => {
  it('extracts prefixes from func:: blocks', () => {
    const blocks = [
      { content: 'func:: issue' },
      { content: 'func:: greet' },
      { content: 'regular block' },
    ];
    const result = scanFuncPrefixes(blocks);
    expect(result).toEqual(new Set(['issue::', 'greet::']));
  });

  it('normalizes to lowercase', () => {
    const blocks = [{ content: 'func:: MyHandler' }];
    const result = scanFuncPrefixes(blocks);
    expect(result).toEqual(new Set(['myhandler::']));
  });

  it('returns empty set for no func:: blocks', () => {
    const blocks = [
      { content: 'sh:: ls' },
      { content: 'eval:: 1 + 1' },
    ];
    expect(scanFuncPrefixes(blocks).size).toBe(0);
  });

  it('handles blocks with no content', () => {
    const blocks = [
      { content: undefined },
      { content: '' },
      { content: 'func:: test' },
    ];
    const result = scanFuncPrefixes(blocks);
    expect(result).toEqual(new Set(['test::']));
  });

  it('ignores extra whitespace after func::', () => {
    const blocks = [{ content: 'func::   spaced' }];
    const result = scanFuncPrefixes(blocks);
    expect(result).toEqual(new Set(['spaced::']));
  });
});

// ═══════════════════════════════════════════════════════════════
// UNIT: findFuncBlock
// ═══════════════════════════════════════════════════════════════

describe('findFuncBlock', () => {
  it('finds block by prefix name', () => {
    const blocks = [
      { id: 'a', content: 'regular' },
      { id: 'b', content: 'func:: issue' },
      { id: 'c', content: 'other' },
    ];
    expect(findFuncBlock('issue::', blocks)).toBe('b');
  });

  it('matches case-insensitively', () => {
    const blocks = [{ id: 'x', content: 'func:: MyThing' }];
    expect(findFuncBlock('mything::', blocks)).toBe('x');
    expect(findFuncBlock('MYTHING::', blocks)).toBe('x');
  });

  it('returns null when not found', () => {
    const blocks = [{ id: 'a', content: 'func:: other' }];
    expect(findFuncBlock('missing::', blocks)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// UNIT: parseFuncArgs
// ═══════════════════════════════════════════════════════════════

describe('parseFuncArgs', () => {
  it('parses comma-separated args', () => {
    expect(parseFuncArgs('issue:: FLO-316, FLO-380', 'issue::')).toEqual(['FLO-316', 'FLO-380']);
  });

  it('trims whitespace', () => {
    expect(parseFuncArgs('greet::  Alice ,  Bob  ', 'greet::')).toEqual(['Alice', 'Bob']);
  });

  it('returns empty for no args', () => {
    expect(parseFuncArgs('test::', 'test::')).toEqual([]);
  });

  it('handles single arg', () => {
    expect(parseFuncArgs('double:: 21', 'double::')).toEqual(['21']);
  });
});

// ═══════════════════════════════════════════════════════════════
// UNIT: parseFuncChildren
// ═══════════════════════════════════════════════════════════════

describe('parseFuncChildren', () => {
  it('reads input:: and body:: children', () => {
    const blocks: Record<string, { id: string; content: string }> = {
      func: { id: 'func', content: 'func:: greet' },
      input: { id: 'input', content: 'input:: names' },
      body: { id: 'body', content: 'body:: names.map(n => "Hello " + n)' },
    };

    const actions: ExecutorActions = {
      createBlockInside: vi.fn(),
      updateBlockContent: vi.fn(),
      getBlock: (id) => blocks[id] ?? null,
      getChildren: (id) => id === 'func' ? ['input', 'body'] : [],
    };

    const def = parseFuncChildren('func', actions);
    expect(def.inputs).toEqual(['names']);
    expect(def.body).toBe('names.map(n => "Hello " + n)');
  });

  it('handles multi-input', () => {
    const blocks: Record<string, { id: string; content: string }> = {
      func: { id: 'func', content: 'func:: add' },
      input: { id: 'input', content: 'input:: a, b' },
      body: { id: 'body', content: 'body:: Number(a) + Number(b)' },
    };

    const actions: ExecutorActions = {
      createBlockInside: vi.fn(),
      updateBlockContent: vi.fn(),
      getBlock: (id) => blocks[id] ?? null,
      getChildren: (id) => id === 'func' ? ['input', 'body'] : [],
    };

    const def = parseFuncChildren('func', actions);
    expect(def.inputs).toEqual(['a', 'b']);
  });

  it('handles no input:: child', () => {
    const blocks: Record<string, { id: string; content: string }> = {
      func: { id: 'func', content: 'func:: now' },
      body: { id: 'body', content: 'body:: Date.now()' },
    };

    const actions: ExecutorActions = {
      createBlockInside: vi.fn(),
      updateBlockContent: vi.fn(),
      getBlock: (id) => blocks[id] ?? null,
      getChildren: (id) => id === 'func' ? ['body'] : [],
    };

    const def = parseFuncChildren('func', actions);
    expect(def.inputs).toEqual([]);
    expect(def.body).toBe('Date.now()');
  });

  it('returns empty body when no body:: child', () => {
    const actions: ExecutorActions = {
      createBlockInside: vi.fn(),
      updateBlockContent: vi.fn(),
      getBlock: () => ({ id: 'x', content: 'input:: a' }),
      getChildren: () => ['x'],
    };

    const def = parseFuncChildren('func', actions);
    expect(def.body).toBe('');
  });
});

// ═══════════════════════════════════════════════════════════════
// INTEGRATION: funcMetaHandler
// ═══════════════════════════════════════════════════════════════

describe('funcMetaHandler', () => {
  function buildTestActions(blocks: Record<string, { id: string; content: string; childIds?: string[]; parentId?: string | null }>): ExecutorActions & { outputs: Map<string, unknown>; statuses: Map<string, string>; createdBlocks: string[] } {
    const outputs = new Map<string, unknown>();
    const statuses = new Map<string, string>();
    const createdBlocks: string[] = [];
    let nextId = 100;

    return {
      createBlockInside: vi.fn((parentId) => {
        const id = `block-${nextId++}`;
        blocks[id] = { id, content: '', parentId, childIds: [] };
        createdBlocks.push(id);
        return id;
      }),
      createBlockAfter: vi.fn((afterId) => {
        const id = `block-${nextId++}`;
        blocks[id] = { id, content: '', parentId: blocks[afterId]?.parentId ?? null, childIds: [] };
        createdBlocks.push(id);
        return id;
      }),
      updateBlockContent: vi.fn((id, content) => {
        if (blocks[id]) blocks[id].content = content;
      }),
      deleteBlock: vi.fn(() => true),
      setBlockOutput: vi.fn((id, output) => outputs.set(id, output)),
      setBlockStatus: vi.fn((id, status) => statuses.set(id, status)),
      getBlock: (id) => blocks[id] ?? null,
      getParentId: (id) => blocks[id]?.parentId ?? undefined,
      getChildren: (id) => blocks[id]?.childIds ?? [],
      rootIds: Object.keys(blocks).filter(id => !blocks[id].parentId),
      outputs,
      statuses,
      createdBlocks,
    };
  }

  it('executes a func-defined handler that returns a value', async () => {
    const blocks: Record<string, { id: string; content: string; childIds?: string[]; parentId?: string | null }> = {
      'func-1': { id: 'func-1', content: 'func:: double', childIds: ['input-1', 'body-1'], parentId: null },
      'input-1': { id: 'input-1', content: 'input:: x', childIds: [], parentId: 'func-1' },
      'body-1': { id: 'body-1', content: 'body:: Number(x[0]) * 2', childIds: [], parentId: 'func-1' },
      'exec-1': { id: 'exec-1', content: 'double:: 21', childIds: [], parentId: null },
    };

    const actions = buildTestActions(blocks);
    await funcMetaHandler.execute('exec-1', 'double:: 21', actions);

    const output = actions.outputs.get('exec-1') as { type: string; data: unknown };
    expect(output.type).toBe('value');
    expect(output.data).toBe(42);
    expect(actions.statuses.get('exec-1')).toBe('complete');
  });

  it('executes a func with $after side effects', async () => {
    const blocks: Record<string, { id: string; content: string; childIds?: string[]; parentId?: string | null }> = {
      'func-1': { id: 'func-1', content: 'func:: greet', childIds: ['input-1', 'body-1'], parentId: null },
      'input-1': { id: 'input-1', content: 'input:: names', childIds: [], parentId: 'func-1' },
      'body-1': { id: 'body-1', content: 'body:: names.map(n => $after("# Hello " + n + "!"))', childIds: [], parentId: 'func-1' },
      'exec-1': { id: 'exec-1', content: 'greet:: Alice, Bob', childIds: [], parentId: null },
    };

    const actions = buildTestActions(blocks);
    await funcMetaHandler.execute('exec-1', 'greet:: Alice, Bob', actions);

    // $after should have been called twice
    expect(actions.createBlockAfter).toHaveBeenCalledTimes(2);
    expect(actions.createdBlocks.length).toBe(2);

    // Check the created blocks have the right content
    expect(blocks[actions.createdBlocks[0]].content).toBe('# Hello Alice!');
    expect(blocks[actions.createdBlocks[1]].content).toBe('# Hello Bob!');

    // Output should be the array of IDs
    const output = actions.outputs.get('exec-1') as { type: string; data: unknown };
    expect(output.type).toBe('json');
  });

  it('errors when func definition not found', async () => {
    const blocks: Record<string, { id: string; content: string; childIds?: string[]; parentId?: string | null }> = {
      'exec-1': { id: 'exec-1', content: 'missing:: something', childIds: [], parentId: null },
    };

    const actions = buildTestActions(blocks);
    await funcMetaHandler.execute('exec-1', 'missing:: something', actions);

    const output = actions.outputs.get('exec-1') as { type: string; data: unknown };
    expect(output.type).toBe('error');
    expect(output.data).toContain('No func:: definition found');
    expect(actions.statuses.get('exec-1')).toBe('error');
  });

  it('errors when func has no body:: child', async () => {
    const blocks: Record<string, { id: string; content: string; childIds?: string[]; parentId?: string | null }> = {
      'func-1': { id: 'func-1', content: 'func:: broken', childIds: ['input-1'], parentId: null },
      'input-1': { id: 'input-1', content: 'input:: x', childIds: [], parentId: 'func-1' },
      'exec-1': { id: 'exec-1', content: 'broken:: test', childIds: [], parentId: null },
    };

    const actions = buildTestActions(blocks);
    await funcMetaHandler.execute('exec-1', 'broken:: test', actions);

    const output = actions.outputs.get('exec-1') as { type: string; data: unknown };
    expect(output.type).toBe('error');
    expect(output.data).toContain('no body::');
  });

  it('runs body with no inputs when no input:: child', async () => {
    const blocks: Record<string, { id: string; content: string; childIds?: string[]; parentId?: string | null }> = {
      'func-1': { id: 'func-1', content: 'func:: now', childIds: ['body-1'], parentId: null },
      'body-1': { id: 'body-1', content: 'body:: 42', childIds: [], parentId: 'func-1' },
      'exec-1': { id: 'exec-1', content: 'now::', childIds: [], parentId: null },
    };

    const actions = buildTestActions(blocks);
    await funcMetaHandler.execute('exec-1', 'now::', actions);

    const output = actions.outputs.get('exec-1') as { type: string; data: unknown };
    expect(output.type).toBe('value');
    expect(output.data).toBe(42);
  });
});

// ═══════════════════════════════════════════════════════════════
// INTEGRATION: Registry + funcPrefixes
// ═══════════════════════════════════════════════════════════════

describe('HandlerRegistry func prefix integration', () => {
  let reg: HandlerRegistry;

  beforeEach(() => {
    reg = new HandlerRegistry();
  });

  it('returns funcMetaHandler for func-defined prefixes', () => {
    reg.updateFuncPrefixes(new Set(['issue::', 'greet::']));
    const handler = reg.findHandler('issue:: FLO-316');
    expect(handler).toBe(funcMetaHandler);
  });

  it('registered handlers win over func-defined prefixes', () => {
    const staticHandler = {
      prefixes: ['issue::'],
      execute: vi.fn(),
    };
    reg.register(staticHandler);
    reg.updateFuncPrefixes(new Set(['issue::']));

    const handler = reg.findHandler('issue:: FLO-316');
    expect(handler).toBe(staticHandler);
  });

  it('isExecutableBlock returns true for func-defined prefixes', () => {
    reg.updateFuncPrefixes(new Set(['custom::']));
    expect(reg.isExecutableBlock('custom:: test')).toBe(true);
  });

  it('clear removes func prefixes', () => {
    reg.updateFuncPrefixes(new Set(['custom::']));
    reg.clear();
    expect(reg.findHandler('custom:: test')).toBeNull();
  });

  it('matches func prefixes case-insensitively', () => {
    reg.updateFuncPrefixes(new Set(['issue::']));
    expect(reg.findHandler('Issue:: FLO-316')).toBe(funcMetaHandler);
    expect(reg.findHandler('ISSUE:: FLO-316')).toBe(funcMetaHandler);
  });
});
