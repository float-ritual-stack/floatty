/**
 * Agent Activity Log — Frontend polling for agent activity display
 *
 * Follows the same pattern as ContextSidebar's ctx:: marker polling:
 * polls Tauri commands on an interval, updates a SolidJS signal.
 *
 * Usage in components:
 *   const { entries, isLoading } = useAgentActivityLog();
 *   <For each={entries()}>{(entry) => <div>...</div>}</For>
 */

import { createSignal, onCleanup } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import type { AgentActivityEntry } from './agentTypes';

const POLL_INTERVAL_MS = 3000; // 3s (slightly offset from ctx:: 2s to avoid lockstep)
const DEFAULT_LIMIT = 50;

/**
 * SolidJS hook that polls agent activity log entries.
 * Returns a signal with recent entries (newest first).
 */
export function useAgentActivityLog() {
  const [entries, setEntries] = createSignal<AgentActivityEntry[]>([]);
  const [isLoading, setIsLoading] = createSignal(false);

  async function fetchEntries() {
    try {
      setIsLoading(true);
      const result = await invoke<AgentActivityEntry[]>('get_agent_log', {
        limit: DEFAULT_LIMIT,
      });
      setEntries(result);
    } catch (error) {
      // Silently degrade — sidebar shows stale data or empty
      console.debug('[agentActivityLog] Poll failed:', error);
    } finally {
      setIsLoading(false);
    }
  }

  // Initial fetch
  void fetchEntries();

  // Poll on interval
  const timerId = setInterval(() => {
    void fetchEntries();
  }, POLL_INTERVAL_MS);

  onCleanup(() => clearInterval(timerId));

  return { entries, isLoading, refresh: fetchEntries };
}
