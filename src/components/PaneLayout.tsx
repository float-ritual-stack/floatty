/**
 * PaneLayout - Renders layout structure with PLACEHOLDER divs only
 *
 * Architecture (learned from VS Code / Hyper):
 * - This component ONLY renders empty placeholder divs
 * - Actual terminals are rendered in a SEPARATE layer (Terminal.tsx)
 * - Terminals position themselves absolutely over placeholders
 * - When this tree restructures on split, terminals stay mounted
 */

import { useRef, useCallback } from 'react';
import { ResizeHandle } from './ResizeHandle';
import { type LayoutNode, type PaneSplit } from '../lib/layoutTypes';
import { useLayoutStore } from '../hooks/useLayoutStore';

interface PaneLayoutProps {
  tabId: string;
  node: LayoutNode;
  activePaneId: string;
  onPaneClick: (paneId: string) => void;
}

function PaneLayoutNode({
  tabId,
  node,
  activePaneId,
  onPaneClick,
}: PaneLayoutProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const setRatio = useLayoutStore((s) => s.setRatio);

  const handleResize = useCallback((ratio: number) => {
    if (node.type === 'split') {
      setRatio(tabId, node.id, ratio);
    }
  }, [tabId, node, setRatio]);

  // Leaf node - render PLACEHOLDER only (no TerminalPane here!)
  if (node.type === 'leaf') {
    return (
      <div
        className={`pane-layout-leaf pane-placeholder ${node.id === activePaneId ? 'pane-active' : ''}`}
        data-pane-id={node.id}
        onClick={() => onPaneClick(node.id)}
      />
    );
  }

  // Split node - render children with resize handle
  const split = node as PaneSplit;
  const firstBasis = `${split.ratio * 100}%`;
  const secondBasis = `${(1 - split.ratio) * 100}%`;

  return (
    <div
      ref={containerRef}
      className={`pane-layout-split pane-layout-${split.direction}`}
    >
      <div
        className="pane-layout-child"
        style={{ flexBasis: firstBasis, flexGrow: 0, flexShrink: 0 }}
      >
        <PaneLayoutNode
          tabId={tabId}
          node={split.children[0]}
          activePaneId={activePaneId}
          onPaneClick={onPaneClick}
        />
      </div>

      <ResizeHandle
        direction={split.direction}
        onResize={handleResize}
        parentRef={containerRef}
      />

      <div
        className="pane-layout-child"
        style={{ flexBasis: secondBasis, flexGrow: 0, flexShrink: 0 }}
      >
        <PaneLayoutNode
          tabId={tabId}
          node={split.children[1]}
          activePaneId={activePaneId}
          onPaneClick={onPaneClick}
        />
      </div>
    </div>
  );
}

export function PaneLayout({
  tabId,
  node,
  activePaneId,
  onPaneClick,
}: PaneLayoutProps) {
  return (
    <div className="pane-layout-root">
      <PaneLayoutNode
        tabId={tabId}
        node={node}
        activePaneId={activePaneId}
        onPaneClick={onPaneClick}
      />
    </div>
  );
}
