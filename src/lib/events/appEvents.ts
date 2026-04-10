/**
 * App-level event signals for cross-component communication.
 *
 * Separate from the block EventBus (which is block-lifecycle specific).
 * Use these for app-level events like outline switching that don't map
 * to Y.Doc block changes.
 *
 * Per do-not.md: use typed module signals, not window.dispatchEvent.
 */
import { createSignal } from 'solid-js';

/**
 * Signal for pending outline switch requests.
 * Set by outline:: handler, consumed by App.tsx effect.
 * Reset to null after the switch is processed.
 */
export const [pendingOutlineSwitch, setPendingOutlineSwitch] = createSignal<string | null>(null);

// HMR cleanup: reset signal so stale subscribers don't linger on hot-reload
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    setPendingOutlineSwitch(null);
  });
}
