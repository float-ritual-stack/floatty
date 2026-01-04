/**
 * LinkedReferences - Shows blocks that reference the current page via [[wikilinks]]
 *
 * Displayed when zoomed into a page under the pages:: container.
 * Shows a list of backlinks with clickable references.
 */

import { createMemo, Show, For } from 'solid-js';
import { findBacklinks, findPagesContainer, navigateToPage, findTabIdByPaneId } from '../hooks/useBacklinkNavigation';
import { blockStore } from '../hooks/useBlockStore';
import { paneStore } from '../hooks/usePaneStore';
import { layoutStore } from '../hooks/useLayoutStore';
import { isMac } from '../lib/keybinds';
import { BlockDisplay } from './BlockDisplay';
import type { Block } from '../lib/blockTypes';

interface LinkedReferencesProps {
  /** The block ID we're showing references to (the zoomed page) */
  pageBlockId: string;
  /** Current pane ID for navigation */
  paneId: string;
}

/**
 * Check if a block is a direct child of the pages:: container.
 * Used to determine if we should show LinkedReferences.
 */
export function isPageBlock(blockId: string): boolean {
  const pagesContainer = findPagesContainer();
  if (!pagesContainer) return false;

  return pagesContainer.childIds.includes(blockId);
}

export function LinkedReferences(props: LinkedReferencesProps) {
  const block = createMemo(() => blockStore.blocks[props.pageBlockId]);

  // Get the page name from the block content
  const pageName = createMemo(() => block()?.content?.trim() || '');

  // Find all backlinks to this page
  const backlinks = createMemo(() => {
    const name = pageName();
    if (!name) return [];
    return findBacklinks(name);
  });

  // Handle clicking a wikilink inside a backlink reference
  // Cmd+Click → horizontal split, Cmd+Shift+Click → vertical split
  const handleWikilinkClick = (target: string, e: MouseEvent) => {
    const modKey = isMac ? e.metaKey : e.ctrlKey;
    const splitDirection = modKey
      ? (e.shiftKey ? 'vertical' : 'horizontal')
      : 'none';
    navigateToPage(target, props.paneId, splitDirection);
  };

  // Handle clicking a backlink item to navigate to its parent context
  // Cmd+Click → horizontal split, Cmd+Shift+Click → vertical split
  const handleBacklinkClick = (backlinkBlock: Block, e: MouseEvent) => {
    e.stopPropagation();
    // Navigate to the backlink's parent (or the block itself if no parent)
    // This gives the user the surrounding context of the reference
    const targetId = backlinkBlock.parentId || backlinkBlock.id;
    const modKey = isMac ? e.metaKey : e.ctrlKey;
    const splitDir = modKey ? (e.shiftKey ? 'vertical' : 'horizontal') : null;

    if (splitDir) {
      const tabId = findTabIdByPaneId(props.paneId);
      if (tabId) {
        const newPaneId = layoutStore.splitPane(tabId, splitDir, 'outliner');
        if (newPaneId) {
          paneStore.setZoomedRoot(newPaneId, targetId);
          return;
        }
      }
    }

    paneStore.setZoomedRoot(props.paneId, targetId);
  };

  return (
    <Show when={backlinks().length > 0}>
      <div class="linked-references">
        <div class="linked-references-header">
          <span class="linked-references-count">{backlinks().length}</span>
          <span class="linked-references-label">Linked References</span>
        </div>
        <div class="linked-references-list">
          <For each={backlinks()}>
            {(backlinkBlock) => (
              <div
                class="linked-reference-item"
                onClick={(e) => handleBacklinkClick(backlinkBlock, e)}
              >
                <div class="linked-reference-content">
                  <BlockDisplay
                    content={backlinkBlock.content}
                    onWikilinkClick={handleWikilinkClick}
                  />
                </div>
              </div>
            )}
          </For>
        </div>
      </div>
    </Show>
  );
}
