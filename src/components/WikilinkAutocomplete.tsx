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
  onDismiss: () => void;
}

export function WikilinkAutocomplete(props: WikilinkAutocompleteProps) {
  const top = () => props.state.anchorRect.bottom + 4;
  const left = () => props.state.anchorRect.left;

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
          <div class="wikilink-autocomplete-empty">
            {props.state.query ? 'No matching pages' : 'No pages'}
          </div>
        }
      >
        <ul class="wikilink-autocomplete-list" role="listbox">
          <For each={props.state.suggestions}>
            {(suggestion, i) => (
              <li
                role="option"
                aria-selected={i() === props.state.selectedIndex}
                class="wikilink-autocomplete-item"
                classList={{ 'wikilink-autocomplete-selected': i() === props.state.selectedIndex }}
                onMouseDown={(e) => {
                  // mousedown instead of click to fire before blur
                  e.preventDefault();
                  props.onSelect(suggestion);
                }}
                onMouseEnter={() => {
                  // Preview highlight on hover — no setState needed,
                  // parent will update selectedIndex via checkTrigger re-filter
                }}
              >
                {suggestion}
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );
}
