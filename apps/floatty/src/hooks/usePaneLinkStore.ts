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
import { layoutStore, findTabIdByPaneId } from './useLayoutStore';
import { paneStore } from './usePaneStore';
import { tabStore } from './useTabStore';
import { collectLeaves } from '../lib/layoutTypes';

function createPaneLinkStore() {
  // Block-level links: blockId → targetPaneId
  const [blockLinks, setBlockLinks] = createSignal<Map<string, string>>(new Map());
  // Pane-level links: sourcePaneId → targetPaneId
  const [paneLinks, setPaneLinks] = createSignal<Map<string, string>>(new Map());
  // Sidebar link targets: tabId → paneId (which outliner pane sidebar chirps navigate to)
  const [sidebarLinks, setSidebarLinks] = createSignal<Map<string, string>>(new Map());
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
    // FLO-668 null contract: null → linked pane was deleted OR is no longer
    // tab-hosted (sidebar/floating). Block links target outliner panes in
    // tabs; clean up stale entries and bail.
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
    return getLinkedPaneForBlock(blockId) !== null;
  }

  // ── Pane-level links ──

  function getLinkedPaneForPane(sourcePaneId: string): string | null {
    const targetId = paneLinks().get(sourcePaneId);
    if (!targetId) return null;
    // FLO-668 null contract: null → target pane was deleted OR is no longer
    // tab-hosted. Pane links point at outliner panes in tabs; clean up + bail.
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
    return getLinkedPaneForPane(sourcePaneId) !== null;
  }

  /** Reverse lookup: find which pane links TO this target */
  function getSourcePaneFor(targetPaneId: string): string | null {
    for (const [source, target] of paneLinks()) {
      if (target === targetPaneId) return source;
    }
    return null;
  }

  /** All source panes that link TO this target (supports many→one) */
  function getSourcePanesFor(targetPaneId: string): string[] {
    const sources: string[] = [];
    for (const [source, target] of paneLinks()) {
      if (target === targetPaneId) sources.push(source);
    }
    return sources;
  }

  function clearAllLinks(): void {
    setPaneLinks(new Map());
    setBlockLinks(new Map());
    setSidebarLinks(new Map());
  }

  // ── Sidebar → pane links (per-tab) ──

  function setSidebarLink(tabId: string, paneId: string): void {
    setSidebarLinks(prev => {
      const next = new Map(prev);
      next.set(tabId, paneId);
      return next;
    });
  }

  function clearSidebarLink(tabId: string): void {
    setSidebarLinks(prev => {
      const next = new Map(prev);
      next.delete(tabId);
      return next;
    });
  }

  function hasSidebarLink(tabId: string): boolean {
    const linked = sidebarLinks().get(tabId);
    if (!linked) return false;
    // Validate it still exists in this tab.
    // FLO-668 null contract: null → linked pane gone or moved to a non-tab
    // host; `checkTab !== tabId` is true in both cases, triggering cleanup.
    const checkTab = findTabIdByPaneId(linked);
    if (checkTab !== tabId) {
      clearSidebarLink(tabId);
      return false;
    }
    return true;
  }

  /**
   * Resolve which outliner pane the sidebar should navigate to for a given tab.
   * Priority: explicit sidebar link → first outliner pane in tab.
   */
  function resolveSidebarTarget(tabId: string): string | null {
    // Check explicit link first
    const linked = sidebarLinks().get(tabId);
    if (linked) {
      // Validate it still exists.
      // FLO-668 null contract: null → link is stale (pane gone) OR the pane
      // migrated to a non-tab host. Either way, clean up and fall back to
      // "first outliner pane in the tab" below.
      const checkTab = findTabIdByPaneId(linked);
      if (checkTab === tabId) return linked;
      // Stale — clean up
      clearSidebarLink(tabId);
    }

    const layout = layoutStore.layouts[tabId];
    if (!layout) return null;
    const leaves = collectLeaves(layout.root);

    // FLO-816: prefer the FOCUSED pane over "first outliner". With a split,
    // "first outliner" is always the top pane, so cmd-click inserted there
    // even when the cursor was in the bottom pane. activePaneId tracks focus
    // (set on pane focus in Terminal.tsx); honour it when it's an outliner.
    const activeId = layoutStore.getActivePaneId(tabId);
    if (activeId && leaves.some(l => l.id === activeId && l.leafType === 'outliner')) {
      return activeId;
    }

    // Fallback: first outliner pane in the tab, or any pane if no outliner
    const outliner = leaves.find(l => l.leafType === 'outliner');
    if (outliner) return outliner.id;
    // No outliner pane — use first pane (terminal can still navigate)
    return leaves[0]?.id ?? null;
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
   * Chain: block link → pane link → sidebar fallback → null.
   *
   * The sidebar fallback covers sources hosted in the sidebar shelf (FLO-502
   * pin shelf): they have no `paneLinks` entry of their own; their per-tab
   * routing target lives in `sidebarLinks[activeTab]` (set by Cmd+L via
   * PaneLinkOverlay). Lifted from `resolveSameTabLink` (lib/navigation.ts)
   * so every caller of `resolveLink` — `handleChirpNavigate`,
   * `resolveTargetPane`, the App.tsx deep-link path, Cmd+Shift+L — gets the
   * sidebar route, not just native wikilink clicks.
   */
  function resolveLink(sourcePaneId: string, blockId?: string): string | null {
    if (blockId) {
      const blockTarget = getLinkedPaneForBlock(blockId);
      if (blockTarget) return blockTarget;
    }
    const paneTarget = getLinkedPaneForPane(sourcePaneId);
    if (paneTarget) return paneTarget;

    const host = paneStore.getPaneHost(sourcePaneId);
    if (host?.kind === 'sidebar') {
      const activeTab = tabStore.activeTabId();
      if (activeTab) {
        const sidebarTarget = resolveSidebarTarget(activeTab);
        if (sidebarTarget && sidebarTarget !== sourcePaneId) return sidebarTarget;
      }
    }
    return null;
  }

  /**
   * Get candidate outliner panes for linking (excludes source pane).
   *
   * FLO-671: sidebar-hosted sources (pin shelf panes) have no tab of their
   * own; they fall back to the active tab's layout so the Cmd+L overlay can
   * populate candidates. Tab-hosted sources still resolve to their own tab.
   */
  function getCandidatePanes(sourcePaneId: string): { paneId: string; label: string }[] {
    const tabId = findTabIdByPaneId(sourcePaneId) ?? tabStore.activeTabId();
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
    // FLO-668 null contract: null → source pane isn't tab-hosted; focus
    // overlay enumerates panes in a tab's layout, so empty list.
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
    getSourcePanesFor,
    // Sidebar links
    setSidebarLink,
    clearSidebarLink,
    hasSidebarLink,
    resolveSidebarTarget,
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
