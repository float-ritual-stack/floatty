/**
 * PaneLayout - Renders layout structure with PLACEHOLDER divs only
 *
 * Architecture (learned from VS Code / Hyper):
 * - This component ONLY renders empty placeholder divs
 * - Actual terminals are rendered in a SEPARATE layer (Terminal.tsx)
 * - Terminals position themselves absolutely over placeholders
 * - When this tree restructures on split, terminals stay mounted
 */

import { Show } from 'solid-js';
import { ResizeHandle } from './ResizeHandle';
import { type LayoutNode, type PaneSplit } from '../lib/layoutTypes';
import { layoutStore } from '../hooks/useLayoutStore';

interface PaneLayoutProps {
  tabId: string;
  node: LayoutNode;
  activePaneId: string;
  onPaneClick: (paneId: string) => void;
}

function PaneLayoutNode(props: PaneLayoutProps) {
  let containerRef: HTMLDivElement | undefined;

  const handleResize = (ratio: number) => {
    if (props.node.type === 'split') {
      layoutStore.setRatio(props.tabId, props.node.id, ratio);
    }
  };

  return (
    <Show
      when={props.node.type === 'split' ? props.node as PaneSplit : undefined}
      keyed
      fallback={
        // Leaf node - render PLACEHOLDER only (no TerminalPane here!)
        <div
          class={`pane-layout-leaf pane-placeholder ${props.node.id === props.activePaneId ? 'pane-active' : ''}`}
          data-pane-id={props.node.id}
          onClick={() => props.onPaneClick(props.node.id)}
        />
      }
    >
      {/* Split node - render children with resize handle */}
      {(split) => {
        const firstBasis = `${split.ratio * 100}%`;
        const secondBasis = `${(1 - split.ratio) * 100}%`;

        return (
          <div
            ref={containerRef}
            class={`pane-layout-split pane-layout-${split.direction}`}
            data-split-id={split.id}
          >
            <div
              class="pane-layout-child"
              style={{ "flex-basis": firstBasis, "flex-grow": 0, "flex-shrink": 0 }}
            >
              <PaneLayoutNode
                tabId={props.tabId}
                node={split.children[0]}
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
              style={{ "flex-basis": secondBasis, "flex-grow": 0, "flex-shrink": 0 }}
            >
              <PaneLayoutNode
                tabId={props.tabId}
                node={split.children[1]}
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
      <PaneLayoutNode
        tabId={props.tabId}
        node={props.node}
        activePaneId={props.activePaneId}
        onPaneClick={props.onPaneClick}
      />
    </div>
  );
}
