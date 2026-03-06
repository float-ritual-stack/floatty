/**
 * Pane Link Store — Session-scoped pane→pane + block→pane linking
 *
 * Two link levels:
 * - Pane links (pane→pane): "anything in pane A navigates in pane B"
 * - Block links (block→pane): override for specific blocks (future use)
 *
 * Chaining: if A→B and B→C, navigation from A goes to B, from B to C.
 *
 * Session-scoped because pane IDs are ephemeral UUIDs regenerated each launch.
 */

import { createRoot, createSignal } from 'solid-js';
import { layoutStore } from './useLayoutStore';
import { collectLeaves } from '../lib/layoutTypes';
import { findTabIdByPaneId } from './useBacklinkNavigation';

function createPaneLinkStore() {
  // Block-level links: blockId → targetPaneId
  const [blockLinks, setBlockLinks] = createSignal<Map<string, string>>(new Map());
  // Pane-level links: sourcePaneId → targetPaneId
  const [paneLinks, setPaneLinks] = createSignal<Map<string, string>>(new Map());
  // Overlay state
  const [linkingSourcePaneId, setLinkingSourcePaneId] = createSignal<string | null>(null);
  const [overlayMode, setOverlayMode] = createSignal<'link' | 'focus' | null>(null);

  /** Immutable map update helper */
  function updateBlockLinks(fn: (map: Map<string, string>) => void): void {
    setBlockLinks(prev => {
      const next = new Map(prev);
      fn(next);
      return next;
    });
  }

  function updatePaneLinks(fn: (map: Map<string, string>) => void): void {
    setPaneLinks(prev => {
      const next = new Map(prev);
      fn(next);
      return next;
    });
  }

  // ── Block-level links (kept for future per-block overrides) ──

  function getLinkedPaneForBlock(blockId: string): string | null {
    const paneId = blockLinks().get(blockId);
    if (!paneId) return null;
    const tabId = findTabIdByPaneId(paneId);
    if (!tabId) {
      updateBlockLinks(m => m.delete(blockId));
      return null;
    }
    return paneId;
  }

  function setBlockLink(blockId: string, paneId: string): void {
    updateBlockLinks(m => m.set(blockId, paneId));
  }

  function clearBlockLink(blockId: string): void {
    updateBlockLinks(m => m.delete(blockId));
  }

  function hasBlockLink(blockId: string): boolean {
    return blockLinks().has(blockId);
  }

  // ── Pane-level links ──

  function getLinkedPaneForPane(sourcePaneId: string): string | null {
    const targetId = paneLinks().get(sourcePaneId);
    if (!targetId) return null;
    const tabId = findTabIdByPaneId(targetId);
    if (!tabId) {
      updatePaneLinks(m => m.delete(sourcePaneId));
      return null;
    }
    return targetId;
  }

  function setPaneLink(sourcePaneId: string, targetPaneId: string): void {
    updatePaneLinks(m => m.set(sourcePaneId, targetPaneId));
  }

  function clearPaneLink(sourcePaneId: string): void {
    updatePaneLinks(m => m.delete(sourcePaneId));
  }

  function hasPaneLink(sourcePaneId: string): boolean {
    return paneLinks().has(sourcePaneId);
  }

  /** Reverse lookup: find which pane links TO this target */
  function getSourcePaneFor(targetPaneId: string): string | null {
    for (const [source, target] of paneLinks()) {
      if (target === targetPaneId) return source;
    }
    return null;
  }

  function clearAllLinks(): void {
    setPaneLinks(new Map());
    setBlockLinks(new Map());
  }

  // ── Overlay mode ──

  function startLinking(sourcePaneId: string): void {
    setLinkingSourcePaneId(sourcePaneId);
    setOverlayMode('link');
  }

  function startFocusing(anyPaneId: string): void {
    setLinkingSourcePaneId(anyPaneId);
    setOverlayMode('focus');
  }

  function stopLinking(): void {
    setLinkingSourcePaneId(null);
    setOverlayMode(null);
  }

  /**
   * Resolve target pane for navigation from a given source.
   * Chain: block link → pane link → null (caller falls back)
   */
  function resolveLink(sourcePaneId: string, blockId?: string): string | null {
    if (blockId) {
      const blockTarget = getLinkedPaneForBlock(blockId);
      if (blockTarget) return blockTarget;
    }
    return getLinkedPaneForPane(sourcePaneId);
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

  /**
   * Get ALL panes for focus overlay (includes all leaf types).
   */
  function getAllPanes(anyPaneId: string): { paneId: string; label: string; leafType: string }[] {
    const tabId = findTabIdByPaneId(anyPaneId);
    if (!tabId) return [];
    const layout = layoutStore.layouts[tabId];
    if (!layout) return [];

    const leaves = collectLeaves(layout.root);
    return leaves.map((leaf, i) => ({
      paneId: leaf.id,
      label: String.fromCharCode(97 + i),
      leafType: leaf.leafType ?? 'terminal',
    }));
  }

  return {
    // Block links
    getLinkedPaneForBlock,
    setBlockLink,
    clearBlockLink,
    hasBlockLink,
    // Pane links
    getLinkedPaneForPane,
    setPaneLink,
    clearPaneLink,
    hasPaneLink,
    clearAllLinks,
    getSourcePaneFor,
    // Resolution
    resolveLink,
    // Overlay
    startLinking,
    startFocusing,
    stopLinking,
    getCandidatePanes,
    getAllPanes,
    get overlayMode() { return overlayMode; },
    get linkingSourcePaneId() { return linkingSourcePaneId; },
    // Legacy compat (old API used linkingBlockId — overlay now pane-based)
    get linkingBlockId() { return linkingSourcePaneId; },
  };
}

export const paneLinkStore = createRoot(createPaneLinkStore);
