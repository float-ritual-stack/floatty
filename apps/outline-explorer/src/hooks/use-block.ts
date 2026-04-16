"use client";

import { useState, useEffect, useMemo } from "react";
import type { BlockWithContext } from "@/lib/types";

interface BlockState {
  blockId: string | null;
  block: BlockWithContext | null;
  loading: boolean;
  error: string | null;
}

export function useBlock(
  blockId: string | null,
  includes?: string[]
) {
  const [state, setState] = useState<BlockState>({
    blockId: null,
    block: null,
    loading: false,
    error: null,
  });
  const includeParam = useMemo(() => includes?.join(",") ?? "", [includes]);

  useEffect(() => {
    if (!blockId) {
      return;
    }

    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState((prev) => ({
      blockId,
      block: prev.blockId === blockId ? prev.block : null,
      loading: true,
      error: null,
    }));

    const params = includeParam ? `?include=${includeParam}` : "";

    fetch(`/api/blocks/${blockId}${params}`)
      .then((res) => {
        if (!res.ok) throw new Error(`Block fetch failed: ${res.status}`);
        return res.json();
      })
      .then((data) => {
        if (!cancelled) {
          setState({
            blockId,
            block: data,
            loading: false,
            error: null,
          });
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setState({
            blockId,
            block: null,
            loading: false,
            error: e instanceof Error ? e.message : "Failed to load block",
          });
        }
        console.error("Block fetch error:", e);
      });

    return () => {
      cancelled = true;
    };
  }, [blockId, includeParam]);

  if (!blockId) {
    return { block: null, loading: false, error: null };
  }

  return {
    block: state.blockId === blockId ? state.block : null,
    loading: state.blockId === blockId ? state.loading : true,
    error: state.blockId === blockId ? state.error : null,
  };
}
