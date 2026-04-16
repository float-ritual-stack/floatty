"use client";

import { useState, useCallback } from "react";
import type { ViewMode } from "@/lib/types";
import type { ResolveRouteResponse } from "@/lib/page-resolver";

type ResolveCandidate = {
  name: string;
  blockId: string | null;
};

export type PageResolveState =
  | null
  | {
      type: "ambiguous";
      title: string;
      candidates: ResolveCandidate[];
    }
  | {
      type: "error";
      title: string;
      message: string;
    };

export type NavigateToPageResult =
  | {
      ok: true;
      blockId: string;
      name: string;
    }
  | {
      ok: false;
      reason: "ambiguous";
      title: string;
      candidates: ResolveCandidate[];
    }
  | {
      ok: false;
      reason: "not_found" | "error" | "stub";
      title: string;
      message: string;
    };

export interface ExplorerState {
  view: ViewMode;
  focusBlockId: string | null;
  selectedIds: Set<string>;
  pageContextId: string | null;
  aiOpen: boolean;
  pageFilter: string;
  pageResolve: PageResolveState;

  setView: (v: ViewMode) => void;
  setFocusBlockId: (id: string | null) => void;
  setPageFilter: (f: string) => void;

  toggleSelect: (id: string) => void;
  navigateTo: (id: string) => void;
  analyzeAi: (id: string) => void;
  navigateToPageByTitle: (title: string) => Promise<NavigateToPageResult>;
  dismissPageResolve: () => void;
  choosePageResolveCandidate: (
    candidate: ResolveCandidate
  ) => NavigateToPageResult;
  closeAi: () => void;
  openAi: () => void;
}

export function useExplorerState(): ExplorerState {
  const [view, setViewRaw] = useState<ViewMode>("pages");
  const [focusBlockId, setFocusBlockId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [pageContextId, setPageContextId] = useState<string | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [pageFilter, setPageFilter] = useState("");
  const [pageResolve, setPageResolve] = useState<PageResolveState>(null);

  const setView = useCallback((v: ViewMode) => {
    setViewRaw(v);
    setFocusBlockId(null);
  }, []);

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setPageContextId(null);
    setAiOpen(true);
  }, []);

  const navigateTo = useCallback((id: string) => {
    setPageResolve(null);
    setFocusBlockId(id);
  }, []);

  const analyzeAi = useCallback((id: string) => {
    setPageResolve(null);
    setPageContextId(id);
    setSelectedIds(new Set());
    setAiOpen(true);
  }, []);

  const dismissPageResolve = useCallback(() => {
    setPageResolve(null);
  }, []);

  const choosePageResolveCandidate = useCallback(
    (candidate: ResolveCandidate): NavigateToPageResult => {
      if (!candidate.blockId) {
        const result: NavigateToPageResult = {
          ok: false,
          reason: "stub",
          title: candidate.name,
          message: `Page "${candidate.name}" is a stub (referenced but not created yet).`,
        };
        setPageResolve({
          type: "error",
          title: candidate.name,
          message: result.message,
        });
        return result;
      }

      setPageResolve(null);
      setFocusBlockId(candidate.blockId);
      analyzeAi(candidate.blockId);

      return {
        ok: true,
        blockId: candidate.blockId,
        name: candidate.name,
      };
    },
    [analyzeAi]
  );

  const navigateToPageByTitle = useCallback(
    async (title: string): Promise<NavigateToPageResult> => {
      try {
        const res = await fetch(
          `/api/pages/resolve?title=${encodeURIComponent(title)}`
        );
        const data = (await res.json().catch(() => null)) as
          | ResolveRouteResponse
          | { error?: string }
          | null;
        const typedData =
          data && typeof data === "object" && "type" in data
            ? (data as ResolveRouteResponse)
            : null;

        if (typedData?.type === "resolved") {
          setPageResolve(null);
          setFocusBlockId(typedData.blockId);
          analyzeAi(typedData.blockId);
          return {
            ok: true,
            blockId: typedData.blockId,
            name: typedData.name,
          };
        }

        if (typedData?.type === "ambiguous") {
          setPageResolve({
            type: "ambiguous",
            title: typedData.title,
            candidates: typedData.candidates,
          });
          return {
            ok: false,
            reason: "ambiguous",
            title: typedData.title,
            candidates: typedData.candidates,
          };
        }

        const message =
          typedData?.type === "not_found"
            ? typedData.error
            : data && "error" in data && typeof data.error === "string"
              ? data.error
              : `Unable to resolve "${title}"`;

        setPageResolve({
          type: "error",
          title,
          message,
        });
        return {
          ok: false,
          reason: res.status === 404 ? "not_found" : "error",
          title,
          message,
        };
      } catch (e) {
        console.error("Page resolve error:", e);
        const message =
          e instanceof Error ? e.message : `Unable to resolve "${title}"`;
        setPageResolve({
          type: "error",
          title,
          message,
        });
        return {
          ok: false,
          reason: "error",
          title,
          message,
        };
      }
    },
    [analyzeAi]
  );

  const closeAi = useCallback(() => {
    setAiOpen(false);
    setPageContextId(null);
  }, []);

  const openAi = useCallback(() => setAiOpen(true), []);

  return {
    view,
    focusBlockId,
    selectedIds,
    pageContextId,
    aiOpen,
    pageFilter,
    pageResolve,
    setView,
    setFocusBlockId,
    setPageFilter,
    toggleSelect,
    navigateTo,
    analyzeAi,
    navigateToPageByTitle,
    dismissPageResolve,
    choosePageResolveCandidate,
    closeAi,
    openAi,
  };
}
