/**
 * Shared eval scope utilities — used by both eval:: handler and func:: meta-handler.
 *
 * Extracted to prevent duplication of resolveRef/getSiblings/buildEvalScope.
 */

import type { ExecutorActions } from './types';
import type { EvalScope } from '../evalEngine';

interface BlockLike {
  id?: string;
  content?: string;
  childIds?: string[];
  parentId?: string | null;
  output?: { data?: unknown };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve $ref by UUID or sibling prefix name.
 * UUID pattern → direct lookup. Otherwise → scan siblings for "name:: value".
 */
export function resolveRef(
  nameOrId: string,
  blockId: string,
  actions: ExecutorActions,
): unknown {
  if (!actions.getBlock) return null;

  // Direct UUID lookup
  if (UUID_RE.test(nameOrId)) {
    const block = actions.getBlock(nameOrId) as BlockLike | null;
    if (!block) return null;
    return block.output?.data ?? block.content;
  }

  // Name resolution: scan siblings for "name:: value"
  const parent = actions.getParentId?.(blockId);
  const siblingIds = parent ? actions.getChildren?.(parent) : [];
  if (!siblingIds) return null;

  const prefix = nameOrId.toLowerCase().trim();
  for (const sibId of siblingIds) {
    if (sibId === blockId) continue;
    const sib = actions.getBlock(sibId) as BlockLike | null;
    if (!sib?.content) continue;

    const lower = sib.content.toLowerCase().trim();
    // Match "name:: value" or "name::value"
    if (lower.startsWith(prefix + '::')) {
      // Return output.data if the sibling was executed, else parse the value after ::
      if (sib.output?.data !== undefined) return sib.output.data;
      const value = sib.content.slice(sib.content.indexOf('::') + 2).trim();
      try {
        return JSON.parse(value);
      } catch {
        return value; // raw string
      }
    }
  }

  return null;
}

/**
 * Get siblings of a block (other children of the same parent).
 */
export function getSiblings(blockId: string, actions: ExecutorActions): unknown[] {
  if (!actions.getParentId || !actions.getChildren || !actions.getBlock) return [];
  const parentId = actions.getParentId(blockId);
  if (!parentId) return [];
  const siblingIds = actions.getChildren(parentId);
  return siblingIds
    .filter(id => id !== blockId)
    .map(id => actions.getBlock!(id))
    .filter(Boolean);
}

/**
 * Build the full eval scope for a block — $ref, $block, $siblings, $children,
 * $parent, $after, $inside, $update, $delete.
 */
export function buildEvalScope(blockId: string, actions: ExecutorActions): EvalScope {
  return {
    $ref: (nameOrId: string) => resolveRef(nameOrId, blockId, actions),
    $block: (id: string) => actions.getBlock?.(id) ?? null,
    $siblings: () => getSiblings(blockId, actions),
    $children: (id: string) => {
      if (!actions.getChildren || !actions.getBlock) return [];
      return actions.getChildren(id).map(cid => actions.getBlock!(cid)).filter(Boolean);
    },
    $parent: () => {
      const pid = actions.getParentId?.(blockId);
      if (!pid || !actions.getBlock) return null;
      return actions.getBlock(pid);
    },
    $after: (afterContent: string) => {
      if (!actions.createBlockAfter) throw new Error('$after not available');
      const newId = actions.createBlockAfter(blockId);
      actions.updateBlockContent(newId, afterContent);
      return newId;
    },
    $inside: (childContent: string, parentId?: string) => {
      const target = parentId ?? blockId;
      const newId = actions.createBlockInside(target);
      actions.updateBlockContent(newId, childContent);
      return newId;
    },
    $update: (id: string, newContent: string) => {
      actions.updateBlockContent(id, newContent);
    },
    $delete: (id: string) => {
      if (!actions.deleteBlock) throw new Error('$delete not available');
      return actions.deleteBlock(id);
    },
  };
}
