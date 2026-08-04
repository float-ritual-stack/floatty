/**
 * Named layout presets (FLO-83)
 *
 * A preset is a snapshot of the workspace shape (tabs, layout trees, zoom)
 * saved under `layout:<name>` in the SAME keyed `workspace_state` SQLite
 * table the live workspace uses — no new storage, no migration. The table
 * was keyed from day one; only the TS side ever hardcoded 'default'.
 *
 * Applying a preset is ADDITIVE: its tabs are appended next to the current
 * ones rather than replacing them. Two reasons:
 * - Terminals are sacred — replacement would have to kill live PTYs.
 * - FLO-83's own spec offers "opens new tab with layout".
 *
 * Because apply is additive (and repeatable), every id in the blob is
 * remapped to a fresh id on load — applying the same preset twice must not
 * collide tab/pane ids with the live workspace or with itself.
 */

import { batch, createSignal } from 'solid-js';
import { invoke } from './tauriTypes';
import { createLogger } from './logger';
import { tabStore, type Tab } from '../hooks/useTabStore';
import { layoutStore } from '../hooks/useLayoutStore';
import { paneStore } from '../hooks/usePaneStore';
import type { PersistedWorkspace } from '../hooks/useWorkspacePersistence';
import type { LayoutNode } from './layoutTypes';

const logger = createLogger('LayoutPresets');

const PRESET_KEY_PREFIX = 'layout:';
const presetKey = (name: string) => `${PRESET_KEY_PREFIX}${name}`;

// ─────────────────────────────────────────────────────────────
// Preset name list (drives the ⌘K "Layout: …" commands)
// ─────────────────────────────────────────────────────────────

const [presetNames, setPresetNames] = createSignal<string[]>([]);
/** Reactive list of saved preset names — consumed by useCommandBar. */
export const layoutPresetNames = presetNames;

/** Refresh the preset list from SQLite. Fire-and-forget on ⌘K open. */
export async function refreshLayoutPresets(): Promise<void> {
  try {
    const keys = await invoke('list_workspace_states', {});
    setPresetNames(
      keys
        .filter((k) => k.startsWith(PRESET_KEY_PREFIX))
        .map((k) => k.slice(PRESET_KEY_PREFIX.length))
    );
  } catch (err) {
    logger.error('Failed to list layout presets', { err });
  }
}

// ─────────────────────────────────────────────────────────────
// Pure id remapping (unit-tested)
// ─────────────────────────────────────────────────────────────

export type PresetIdKind = 'tab' | 'pane' | 'split';

const defaultGenId = (kind: PresetIdKind): string => `${kind}-${crypto.randomUUID()}`;

/**
 * Remap every tab/pane/split id in a preset blob to fresh ids, consistently
 * (the same old id always maps to the same new id within one call). Block
 * ids inside zoom/focus/history/blockLinks values are OUTLINE addresses,
 * not workspace ids — they pass through untouched.
 */
export function remapPresetIds(
  state: PersistedWorkspace,
  genId: (kind: PresetIdKind) => string = defaultGenId
): PersistedWorkspace {
  const map = new Map<string, string>();
  const remap = (old: string, kind: PresetIdKind): string => {
    const hit = map.get(old);
    if (hit) return hit;
    const fresh = genId(kind);
    map.set(old, fresh);
    return fresh;
  };

  const remapNode = (n: LayoutNode): LayoutNode =>
    n.type === 'leaf'
      ? { ...n, id: remap(n.id, 'pane') }
      : {
          ...n,
          id: remap(n.id, 'split'),
          children: [remapNode(n.children[0]), remapNode(n.children[1])],
        };

  const tabs = state.tabs.map((t) => ({ ...t, id: remap(t.id, 'tab') }));

  const layouts: PersistedWorkspace['layouts'] = {};
  for (const [tabId, l] of Object.entries(state.layouts)) {
    // Walk the tree FIRST so activePaneId reuses the pane's mapping.
    const root = remapNode(l.root);
    layouts[remap(tabId, 'tab')] = { root, activePaneId: remap(l.activePaneId, 'pane') };
  }

  // Records keyed by pane/tab id: rewrite known keys, keep values.
  // A key with no mapping (shouldn't happen in a coherent blob) passes
  // through unchanged rather than being dropped.
  const remapKeys = <V>(rec: Record<string, V> | undefined): Record<string, V> | undefined => {
    if (!rec) return rec;
    return Object.fromEntries(Object.entries(rec).map(([k, v]) => [map.get(k) ?? k, v]));
  };

  return {
    ...state,
    tabs,
    activeTabId: state.activeTabId ? map.get(state.activeTabId) ?? null : null,
    layouts,
    paneStates: remapKeys(state.paneStates) ?? {},
    collapsedState: remapKeys(state.collapsedState),
    focusedBlockId: remapKeys(state.focusedBlockId),
    navigationHistory: remapKeys(state.navigationHistory),
  };
}

