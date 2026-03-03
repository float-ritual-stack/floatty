import { describe, it, expect, vi } from 'vitest';
import { evaluate, inferType, type EvalScope } from './evalEngine';

// Minimal no-op scope for tests that only need $ref
function noopScope(overrides?: Partial<EvalScope>): EvalScope {
  return {
    $ref: () => null,
    $block: () => null,
    $siblings: () => [],
    $children: () => [],
    $parent: () => null,
    $after: () => 'new-id',
    $inside: () => 'new-id',
    $update: () => {},
    $delete: () => true,
    ...overrides,
  };
}

describe('inferType', () => {
  it('returns value for primitives', () => {
    expect(inferType(42)).toBe('value');
    expect(inferType('hello')).toBe('value');
    expect(inferType(true)).toBe('value');
  });

  it('returns value for null/undefined', () => {
    expect(inferType(null)).toBe('value');
    expect(inferType(undefined)).toBe('value');
  });

  it('returns json for plain objects', () => {
    expect(inferType({ a: 1 })).toBe('json');
    expect(inferType({})).toBe('json');
  });

  it('returns table for array of objects', () => {
    expect(inferType([{ a: 1 }, { a: 2 }])).toBe('table');
  });

  it('returns json for empty array', () => {
    expect(inferType([])).toBe('json');
  });

  it('returns json for array of primitives', () => {
    expect(inferType([1, 2, 3])).toBe('json');
  });

  it('returns url for https string', () => {
    expect(inferType('https://github.com/org/repo/issues/123')).toBe('url');
  });

  it('returns url for http string', () => {
    expect(inferType('http://localhost:3000')).toBe('url');
  });

  it('returns url for string with leading whitespace', () => {
    expect(inferType('  https://example.com  ')).toBe('url');
  });

  it('returns value for non-URL string', () => {
    expect(inferType('hello world')).toBe('value');
  });

  it('returns value for string containing but not starting with https', () => {
    expect(inferType('go to https://example.com')).toBe('value');
  });

  it('returns value for ftp:// (only http/https)', () => {
    expect(inferType('ftp://files.example.com')).toBe('value');
  });

  it('returns json for array of URL strings (not single url)', () => {
    expect(inferType(['https://a.com', 'https://b.com'])).toBe('json');
  });
});

describe('evaluate', () => {
  it('evaluates arithmetic', () => {
    const result = evaluate('2 + 2', noopScope());
    expect(result).toEqual({ type: 'value', data: 4 });
  });

  it('evaluates string expressions', () => {
    const result = evaluate('"hello" + " world"', noopScope());
    expect(result).toEqual({ type: 'value', data: 'hello world' });
  });

  it('evaluates array expressions', () => {
    const result = evaluate('[1,2,3].map(x => x*x)', noopScope());
    expect(result).toEqual({ type: 'json', data: [1, 4, 9] });
  });

  it('evaluates object expressions', () => {
    const result = evaluate('({a: 1, b: 2})', noopScope());
    expect(result).toEqual({ type: 'json', data: { a: 1, b: 2 } });
  });

  it('evaluates table-shaped data', () => {
    const result = evaluate('[{name: "a", val: 1}, {name: "b", val: 2}]', noopScope());
    expect(result.type).toBe('table');
  });

  it('returns error for syntax errors', () => {
    const result = evaluate('((( bad syntax', noopScope());
    expect(result.type).toBe('error');
    expect(typeof result.data).toBe('string');
  });

  it('returns error for runtime errors', () => {
    const result = evaluate('undefined.foo', noopScope());
    expect(result.type).toBe('error');
  });

  it('resolves $ref', () => {
    const scope = noopScope({
      $ref: (id: string) => id === 'abc' ? 42 : null,
    });
    const result = evaluate('$ref("abc") * 2', scope);
    expect(result).toEqual({ type: 'value', data: 84 });
  });

  it('resolves $ref to null for missing blocks', () => {
    const result = evaluate('$ref("nonexistent")', noopScope());
    expect(result).toEqual({ type: 'value', data: null });
  });

  it('handles null/undefined results', () => {
    const result = evaluate('null', noopScope());
    expect(result).toEqual({ type: 'value', data: null });
  });
});

describe('outline scope', () => {
  it('$block returns full block data', () => {
    const block = { id: 'b1', content: 'hello', childIds: [] };
    const scope = noopScope({ $block: () => block });
    const result = evaluate('$block("b1")', scope);
    expect(result.type).toBe('json');
    expect((result.data as { content: string }).content).toBe('hello');
  });

  it('$siblings returns sibling blocks', () => {
    const sibs = [
      { id: 's1', content: 'input1:: 5' },
      { id: 's2', content: 'input2:: 10' },
    ];
    const scope = noopScope({ $siblings: () => sibs });
    const result = evaluate('$siblings().length', scope);
    expect(result).toEqual({ type: 'value', data: 2 });
  });

  it('$after creates a sibling block', () => {
    const afterFn = vi.fn().mockReturnValue('new-123');
    const scope = noopScope({ $after: afterFn });
    const result = evaluate('$after("sh:: echo hello")', scope);
    expect(result).toEqual({ type: 'value', data: 'new-123' });
    expect(afterFn).toHaveBeenCalledWith('sh:: echo hello');
  });

  it('$inside creates a child block', () => {
    const insideFn = vi.fn().mockReturnValue('child-456');
    const scope = noopScope({ $inside: insideFn });
    const result = evaluate('$inside("new child", "parent-id")', scope);
    expect(result).toEqual({ type: 'value', data: 'child-456' });
    expect(insideFn).toHaveBeenCalledWith('new child', 'parent-id');
  });

  it('$update modifies a block', () => {
    const updateFn = vi.fn();
    const scope = noopScope({ $update: updateFn });
    const result = evaluate('($update("b1", "new content"), "done")', scope);
    expect(result).toEqual({ type: 'value', data: 'done' });
    expect(updateFn).toHaveBeenCalledWith('b1', 'new content');
  });

  it('$delete removes a block', () => {
    const deleteFn = vi.fn().mockReturnValue(true);
    const scope = noopScope({ $delete: deleteFn });
    const result = evaluate('$delete("b1")', scope);
    expect(result).toEqual({ type: 'value', data: true });
    expect(deleteFn).toHaveBeenCalledWith('b1');
  });

  it('$parent returns parent block', () => {
    const parent = { id: 'p1', content: '# Parent' };
    const scope = noopScope({ $parent: () => parent });
    const result = evaluate('$parent().content', scope);
    expect(result).toEqual({ type: 'value', data: '# Parent' });
  });

  it('$children returns child blocks', () => {
    const kids = [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }];
    const scope = noopScope({ $children: () => kids });
    const result = evaluate('$children("p1").length', scope);
    expect(result).toEqual({ type: 'value', data: 3 });
  });

  it('fan-out: map to create multiple blocks', () => {
    const ids: string[] = [];
    let counter = 0;
    const afterFn = vi.fn().mockImplementation((content: string) => {
      const id = `block-${counter++}`;
      ids.push(id);
      return id;
    });
    const scope = noopScope({ $after: afterFn });
    const result = evaluate(
      '[1,2,3].map(n => $after("sh:: echo " + n))',
      scope,
    );
    expect(result.type).toBe('json');
    expect(afterFn).toHaveBeenCalledTimes(3);
    expect(afterFn).toHaveBeenCalledWith('sh:: echo 1');
    expect(afterFn).toHaveBeenCalledWith('sh:: echo 2');
    expect(afterFn).toHaveBeenCalledWith('sh:: echo 3');
  });
});
