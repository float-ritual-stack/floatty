/**
 * PaneNameChip — user-assignable pane label (FLO-862)
 *
 * A pane is an anonymous UUID leaf; in a 4-pane drill-down layout nothing
 * says which pane is which, and nothing durable addresses one. The chip
 * shows the leaf's `name` in the pane's top-right chrome (next to the drag
 * handle) and edits it in place on double-click.
 *
 * - Named panes: chip always visible.
 * - Unnamed panes: a dim "name…" ghost, revealed on pane hover (CSS) so the
 *   rename affordance is discoverable without adding chrome noise at rest.
 * - Persistence is free: `name` lives on the PaneLeaf, and the layout tree
 *   serializes verbatim through workspace save/restore.
 *
 * The name also surfaces in the ⌘L/⌘J letter overlays (PaneLinkOverlay
 * prefers it over the derived zoom-content label) — the place anonymity
 * hurts most.
 */

import { Show, createMemo, createSignal } from 'solid-js';
import { layoutStore, findTabIdByPaneId } from '../hooks/useLayoutStore';

interface PaneNameChipProps {
  paneId: string;
}

export function PaneNameChip(props: PaneNameChipProps) {
  const [editing, setEditing] = createSignal(false);

  const name = createMemo(() => {
    // Reading layouts keeps this reactive to setPaneName's tree replacement;
    // the pane→tab mapping itself is stable for a mounted pane.
    const tabId = findTabIdByPaneId(props.paneId);
    if (!tabId) return undefined;
    return layoutStore.getPaneLeaf(tabId, props.paneId)?.name;
  });

  const commit = (value: string) => {
    const tabId = findTabIdByPaneId(props.paneId);
    // setPaneName trims; empty clears back to unnamed
    if (tabId) layoutStore.setPaneName(tabId, props.paneId, value);
    setEditing(false);
  };

  return (
    <Show
      when={editing()}
      fallback={
        <span
          class="pane-name-chip"
          classList={{ 'pane-name-ghost': !name() }}
          role="button"
          tabIndex={0}
          title={name() ? `Pane "${name()}" — double-click to rename` : 'Double-click to name this pane'}
          onDblClick={(e) => {
            e.stopPropagation();
            setEditing(true);
          }}
          onKeyDown={(e) => {
            // Keyboard path to the same editor (double-click is mouse-only)
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              e.stopPropagation();
              setEditing(true);
            }
          }}
        >
          {name() ?? 'name…'}
        </span>
      }
    >
      <input
        class="pane-name-input"
        value={name() ?? ''}
        placeholder="pane name"
        aria-label="Rename pane"
        ref={(el) => requestAnimationFrame(() => { el.focus(); el.select(); })}
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          // Keep typing out of the global keybind layer (tinykeys on window)
          e.stopPropagation();
          if (e.key === 'Enter') commit(e.currentTarget.value);
          else if (e.key === 'Escape') setEditing(false);
        }}
        onBlur={(e) => commit(e.currentTarget.value)}
      />
    </Show>
  );
}
