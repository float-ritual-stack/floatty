// VIEW STATE ONLY — this module manages per-pane collapse state (usePaneStore).
// It NEVER modifies Y.Doc block.collapsed. That's persisted CRDT state.
//
// All expansion triggers route through computeExpansion() which returns actions
// for the caller to apply via paneStore.setCollapsed(). Pure function, no side effects.
//
// See .float/work/collapse-nav/ARCHITECTURE.md for the five systems this unifies.

// ═══════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════

/** Auto-collapse children when expanding a block with >= this many children that have descendants */
export const SMART_EXPAND_THRESHOLD = 10;

/** Max visible nodes before falling back to depth 1. Based on measured data: pages:: has 192 children, outline has ~7,859 blocks */
export const EXPANSION_SIZE_CAP = 500;

/** Max ancestors to expand during navigation (prevents expanding massive subtrees) */
const MAX_ANCESTOR_EXPAND = 10;

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

export interface ExpansionAction {
  blockId: string;
  collapsed: boolean;
}

export interface ExpansionResult {
  actions: ExpansionAction[];
}

export type ExpansionTrigger = 'toggle' | 'zoom' | 'navigate' | 'keybind' | 'startup';

export interface BlockStoreView {
  blocks: Record<string, { childIds: string[] }>;
  rootIds: string[];
}

export interface PaneStoreView {
  isCollapsed: (paneId: string, blockId: string, defaultCollapsed: boolean) => boolean;
}

export interface ExpansionParams {
  targetId: string;
  trigger: ExpansionTrigger;
  /** For 'keybind' trigger: the depth level to expand to */
  depth?: number;
  blockStore: BlockStoreView;
  paneId: string;
  paneStore: PaneStoreView;
  /** For 'navigate': ancestor chain from target to root (target-first order) */
  ancestors?: string[];
}

// ═══════════════════════════════════════════════════════════════
// CORE FUNCTIONS
// ═══════════════════════════════════════════════════════════════

/**
 * Count descendants up to maxDepth. Bails early if count exceeds bailAt.
 *
 * @returns number of descendants, or 'over_cap' if bailAt exceeded.
 * Over cap = caller should fall back to depth 1. No ambiguity.
 */
export function countDescendantsToDepth(
  blockId: string,
  maxDepth: number,
  blockStore: BlockStoreView,
  bailAt: number = EXPANSION_SIZE_CAP
): number | 'over_cap' {
  let count = 0;

  const walk = (id: string, depth: number): boolean => {
    const block = blockStore.blocks[id];
    if (!block) return false;

    for (const childId of block.childIds) {
      count++;
      if (count > bailAt) return true; // bail

      if (depth < maxDepth) {
        const bailed = walk(childId, depth + 1);
        if (bailed) return true;
      }
    }
    return false;
  };

  const bailed = walk(blockId, 1);
  return bailed ? 'over_cap' : count;
}

/**
 * Determine if children should be auto-collapsed when expanding a block.
 * Extracted from usePaneStore.ts toggleCollapsed logic.
 *
 * Returns block IDs of children that should be collapsed (those that have
 * their own children AND the parent has >= threshold children).
 */
export function getAutoCollapseChildren(
  blockId: string,
  blockStore: BlockStoreView,
  threshold: number = SMART_EXPAND_THRESHOLD
): string[] {
  const block = blockStore.blocks[blockId];
  if (!block || block.childIds.length < threshold) return [];

  const result: string[] = [];
  for (const childId of block.childIds) {
    const child = blockStore.blocks[childId];
    if (child && child.childIds.length > 0) {
      // Only auto-collapse if no explicit state exists (don't override user choice)
      // We signal "should collapse" — caller checks existing state before applying
      result.push(childId);
    }
  }
  return result;
}

/**
 * Compute expand/collapse actions for a given trigger.
 *
 * Pure function — returns actions for the caller to apply.
 * Caller applies: result.actions.forEach(a => paneStore.setCollapsed(paneId, a.blockId, a.collapsed))
 */
export function computeExpansion(params: ExpansionParams): ExpansionResult {
  const { targetId, trigger, depth, blockStore, ancestors } = params;

  switch (trigger) {
    case 'toggle':
      return computeToggleExpansion(targetId, blockStore);

    case 'zoom':
      return computeZoomExpansion(targetId, blockStore);

    case 'navigate':
      return computeNavigateExpansion(ancestors);

    case 'keybind':
      return computeKeybindExpansion(targetId, depth ?? 1, blockStore);

    case 'startup':
      // Startup uses applyCollapseDepth in Outliner.tsx — no change needed
      return { actions: [] };
  }
}

