/**
 * Pane Link Store — Session-scoped block→pane linking for cross-pane navigation
 *
 * Maps artifact/door blocks to specific outliner panes so chirp navigate
 * intents and door onNavigate calls route to the right target.
 *
 * Session-scoped because pane IDs are ephemeral UUIDs regenerated each launch.
 * Persistent links require stable pane identity (FLO-223 future work).
 */

import { createRoot, createSignal } from 'solid-js';
import { layoutStore } from './useLayoutStore';
import { collectLeaves } from '../lib/layoutTypes';
import { findTabIdByPaneId } from './useBacklinkNavigation';

function createPaneLinkStore() {
  const [links, setLinks] = createSignal<Map<string, string>>(new Map());
  const [linkingBlockId, setLinkingBlockId] = createSignal<string | null>(null);
  const [linkingSourcePaneId, setLinkingSourcePaneId] = createSignal<string | null>(null);

  function getLinkedPane(blockId: string): string | null {
    const paneId = links().get(blockId);
    if (!paneId) return null;
    // Validate pane still exists in layout
    const tabId = findTabIdByPaneId(paneId);
    if (!tabId) {
      // Pane was closed — clean up stale link
      setLinks(prev => {
        const next = new Map(prev);
        next.delete(blockId);
        return next;
      });
      return null;
    }
    return paneId;
  }

  function setLink(blockId: string, paneId: string) {
    setLinks(prev => {
      const next = new Map(prev);
      next.set(blockId, paneId);
      return next;
    });
  }

  function clearLink(blockId: string) {
    setLinks(prev => {
      const next = new Map(prev);
      next.delete(blockId);
      return next;
    });
  }

  function hasLink(blockId: string): boolean {
    return links().has(blockId);
  }

  function startLinking(blockId: string, sourcePaneId: string) {
    setLinkingBlockId(blockId);
    setLinkingSourcePaneId(sourcePaneId);
  }

  function stopLinking() {
    setLinkingBlockId(null);
    setLinkingSourcePaneId(null);
  }

  /**
   * Get candidate outliner panes for linking (excludes source pane).
   */
  function getCandidatePanes(sourcePaneId: string): { paneId: string; label: string }[] {
    const tabId = findTabIdByPaneId(sourcePaneId);
    if (!tabId) return [];
    const layout = layoutStore.layouts[tabId];
    if (!layout) return [];

    const leaves = collectLeaves(layout.root);
    return leaves
      .filter(l => l.leafType === 'outliner' && l.id !== sourcePaneId)
      .map((leaf, i) => ({
        paneId: leaf.id,
        label: String.fromCharCode(97 + i), // a, b, c...
      }));
  }

  return {
    getLinkedPane,
    setLink,
    clearLink,
    hasLink,
    startLinking,
    stopLinking,
    getCandidatePanes,
    get linkingBlockId() { return linkingBlockId; },
    get linkingSourcePaneId() { return linkingSourcePaneId; },
  };
}

export const paneLinkStore = createRoot(createPaneLinkStore);
