"use client";

import { useState, useEffect, useRef } from "react";
import type { SearchHit } from "@/lib/types";

export function useSearch(query: string, debounceMs = 300) {
  const [results, setResults] = useState<SearchHit[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (query.length < 2) {
      setResults([]);
      setTotal(0);
      return;
    }

    const timer = setTimeout(async () => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setLoading(true);
      try {
        const res = await fetch(
          `/api/search?q=${encodeURIComponent(query)}&limit=60&include_breadcrumb=true&include_metadata=true`,
          { signal: controller.signal }
        );
        if (!res.ok) throw new Error(`Search failed: ${res.status}`);
        const data = await res.json();
        setResults(data.hits);
        setTotal(data.total);
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return;
        console.error("Search error:", e);
      } finally {
        setLoading(false);
      }
    }, debounceMs);

    return () => clearTimeout(timer);
  }, [query, debounceMs]);

  return { results, total, loading };
}
