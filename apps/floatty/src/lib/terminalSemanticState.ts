import type { SemanticState } from './terminalManager';

export interface PaneSemanticStateInfo {
  tabId: string;
  paneId: string;
  tmuxSession?: string;
  isActivePane: boolean;
  isActiveTab: boolean;
}

export function syncPaneSemanticState(
  info: PaneSemanticStateInfo,
  state: SemanticState,
  setPaneTmuxSession: (tabId: string, paneId: string, tmuxSession: string | undefined) => void,
  setSemanticState: (state: SemanticState) => void,
): void {
  if (state.tmuxSession !== info.tmuxSession) {
    setPaneTmuxSession(info.tabId, info.paneId, state.tmuxSession);
  }

  if (info.isActivePane && info.isActiveTab) {
    setSemanticState({ ...state });
  }
}