// ─────────────────────────────────────────────────────────────
// Save / apply / delete
// ─────────────────────────────────────────────────────────────

/**
 * Snapshot the CURRENT workspace shape as a named preset. Overwrites an
 * existing preset of the same name (seq derived from the stored row so the
 * monotonic guard accepts the write).
 */
export async function saveLayoutPreset(name: string): Promise<boolean> {
  const trimmed = name.trim();
  if (!trimmed) return false;
  try {
    const tabData = tabStore.getTabsForPersistence();
    const layoutData = layoutStore.getLayoutsForPersistence();
    const paneData = paneStore.getPaneStateForPersistence();

    const paneStates: PersistedWorkspace['paneStates'] = {};
    for (const [paneId, zoomedRootId] of Object.entries(paneData.zoomedRootId)) {
      paneStates[paneId] = { zoomedRootId };
    }

    // Same shape as the live-workspace save (useWorkspacePersistence) minus
    // history — a preset is a SHAPE, not a session. collapsedState rides
    // along (cheap, useful); navigationHistory does not.
    const existing = await invoke('get_workspace_state', { key: presetKey(trimmed) });
    const state: PersistedWorkspace = {
      version: 1,
      saveSeq: (existing?.saveSeq ?? 0) + 1,
      tabs: tabData.tabs,
      activeTabId: tabData.activeTabId,
      layouts: layoutData,
      paneStates,
      collapsedState: paneData.collapsed,
    };

    const accepted = await invoke('save_workspace_state', {
      key: presetKey(trimmed),
      stateJson: JSON.stringify(state),
      saveSeq: state.saveSeq!,
    });
    if (accepted) {
      logger.info(`Saved layout preset '${trimmed}'`);
      await refreshLayoutPresets();
    }
    return accepted;
  } catch (err) {
    logger.error(`Failed to save layout preset '${trimmed}'`, { err });
    return false;
  }
}

/**
 * Apply a preset ADDITIVELY: remap all ids, append its tabs beside the
 * current ones, add its layouts, restore per-pane zoom + collapse. Existing
 * tabs and their PTYs are untouched. The workspace save lane picks the change
 * up via the stores' persistenceVersion bumps.
 */
export async function applyLayoutPreset(name: string): Promise<boolean> {
  try {
    const stored = await invoke('get_workspace_state', { key: presetKey(name) });
    if (!stored) {
      logger.warn(`Layout preset '${name}' not found`);
      return false;
    }
    const raw = JSON.parse(stored.stateJson) as PersistedWorkspace;
    if (raw.version !== 1 || !raw.tabs?.length) {
      logger.warn(`Layout preset '${name}' has unusable shape (version=${raw.version})`);
      return false;
    }

    const state = remapPresetIds(raw);
    const tabIds = new Set(state.tabs.map((t) => t.id));

    const appendedTabs: Tab[] = state.tabs.map((t) => ({
      ...t,
      ptyPid: null,
      isAlive: true,
    }));
    const activateId =
      state.activeTabId && tabIds.has(state.activeTabId) ? state.activeTabId : appendedTabs[0].id;

    const zoomedRootIds: Record<string, string | null> = {};
    for (const [paneId, ps] of Object.entries(state.paneStates ?? {})) {
      if (ps.zoomedRootId) zoomedRootIds[paneId] = ps.zoomedRootId;
    }

    // ONE batch: `appendTabs` lands the tabs, and Terminal's "initialize layout
    // for tabs that don't have one" effect would otherwise flush in the gap
    // before `addLayout` and auto-create a default layout (whose pane then gets
    // orphaned). Batching defers that effect until the layouts exist.
    batch(() => {
      tabStore.appendTabs(appendedTabs, activateId);

      for (const [tabId, l] of Object.entries(state.layouts)) {
        // A layout row whose tab isn't in the preset's tabs list is an orphan
        // (possible in hand-edited or partially-saved blobs) — skip it rather
        // than adding an unreachable layout.
        if (!tabIds.has(tabId)) continue;
        layoutStore.addLayout({ tabId, root: l.root, activePaneId: l.activePaneId });
      }

      // Zoom AND collapse — both were snapshotted on save and remapped above.
      paneStore.restorePaneViews(zoomedRootIds, state.collapsedState);
    });

    logger.info(`Applied layout preset '${name}' (${appendedTabs.length} tab(s) appended)`);
    return true;
  } catch (err) {
    logger.error(`Failed to apply layout preset '${name}'`, { err });
    return false;
  }
}

export async function deleteLayoutPreset(name: string): Promise<boolean> {
  try {
    const deleted = await invoke('delete_workspace_state', { key: presetKey(name) });
    if (deleted) logger.info(`Deleted layout preset '${name}'`);
    await refreshLayoutPresets();
    return deleted;
  } catch (err) {
    logger.error(`Failed to delete layout preset '${name}'`, { err });
    return false;
  }
}
