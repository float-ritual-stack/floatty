import { Show } from 'solid-js';
import { Outliner } from './Outliner';

export function ContextSidebar(props: { visible: boolean }) {
  return (
    <Show when={props.visible}>
      <div class="ctx-sidebar" style={{ display: 'flex', "flex-direction": 'column', height: '100%' }}>
        <div class="ctx-sidebar-header" style={{ "flex-shrink": 0 }}>
          Context Stream
        </div>
        <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
          <Outliner paneId="sidebar-context" />
        </div>
      </div>
    </Show>
  );
}
