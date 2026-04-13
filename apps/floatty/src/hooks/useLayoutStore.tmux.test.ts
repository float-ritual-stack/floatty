import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TabLayout } from '../lib/layoutTypes';
import type { SemanticState } from '../lib/terminalManager';
import { syncPaneSemanticState } from '../lib/terminalSemanticState';

const { paneStoreMock } = vi.hoisted(() => ({
  paneStoreMock: {
    removePanes: vi.fn(),
    removePane: vi.fn(),
    clonePaneState: vi.fn(),
  },
}));

vi.mock('./usePaneStore', () => ({
  paneStore: paneStoreMock,
}));

import { layoutStore } from './useLayoutStore';

function makeTerminalLayout(tabId: string, paneId: string, tmuxSession?: string): Record<string, TabLayout> {
  return {
    [tabId]: {
      tabId,
      activePaneId: paneId,
      root: {
        type: 'leaf',
        id: paneId,
        leafType: 'terminal',
        cwd: '/tmp/project',
        ...(tmuxSession ? { tmuxSession } : {}),
      },
    },
  };
}

function makeSemanticState(tmuxSession: string | undefined): SemanticState {
  return {
    cwd: '/tmp/project',
    lastCommand: 'tmux attach-session -t work',
    lastExitCode: 0,
    lastDuration: 25,
    commandStartTime: null,
    hooksActive: true,
    tmuxSession,
  };
}

describe('layoutStore tmux ownership', () => {
  beforeEach(() => {
    layoutStore.hydrateLayouts({});
    vi.clearAllMocks();
  });

  it('propagates tmux session clears when the user exits tmux before closing the app', () => {
    const tabId = 'tab-1';
    const paneId = 'pane-1';
    const setPaneTmuxSession = vi.fn();
    const setSemanticState = vi.fn();
    syncPaneSemanticState(
      {
        tabId,
        paneId,
        tmuxSession: 'work',
        isActivePane: true,
        isActiveTab: true,
      },
      makeSemanticState(undefined),
      setPaneTmuxSession,
      setSemanticState,
    );

    expect(setPaneTmuxSession).toHaveBeenCalledWith(tabId, paneId, undefined);
    expect(setSemanticState).toHaveBeenCalledWith(expect.objectContaining({ tmuxSession: undefined }));
  });

  it('removes the persisted tmux attachment contract when the pane is cleared', () => {
    const tabId = 'tab-1';
    const paneId = 'pane-1';
    layoutStore.hydrateLayouts(makeTerminalLayout(tabId, paneId, 'work'));

    layoutStore.setPaneTmuxSession(tabId, paneId, undefined);

    expect(layoutStore.getPaneLeaf(tabId, paneId)?.tmuxSession).toBeUndefined();
    const persistedRoot = layoutStore.getLayoutsForPersistence()[tabId]?.root as Record<string, unknown>;
    expect('tmuxSession' in persistedRoot).toBe(false);
  });

  it('does not copy tmux session ownership to a newly split pane', () => {
    const tabId = 'tab-1';
    const paneId = 'pane-1';
    layoutStore.hydrateLayouts(makeTerminalLayout(tabId, paneId, 'work'));

    const newPaneId = layoutStore.splitPane(tabId, 'vertical');

    expect(newPaneId).toBeTruthy();
    expect(layoutStore.getPaneLeaf(tabId, paneId)?.tmuxSession).toBe('work');
    expect(layoutStore.getPaneLeaf(tabId, newPaneId!)?.tmuxSession).toBeUndefined();
  });

  it('clears the persisted contract through the full propagation chain when reattach fails on reopen', () => {
    // Exercises the complete missing-session lifecycle end-to-end:
    // pane had tmuxSession='work' persisted → app reopens → tmux session gone →
    // spawnPty emits empty TmuxSession OSC (|| printf '\033]1337;TmuxSession=\007') →
    // OSC handler sets semanticState.tmuxSession = undefined →
    // syncPaneSemanticState detects delta ('work' !== undefined) →
    // calls setPaneTmuxSession callback → layout store removes the field →
    // next reopen finds no contract, spawns plain shell instead of retrying
    const tabId = 'tab-1';
    const paneId = 'pane-1';
    const setSemanticState = vi.fn();
    layoutStore.hydrateLayouts(makeTerminalLayout(tabId, paneId, 'work'));

    // Simulate the OSC clear arriving via the Terminal.tsx wiring
    syncPaneSemanticState(
      { tabId, paneId, tmuxSession: 'work', isActivePane: true, isActiveTab: true },
      makeSemanticState(undefined),
      (t, p, s) => layoutStore.setPaneTmuxSession(t, p, s),
      setSemanticState,
    );

    expect(layoutStore.getPaneLeaf(tabId, paneId)?.tmuxSession).toBeUndefined();
    const persistedRoot = layoutStore.getLayoutsForPersistence()[tabId]?.root as Record<string, unknown>;
    expect('tmuxSession' in persistedRoot).toBe(false);
  });

  it('does not call setPaneTmuxSession when session was already absent (delta guard)', () => {
    // syncPaneSemanticState only propagates when state.tmuxSession !== info.tmuxSession.
    // If the pane already has no contract and state has none, no write should occur.
    const tabId = 'tab-1';
    const paneId = 'pane-1';
    const setPaneTmuxSession = vi.fn();
    const setSemanticState = vi.fn();

    syncPaneSemanticState(
      { tabId, paneId, tmuxSession: undefined, isActivePane: true, isActiveTab: true },
      makeSemanticState(undefined),
      setPaneTmuxSession,
      setSemanticState,
    );

    expect(setPaneTmuxSession).not.toHaveBeenCalled();
    // setSemanticState still fires for the active pane — the delta guard only
    // suppresses the layout-store write, not the semantic state update.
    expect(setSemanticState).toHaveBeenCalledTimes(1);
  });
});
