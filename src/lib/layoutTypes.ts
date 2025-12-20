/**
 * Layout Types - Binary tree model for split panes
 *
 * Each tab has a layout tree where:
 * - Leaves are terminal panes
 * - Splits divide space horizontally or vertically
 * - Ratio controls the size of the first child (0.1-0.9)
 */

// A single terminal pane
export interface PaneLeaf {
  type: 'leaf';
  id: string;  // Used as terminal ID in terminalManager
  cwd?: string;  // Working directory for the terminal
}

// A split containing two children
export interface PaneSplit {
  type: 'split';
  id: string;
  direction: 'horizontal' | 'vertical';
  ratio: number;  // 0.1-0.9, size of first child
  children: [LayoutNode, LayoutNode];
}

// Union type for tree nodes
export type LayoutNode = PaneLeaf | PaneSplit;

// Per-tab layout with active pane tracking
export interface TabLayout {
  tabId: string;
  root: LayoutNode;
  activePaneId: string;  // Which pane has focus
}

// Direction for focus navigation
export type FocusDirection = 'left' | 'right' | 'up' | 'down';

// --- Tree Utilities ---

/**
 * Generate a unique pane ID
 */
export function generatePaneId(): string {
  return `pane-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Generate a unique split ID
 */
export function generateSplitId(): string {
  return `split-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Create a single-pane layout for a new tab
 */
export function createInitialLayout(tabId: string): TabLayout {
  const paneId = generatePaneId();
  return {
    tabId,
    root: { type: 'leaf', id: paneId },
    activePaneId: paneId,
  };
}

/**
 * Find a node by ID in the tree
 */
export function findNode(root: LayoutNode, id: string): LayoutNode | null {
  if (root.id === id) return root;
  if (root.type === 'split') {
    for (const child of root.children) {
      const found = findNode(child, id);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Find the parent of a node by ID
 */
export function findParent(root: LayoutNode, id: string): PaneSplit | null {
  if (root.type === 'leaf') return null;

  for (const child of root.children) {
    if (child.id === id) return root;
    const found = findParent(child, id);
    if (found) return found;
  }
  return null;
}

/**
 * Find path from root to a node
 */
export function findPath(root: LayoutNode, id: string): LayoutNode[] {
  if (root.id === id) return [root];

  if (root.type === 'split') {
    for (const child of root.children) {
      const path = findPath(child, id);
      if (path.length > 0) {
        return [root, ...path];
      }
    }
  }

  return [];
}

/**
 * Get the first leaf in a subtree (leftmost/topmost)
 */
export function findFirstLeaf(node: LayoutNode): PaneLeaf {
  if (node.type === 'leaf') return node;
  return findFirstLeaf(node.children[0]);
}

/**
 * Get the last leaf in a subtree (rightmost/bottommost)
 */
export function findLastLeaf(node: LayoutNode): PaneLeaf {
  if (node.type === 'leaf') return node;
  return findLastLeaf(node.children[1]);
}

/**
 * Collect all pane IDs in the tree
 */
export function collectPaneIds(node: LayoutNode): string[] {
  if (node.type === 'leaf') return [node.id];
  return [
    ...collectPaneIds(node.children[0]),
    ...collectPaneIds(node.children[1]),
  ];
}

/**
 * Replace a node in the tree (immutable)
 */
export function replaceNode(
  root: LayoutNode,
  id: string,
  replacement: LayoutNode
): LayoutNode {
  if (root.id === id) return replacement;

  if (root.type === 'split') {
    return {
      ...root,
      children: [
        replaceNode(root.children[0], id, replacement),
        replaceNode(root.children[1], id, replacement),
      ] as [LayoutNode, LayoutNode],
    };
  }

  return root;
}

/**
 * Remove a node and return the sibling (for collapse)
 * Returns null if node not found or is root
 */
export function removeNode(root: LayoutNode, id: string): LayoutNode | null {
  // Can't remove root
  if (root.id === id) return null;

  if (root.type === 'split') {
    // Check if target is direct child
    if (root.children[0].id === id) {
      return root.children[1]; // Return sibling
    }
    if (root.children[1].id === id) {
      return root.children[0]; // Return sibling
    }

    // Recurse into children
    const newFirst = removeNode(root.children[0], id);
    if (newFirst !== null && newFirst !== root.children[0]) {
      return {
        ...root,
        children: [newFirst, root.children[1]] as [LayoutNode, LayoutNode],
      };
    }

    const newSecond = removeNode(root.children[1], id);
    if (newSecond !== null && newSecond !== root.children[1]) {
      return {
        ...root,
        children: [root.children[0], newSecond] as [LayoutNode, LayoutNode],
      };
    }
  }

  return root;
}

/**
 * Check if a direction matches a split orientation
 */
export function matchesDirection(
  splitDirection: 'horizontal' | 'vertical',
  focusDirection: FocusDirection
): boolean {
  if (splitDirection === 'horizontal') {
    return focusDirection === 'left' || focusDirection === 'right';
  }
  return focusDirection === 'up' || focusDirection === 'down';
}

/**
 * Get the child index to navigate to based on direction
 * Returns 0 for first child (left/up), 1 for second child (right/down)
 */
export function getTargetChildIndex(direction: FocusDirection): 0 | 1 {
  return direction === 'left' || direction === 'up' ? 0 : 1;
}

/**
 * Find adjacent pane in a direction
 */
export function findAdjacentPane(
  root: LayoutNode,
  paneId: string,
  direction: FocusDirection
): string | null {
  const path = findPath(root, paneId);
  if (path.length === 0) return null;

  // Walk up the path looking for a split we can navigate within
  for (let i = path.length - 2; i >= 0; i--) {
    const node = path[i];
    if (node.type !== 'split') continue;

    // Check if this split's direction matches our navigation direction
    if (!matchesDirection(node.direction, direction)) continue;

    // Find which child we're in
    const currentChild = path[i + 1];
    const currentIndex = node.children[0].id === currentChild.id ? 0 : 1;
    const targetIndex = getTargetChildIndex(direction);

    // If we can move to sibling, do so
    if (currentIndex !== targetIndex) {
      // Navigate to the appropriate edge of the target subtree
      const targetSubtree = node.children[targetIndex];
      if (direction === 'left' || direction === 'up') {
        return findLastLeaf(targetSubtree).id;
      }
      return findFirstLeaf(targetSubtree).id;
    }
  }

  return null; // No adjacent pane in that direction
}

/**
 * Clamp ratio to valid range
 */
export function clampRatio(ratio: number): number {
  return Math.max(0.1, Math.min(0.9, ratio));
}
