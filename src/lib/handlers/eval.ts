/**
 * Eval Handler (eval::)
 *
 * Client-side JS evaluation with outline read/write access.
 * Stores structured output on the block itself (not child blocks).
 *
 * Scope available to expressions:
 *   $ref(nameOrId)     - read block output/content by UUID or sibling prefix name
 *   $block(id)         - get full block object
 *   $siblings()        - sibling blocks of this eval block
 *   $children(id)      - children of a block
 *   $parent()          - parent block
 *   $after(content)    - create sibling after this block
 *   $inside(content, parentId?) - create child block
 *   $update(id, content) - update block content
 *   $delete(id)        - delete a block
 */

import type { BlockHandler, ExecutorActions } from './types';
import { evaluate } from '../evalEngine';
import { buildEvalScope } from './evalScope';

export const evalHandler: BlockHandler = {
  prefixes: ['eval::'],

  async execute(blockId: string, content: string, actions: ExecutorActions): Promise<void> {
    const expression = content.trim().replace(/^eval::\s*/i, '');
    if (!expression.trim()) {
      if (actions.setBlockOutput) {
        actions.setBlockOutput(blockId, { type: 'error', data: 'Empty expression' }, 'eval-result');
      }
      if (actions.setBlockStatus) {
        actions.setBlockStatus(blockId, 'error');
      }
      return;
    }

    if (actions.setBlockStatus) {
      actions.setBlockStatus(blockId, 'running');
    }

    const scope = buildEvalScope(blockId, actions);
    const result = evaluate(expression, scope);

    if (actions.setBlockOutput) {
      actions.setBlockOutput(blockId, result, 'eval-result');
    }
    if (actions.setBlockStatus) {
      actions.setBlockStatus(blockId, result.type === 'error' ? 'error' : 'complete');
    }
  },
};
