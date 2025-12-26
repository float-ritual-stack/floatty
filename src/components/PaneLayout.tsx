/**
 * PaneLayout - Renders layout structure with PLACEHOLDER divs only
 *
 * Architecture (learned from VS Code / Hyper):
 * - This component ONLY renders empty placeholder divs
 * - Actual terminals are rendered in a SEPARATE layer (Terminal.tsx)
 * - Terminals position themselves absolutely over placeholders
 * - When this tree restructures on split, terminals stay mounted
 *
 * IMPORTANT: PaneLayoutNode reads directly from layoutStore using tabId
 * to maintain reactivity. Passing node as prop breaks reactivity because
 * the parent's <For each={tabs}> doesn't track layout store changes.
 */

import { Show, createMemo } from 'solid-js';
import { ResizeHandle } from './ResizeHandle';
import { type LayoutNode, type PaneSplit } from '../lib/layoutTypes';
import { layoutStore } from '../hooks/useLayoutStore';

interface PaneLayoutProps {
  tabId: string;
  node: LayoutNode;
  activePaneId: string;
  onPaneClick: (paneId: string) => void;
}

interface PaneLayoutNodeProps {
  tabId: string;
  nodeId: string;  // Node ID - we look up current state from store
  activePaneId: string;
  onPaneClick: (paneId: string) => void;
}

// Helper to find a node by ID in the tree
function findNodeById(root: LayoutNode, id: string): LayoutNode | null {
  if (root.id === id) return root;
  if (root.type === 'split') {
    for (const child of root.children) {
      const found = findNodeById(child, id);
      if (found) return found;
    }
  }
  return null;
}

function PaneLayoutNodeById(props: PaneLayoutNodeProps) {
  let containerRef: HTMLDivElement | undefined;

  // REACTIVE: Look up the current node from the store on every access
  // This creates a fine-grained subscription to the exact node we need
  const node = createMemo(() => {
    const layout = layoutStore.layouts[props.tabId];
    if (!layout) return null;
    return findNodeById(layout.root, props.nodeId);
  });

  const handleResize = (ratio: number) => {
    const n = node();
    if (n && n.type === 'split') {
      layoutStore.setRatio(props.tabId, n.id, ratio);
    }
  };

  return (
    <Show when={node()}>
      {() => {
        const currentNode = node()!;

        if (currentNode.type === 'leaf') {
          return (
            <div
              class={`pane-layout-leaf pane-placeholder ${currentNode.id === props.activePaneId ? 'pane-active' : ''}`}
              data-pane-id={currentNode.id}
              onClick={() => props.onPaneClick(currentNode.id)}
            />
          );
        }

        // It's a split - use reactive getters for basis values
        const split = currentNode as PaneSplit;

        return (
          <div
            ref={containerRef}
            class={`pane-layout-split pane-layout-${split.direction}`}
            data-split-id={split.id}
          >
            <div
              class="pane-layout-child"
              style={{
                "flex-basis": `${split.ratio * 100}%`,
                "flex-grow": 0,
                "flex-shrink": 0
              }}
            >
              <PaneLayoutNodeById
                tabId={props.tabId}
                nodeId={split.children[0].id}
                activePaneId={props.activePaneId}
                onPaneClick={props.onPaneClick}
              />
            </div>

            <ResizeHandle
              direction={split.direction}
              onResize={handleResize}
              parentRef={() => containerRef}
            />

            <div
              class="pane-layout-child"
              style={{
                "flex-basis": `${(1 - split.ratio) * 100}%`,
                "flex-grow": 0,
                "flex-shrink": 0
              }}
            >
              <PaneLayoutNodeById
                tabId={props.tabId}
                nodeId={split.children[1].id}
                activePaneId={props.activePaneId}
                onPaneClick={props.onPaneClick}
              />
            </div>
          </div>
        );
      }}
    </Show>
  );
}

export function PaneLayout(props: PaneLayoutProps) {
  return (
    <div class="pane-layout-root">
      <PaneLayoutNodeById
        tabId={props.tabId}
        nodeId={props.node.id}
        activePaneId={props.activePaneId}
        onPaneClick={props.onPaneClick}
      />
    </div>
  );
}
