/**
 * Eval Engine — Pure execution + type inference
 *
 * Spike: eval:: blocks execute JS expressions with outline access.
 * Uses `new Function` (unsandboxed — spike only, single-user app).
 */

export interface EvalResult {
  type: 'value' | 'json' | 'table' | 'error';
  data: unknown;
}

/**
 * Outline API exposed to eval:: expressions.
 * Built from ExecutorActions in the handler — engine stays pure.
 */
export interface EvalScope {
  /** Read block output or content by ID or sibling prefix name */
  $ref: (nameOrId: string) => unknown;
  /** Get full block object by ID */
  $block: (id: string) => unknown;
  /** Get sibling blocks (same parent as the eval block) */
  $siblings: () => unknown[];
  /** Get children of a block */
  $children: (id: string) => unknown[];
  /** Get parent block */
  $parent: () => unknown;
  /** Create a sibling block after this one, returns new block ID */
  $after: (content: string) => string;
  /** Create a child block inside a parent, returns new block ID */
  $inside: (content: string, parentId?: string) => string;
  /** Update a block's content */
  $update: (id: string, content: string) => void;
  /** Delete a block */
  $delete: (id: string) => boolean;
}

const SCOPE_PARAM_NAMES = [
  '$ref', '$block', '$siblings', '$children', '$parent',
  '$after', '$inside', '$update', '$delete',
];

/**
 * Evaluate a JS expression with outline scope available.
 * Returns typed result for viewer dispatch.
 */
export function evaluate(
  expression: string,
  scope: EvalScope
): EvalResult {
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function(...SCOPE_PARAM_NAMES, `return (${expression})`);
    const result = fn(
      scope.$ref, scope.$block, scope.$siblings, scope.$children, scope.$parent,
      scope.$after, scope.$inside, scope.$update, scope.$delete,
    );
    return { type: inferType(result), data: result };
  } catch (e) {
    return {
      type: 'error',
      data: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Infer viewer type from result value.
 */
export function inferType(val: unknown): EvalResult['type'] {
  if (val === null || val === undefined) return 'value';
  if (Array.isArray(val)) {
    if (val.length > 0 && val[0] !== null && typeof val[0] === 'object') return 'table';
    return 'json'; // arrays of primitives or empty → JSON viewer (pretty-prints nicely)
  }
  if (typeof val === 'object') return 'json';
  return 'value';
}
