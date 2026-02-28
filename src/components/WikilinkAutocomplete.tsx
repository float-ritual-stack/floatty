/**
 * WikilinkAutocomplete - Popup for [[ inline autocomplete
 *
 * Renders an absolutely positioned suggestion list at the cursor position.
 * Keyboard navigation handled by parent (BlockItem) — this is display-only.
 *
 * FLO-376
 */

import { For, Show } from 'solid-js';
import type { AutocompleteState } from '../hooks/useWikilinkAutocomplete';

interface WikilinkAutocompleteProps {
  state: AutocompleteState;
  onSelect: (pageName: string) => void;
  onHover: (index: number) => void;
  onDismiss: () => void;
}

const POPUP_MAX_HEIGHT = 200;
const POPUP_MAX_WIDTH = 320;
const POPUP_GAP = 4;

export function WikilinkAutocomplete(props: WikilinkAutocompleteProps) {
  const top = () => {
    const below = props.state.anchorRect.bottom + POPUP_GAP;
    // Flip above cursor if popup would overflow viewport bottom
    if (below + POPUP_MAX_HEIGHT > window.innerHeight) {
      return props.state.anchorRect.top - POPUP_MAX_HEIGHT - POPUP_GAP;
    }
    return below;
  };

  const left = () => {
    const l = props.state.anchorRect.left;
    // Clamp so popup doesn't overflow viewport right edge
    return Math.min(l, window.innerWidth - POPUP_MAX_WIDTH - 8);
  };

  return (
    <div
      class="wikilink-autocomplete"
      style={{
        position: 'fixed',
        top: `${top()}px`,
        left: `${left()}px`,
      }}
    >
      <Show
        when={props.state.suggestions.length > 0}
        fallback={
          <div class="wikilink-autocomplete-empty" aria-live="polite">
            {props.state.query ? 'No matching pages' : 'No pages'}
          </div>
        }
      >
        <ul class="wikilink-autocomplete-list" role="listbox" id="wikilink-listbox">
          <For each={props.state.suggestions}>
            {(suggestion, i) => (
              <li
                id={`wikilink-option-${i()}`}
                role="option"
                aria-selected={i() === props.state.selectedIndex}
                class="wikilink-autocomplete-item"
                classList={{
                  'wikilink-autocomplete-selected': i() === props.state.selectedIndex,
                  'wikilink-autocomplete-create': !suggestion.exists,
                }}
                onMouseDown={(e) => {
                  // mousedown instead of click to fire before blur
                  e.preventDefault();
                  props.onSelect(suggestion.name);
                }}
                onMouseEnter={() => {
                  props.onHover(i());
                }}
              >
                <span class="wikilink-autocomplete-name">{suggestion.name}</span>
                <Show when={!suggestion.exists}>
                  <span class="wikilink-autocomplete-badge">Create</span>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );
}