// ═══════════════════════════════════════════════════════════════
// TRIGGER-SPECIFIC IMPLEMENTATIONS
// ═══════════════════════════════════════════════════════════════

/**
 * Toggle: expand target, auto-collapse children if parent has many kids.
 * Same behavior as the old toggleCollapsed smart expand, just factored out.
 */
function computeToggleExpansion(
  targetId: string,
  blockStore: BlockStoreView,
): ExpansionResult {
  const actions: ExpansionAction[] = [];

  // Expand the target
  actions.push({ blockId: targetId, collapsed: false });

  // Auto-collapse children with descendants if parent has many kids
  const childrenToCollapse = getAutoCollapseChildren(targetId, blockStore);
  for (const childId of childrenToCollapse) {
    actions.push({ blockId: childId, collapsed: true });
  }

  return { actions };
}

/**
 * Zoom: expand target + ensure visible to depth 2. If subtree is huge, only depth 1.
 * Uses ensureExpandedToDepth semantics (never force-collapse deeper blocks).
 */
function computeZoomExpansion(
  targetId: string,
  blockStore: BlockStoreView,
): ExpansionResult {
  const actions: ExpansionAction[] = [];

  // Always expand the zoom target itself
  actions.push({ blockId: targetId, collapsed: false });

  // Check subtree size to decide depth
  const count = countDescendantsToDepth(targetId, 2, blockStore);
  const expandDepth = count === 'over_cap' ? 1 : 2;

  // Ensure expanded to depth (one-directional: only expand, never collapse)
  const walk = (id: string, currentDepth: number) => {
    const block = blockStore.blocks[id];
    if (!block || block.childIds.length === 0) return;

    // Only expand blocks at/above threshold
    actions.push({ blockId: id, collapsed: false });

    if (currentDepth < expandDepth) {
      for (const childId of block.childIds) {
        walk(childId, currentDepth + 1);
      }
    }
  };

  // Walk children of target (target itself already handled above)
  const target = blockStore.blocks[targetId];
  if (target && expandDepth > 0) {
    for (const childId of target.childIds) {
      if (expandDepth > 1) {
        walk(childId, 2); // depth 2 = grandchildren
      }
      // At depth 1, children are visible (parent expanded) but stay in their current state
    }
  }

  // When over cap at depth 1: auto-collapse all children that have descendants.
  // This ensures zooming into pages:: shows all 192 pages as collapsed items.
  if (count === 'over_cap') {
    if (target) {
      for (const childId of target.childIds) {
        const child = blockStore.blocks[childId];
        if (child && child.childIds.length > 0) {
          actions.push({ blockId: childId, collapsed: true });
        }
      }
    }
  }

  return { actions };
}

/**
 * Navigate: expand ancestor chain of destination (capped at MAX_ANCESTOR_EXPAND).
 * Don't expand siblings of ancestors — just ensure the target is visible.
 */
function computeNavigateExpansion(
  ancestors?: string[],
): ExpansionResult {
  const actions: ExpansionAction[] = [];

  if (!ancestors || ancestors.length === 0) return { actions };

  // Cap ancestor expansion to prevent expanding massive subtrees
  const cappedAncestors = ancestors.slice(0, MAX_ANCESTOR_EXPAND);

  for (const ancestorId of cappedAncestors) {
    actions.push({ blockId: ancestorId, collapsed: false });
  }

  return { actions };
}

/**
 * Keybind (Cmd+E): expand to depth with size cap.
 * If expanding would reveal > EXPANSION_SIZE_CAP nodes, cap at depth 1.
 */
function computeKeybindExpansion(
  targetId: string,
  requestedDepth: number,
  blockStore: BlockStoreView,
): ExpansionResult {
  const actions: ExpansionAction[] = [];

  // Check size before expanding
  const count = countDescendantsToDepth(targetId, requestedDepth, blockStore);
  const effectiveDepth = count === 'over_cap' ? 1 : requestedDepth;

  // Bidirectional: expand shallow, collapse deep (same as expandToDepth)
  const walk = (id: string, currentDepth: number) => {
    const block = blockStore.blocks[id];
    if (!block || block.childIds.length === 0) return;

    const shouldCollapse = currentDepth > effectiveDepth;
    actions.push({ blockId: id, collapsed: shouldCollapse });

    for (const childId of block.childIds) {
      walk(childId, currentDepth + 1);
    }
  };

  // Walk from target (or its roots if target is null-like)
  const roots = [targetId];
  for (const rootId of roots) {
    walk(rootId, 1);
  }

  return { actions };
}
