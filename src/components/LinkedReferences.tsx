/**
 * LinkedReferences - Displays backlinks to the currently zoomed page
 *
 * Shows all blocks that contain [[wikilinks]] pointing to the current
 * zoomed block. Renders at the bottom of the Outliner when zoomed.
 *
 * Architecture:
 * - Uses a memoized selector to find blocks linking to current view
 * - Clicking a reference navigates to that block's context
 * - Lightweight rendering for potentially many backlinks
 */

import { createMemo, For, Show } from 'solid-js';
import { useWorkspace } from '../context/WorkspaceContext';
import { findBacklinks, getBlockTitle } from '../hooks/useBacklinkNavigation';
import type { Block } from '../lib/blockTypes';

interface LinkedReferencesProps {
  /** The block ID that is currently zoomed (the "page" we're showing references to) */
  targetBlockId: string;
  /** Pane ID for navigation context */
  paneId: string;
  /** Called when a backlink is clicked to navigate to that block */
  onNavigate: (blockId: string) => void;
}

export function LinkedReferences(props: LinkedReferencesProps) {
  const { blockStore } = useWorkspace();

  // Get the title of the target block (what we're finding backlinks for)
  const targetTitle = createMemo(() => {
    const block = blockStore.blocks[props.targetBlockId];
    if (!block) return '';
    return getBlockTitle(block);
  });

  // Find all blocks that link to the target
  const backlinks = createMemo(() => {
    const title = targetTitle();
    if (!title) return [];
    return findBacklinks(blockStore.blocks, title);
  });

  // Handle clicking a backlink - zoom to the block containing the link
  const handleBacklinkClick = (block: Block) => {
    // Navigate to the block that contains the link
    // We want to zoom to show context around this backlink
    props.onNavigate(block.id);
  };

  // Get parent context for display (shows breadcrumb-like context)
  const getBlockContext = (block: Block): string => {
    if (!block.parentId) {
      // Root block - show beginning of content
      const preview = block.content.slice(0, 50);
      return preview + (block.content.length > 50 ? '...' : '');
    }

    // Has parent - show parent's title as context
    const parent = blockStore.blocks[block.parentId];
    if (parent) {
      const parentTitle = getBlockTitle(parent);
      return parentTitle.slice(0, 30) + (parentTitle.length > 30 ? '...' : '');
    }

    return '';
  };

  return (
    <Show when={backlinks().length > 0}>
      <div class="linked-references">
        <div class="linked-references-header">
          <span class="linked-references-count">{backlinks().length}</span>
          <span class="linked-references-title">Linked References</span>
        </div>

        <div class="linked-references-list">
          <For each={backlinks()}>
            {(block) => (
              <div
                class="linked-reference-item"
                onClick={() => handleBacklinkClick(block)}
              >
                <div class="linked-reference-context">
                  {getBlockContext(block)}
                </div>
                <div class="linked-reference-content">
                  {block.content}
                </div>
              </div>
            )}
          </For>
        </div>
      </div>
    </Show>
  );
}
