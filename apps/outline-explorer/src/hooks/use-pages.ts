"use client";

import { useState, useEffect } from "react";
import type { PageListItem, TopologyResponse } from "@/lib/types";

export function usePages() {
  const [pages, setPages] = useState<PageListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [blockCount, setBlockCount] = useState(0);
  const [ctxCount, setCtxCount] = useState(0);

  useEffect(() => {
    fetch("/api/topology")
      .then((res) => {
        if (!res.ok) throw new Error(`Topology fetch failed: ${res.status}`);
        return res.json() as Promise<TopologyResponse>;
      })
      .then(async (topo) => {
        setBlockCount(topo.meta.blocks);
        setCtxCount(topo.daily.reduce((s, d) => s + d.n, 0));

        // Build initial page list from topology
        const items: PageListItem[] = topo.n
          .map((node) => ({
            name: node.id,
            blockId: node.bid ?? null,
            blockCount: node.b,
            isStub: !node.bid,
          }))
          .sort((a, b) => b.blockCount - a.blockCount);

        // If topology didn't provide blockIds, hydrate from pages search API
        const needsHydration = items.some((p) => !p.isStub && !p.blockId);
        if (needsHydration) {
          try {
            const res = await fetch("/api/pages?prefix=&limit=3000");
            if (res.ok) {
              const data = await res.json();
              const pageMap = new Map<string, string>();
              for (const pg of data.pages ?? []) {
                if (pg.blockId) pageMap.set(pg.name.toLowerCase(), pg.blockId);
              }
              for (const item of items) {
                if (!item.blockId) {
                  item.blockId = pageMap.get(item.name.toLowerCase()) ?? null;
                }
              }
            }
          } catch {
            // Hydration is best-effort
          }
        }

        setPages(items);
      })
      .catch((e) => {
        const msg = e instanceof Error ? e.message : "Failed to load pages";
        setError(msg);
        console.error("Topology fetch error:", e);
      })
      .finally(() => setLoading(false));
  }, []);

  return { pages, loading, error, blockCount, ctxCount };
}

export function usePageFilter(pages: PageListItem[], filter: string) {
  if (!filter) return pages;
  const q = filter.toLowerCase();
  return pages.filter((p) => p.name.toLowerCase().includes(q));
}
