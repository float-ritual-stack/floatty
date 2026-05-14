"use client";

import { useCallback, useEffect, useState } from "react";
import type { SessionListItem } from "@/lib/sessions/types";

/**
 * Fetch the list of sessions that referenced a given block. Powers the
 * "N chats about this block" badge in block-row / block-focus.
 *
 * Cached per `blockId` in a module-level Map so repeated mounts (e.g. when
 * scrolling a long list and re-mounting a virtualized row) reuse the prior
 * result instead of re-fetching. The cache is cleared by `invalidate()` —
 * call after a session that touched the block completes, so the badge
 * refreshes for the next render.
 */

interface UseBlockSessionsResult {
  sessions: SessionListItem[];
  loading: boolean;
  error: Error | null;
  refetch: () => void;
}

// Module-level cache: blockId → result. A null entry means "in flight";
// the actual fetch result replaces it. Cleared by invalidateBlockSessions().
const cache = new Map<string, SessionListItem[]>();
const inflight = new Map<string, Promise<SessionListItem[]>>();

export function invalidateBlockSessions(blockId?: string): void {
  if (blockId) {
    cache.delete(blockId);
    inflight.delete(blockId);
  } else {
    cache.clear();
    inflight.clear();
  }
}

async function fetchBlockSessions(blockId: string): Promise<SessionListItem[]> {
  const existing = inflight.get(blockId);
  if (existing) return existing;

  const promise = (async () => {
    const res = await fetch(`/api/sessions/by-block?blockId=${encodeURIComponent(blockId)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { sessions: SessionListItem[] };
    cache.set(blockId, data.sessions);
    return data.sessions;
  })();

  inflight.set(blockId, promise);
  try {
    return await promise;
  } finally {
    inflight.delete(blockId);
  }
}

export function useBlockSessions(
  blockId: string | null,
  opts: { enabled?: boolean } = {}
): UseBlockSessionsResult {
  const enabled = opts.enabled !== false;
  const [sessions, setSessions] = useState<SessionListItem[]>(() =>
    blockId ? cache.get(blockId) ?? [] : []
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const load = useCallback(async () => {
    if (!blockId || !enabled) return;
    const cached = cache.get(blockId);
    if (cached) {
      setSessions(cached);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await fetchBlockSessions(blockId);
      setSessions(result);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, [blockId, enabled]);

  useEffect(() => {
    void load();
  }, [load]);

  const refetch = useCallback(() => {
    if (blockId) {
      cache.delete(blockId);
      inflight.delete(blockId);
    }
    void load();
  }, [blockId, load]);

  return { sessions, loading, error, refetch };
}
