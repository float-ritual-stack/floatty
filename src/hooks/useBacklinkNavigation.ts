import { createEffect, createSignal } from 'solid-js';
import { useWorkspace } from '../context/WorkspaceContext';
import { layoutStore } from './useLayoutStore';
import { tabStore } from './useTabStore';
import { generateHints, useHintListener } from './usePaneHints';

const LINK_PATTERN = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

const normalizeTitle = (value: string): string => {
  return value.trim().replace(/^#+\s+/, '').toLowerCase();
};

const findLinkAtOffset = (content: string, offset: number): string | null => {
  for (const match of content.matchAll(LINK_PATTERN)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (offset >= start && offset <= end) {
      return match[1].trim();
    }
  }
  return null;
};

export function useBacklinkNavigation(paneId: string) {
  const { blockStore, paneStore } = useWorkspace();
  const [pendingTarget, setPendingTarget] = createSignal<string | null>(null);

  const mapsToPage = (target: string, targetPaneId: string) => {
    const normalizedTarget = normalizeTitle(target);
    const existingRootId = blockStore.rootIds.find((rootId) => {
      const root = blockStore.blocks[rootId];
      if (!root) return false;
      return normalizeTitle(root.content) === normalizedTarget;
    });

    const targetRootId = existingRootId
      ?? blockStore.createRootBlock(`# ${target.trim()}`);

    if (targetRootId) {
      paneStore.setZoomedRoot(targetPaneId, targetRootId);
    }
  };

  const startHintMode = (target: string) => {
    const activeTabId = tabStore.activeTabId();
    if (!activeTabId) return;

    const paneIds = layoutStore.getAllPaneIds(activeTabId);
    if (paneIds.length === 0) return;

    layoutStore.setValidPaneHints(generateHints(paneIds));
    layoutStore.setHintModeActive(true);
    setPendingTarget(target);
  };

  useHintListener((selectedPaneId) => {
    const target = pendingTarget();
    if (!target) return;
    mapsToPage(target, selectedPaneId);
    setPendingTarget(null);
  });

  createEffect(() => {
    if (!layoutStore.hintModeActive && pendingTarget()) {
      setPendingTarget(null);
    }
  });

  const handleLinkClick = (target: string, event?: MouseEvent) => {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }

    if (event?.altKey) {
      startHintMode(target);
      return;
    }

    mapsToPage(target, paneId);
  };

  const handleLinkKeyTrigger = (content: string, cursorOffset: number): boolean => {
    const target = findLinkAtOffset(content, cursorOffset);
    if (!target) return false;
    startHintMode(target);
    return true;
  };

  return {
    mapsToPage,
    handleLinkClick,
    handleLinkKeyTrigger,
  };
}
