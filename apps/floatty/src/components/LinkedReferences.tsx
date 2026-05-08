/**
 * LinkedReferences - Shows blocks that reference the current page via [[wikilinks]]
 *
 * Displayed when zoomed into a page under the pages:: container.
 * Shows a list of backlinks with clickable references.
 */

import { createMemo, Show, For } from 'solid-js';
import { findBacklinks, findPagesContainer } from '../hooks/useBacklinkNavigation';
import { navigateToPage, resolveSameTabLink } from '../lib/navigation';
import { blockStore } from '../hooks/useBlockStore';
import { paneStore } from '../hooks/usePaneStore';
import { layoutStore, findTabIdByPaneId } from '../hooks/useLayoutStore';
import { isMac } from '../lib/keybinds';
import { BlockDisplay } from './BlockDisplay';
import type { Block } from '../lib/blockTypes';
import { classifyBacklink } from '../lib/backlinkClassify';

const CHILD_PREVIEW_COUNT = 3;
const CHILD_PREVIEW_MAX_CHARS = 80;

interface LinkedReferencesProps {
  /** The block ID we're showing references to (the zoomed page) */
  pageBlockId: string;
  /** Current pane ID for navigation */
  paneId: string;
  /** Callback to focus a block after navigation */
  onFocusBlock?: (blockId: string) => void;
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
  // FLO-211: Pass pageBlockId as origin for focus restoration on back navigation
  const handleWikilinkClick = (target: string, e: MouseEvent) => {
    const modKey = isMac ? e.metaKey : e.ctrlKey;
    const splitDirection: 'none' | 'horizontal' | 'vertical' = modKey
      ? (e.shiftKey ? 'vertical' : 'horizontal')
      : 'none';

    navigateToPage(target, {
      paneId: splitDirection === 'none' ? resolveSameTabLink(props.paneId) : props.paneId,
      splitDirection: splitDirection !== 'none' ? splitDirection : undefined,
      originBlockId: props.pageBlockId,
    });
  };

  // Handle clicking a backlink item to navigate to its parent context
  // Cmd+Click → horizontal split, Cmd+Shift+Click → vertical split
  const handleBacklinkClick = (backlinkBlock: Block, e: MouseEvent | KeyboardEvent) => {
    e.stopPropagation();
    // Navigate to the backlink's parent (or the block itself if no parent)
    // This gives the user the surrounding context of the reference
    const targetId = backlinkBlock.parentId || backlinkBlock.id;
    const modKey = isMac ? e.metaKey : e.ctrlKey;

    if (modKey) {
      const splitDir = e.shiftKey ? 'vertical' : 'horizontal';
      // FLO-668 null contract: null → this LinkedReferences panel is attached
      // to a non-tab-hosted pane (sidebar/floating); fall through to the
      // zoomTo path below, which handles any host kind.
      const tabId = findTabIdByPaneId(props.paneId);
      if (tabId) {
        const newPaneId = layoutStore.splitPane(tabId, splitDir, 'outliner');
        if (newPaneId) {
          // FLO-180: New pane gets empty history, no push needed
          paneStore.setZoomedRoot(newPaneId, targetId);
          return;
        }
      }
    }

    // FLO-211: Use unified zoomTo API for consistent history behavior
    // Pass pageBlockId as origin for focus restoration on back navigation
    paneStore.zoomTo(resolveSameTabLink(props.paneId), targetId, {
      originBlockId: props.pageBlockId,
    });

    // Focus the backlink block so user sees the reference in context
    if (props.onFocusBlock) {
      // Double rAF: first for zoom state update, second for DOM render
      requestAnimationFrame(() => {
        requestAnimationFrame(() => props.onFocusBlock!(backlinkBlock.id));
      });
    }
  };

  // Keyboard handler for backlink items (Enter/Space to activate)
  const handleBacklinkKeyDown = (backlinkBlock: Block, e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleBacklinkClick(backlinkBlock, e);
    }
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
            {(backlinkBlock) => {
              // Classify once per render — backlinks rarely change content
              // mid-session, recomputation is cheap, no memo needed.
              const kind = classifyBacklink(backlinkBlock);
              const childCount = backlinkBlock.childIds.length;
              return (
                <div
                  class="linked-reference-item"
                  classList={{
                    'linked-reference-item--nav': kind === 'nav_node',
                    'linked-reference-item--leaf': kind === 'leaf_marker',
                  }}
                  role="button"
                  tabIndex={0}
                  onClick={(e) => handleBacklinkClick(backlinkBlock, e)}
                  onKeyDown={(e) => handleBacklinkKeyDown(backlinkBlock, e)}
                  aria-label={`Navigate to block: ${backlinkBlock.content.slice(0, 50)}`}
                >
                  <div class="linked-reference-content">
                    <BlockDisplay
                      content={backlinkBlock.content}
                      onWikilinkClick={handleWikilinkClick}
                    />
                    <Show when={kind === 'nav_node'}>
                      <span class="linked-reference-children-chip">
                        +{childCount} {childCount === 1 ? 'child' : 'children'}
                      </span>
                    </Show>
                  </div>
                  <Show when={kind === 'nav_node'}>
                    <ul class="linked-reference-children-preview">
                      <For each={backlinkBlock.childIds.slice(0, CHILD_PREVIEW_COUNT)}>
                        {(childId) => {
                          const child = blockStore.blocks[childId];
                          if (!child) return null;
                          const preview = child.content.slice(0, CHILD_PREVIEW_MAX_CHARS);
                          return <li>{preview}</li>;
                        }}
                      </For>
                      <Show when={childCount > CHILD_PREVIEW_COUNT}>
                        <li class="linked-reference-children-more">
                          +{childCount - CHILD_PREVIEW_COUNT} more
                        </li>
                      </Show>
                    </ul>
                  </Show>
                </div>
              );
            }}
          </For>
        </div>
      </div>
    </Show>
  );
}
