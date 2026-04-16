"use client";

import { AlertTriangle, X } from "lucide-react";
import { usePages, usePageFilter } from "@/hooks/use-pages";
import { useExplorerState } from "@/hooks/use-explorer-state";
import { useResizable } from "@/hooks/use-resizable";
import { Header } from "./header";
import { SidebarTabs } from "./sidebar-tabs";
import { PagesView } from "./pages-view";
import { SearchView } from "./search-view";
import { TimelineView } from "./timeline-view";
import { BlockFocus } from "./block-focus";
import { AiPanel } from "./ai-panel";
import { ViewErrorBoundary } from "./view-error-boundary";

export function Explorer() {
  const {
    pages,
    loading: pagesLoading,
    error: pagesError,
    blockCount,
    ctxCount,
  } = usePages();
  const state = useExplorerState();
  const { width: aiWidth, onMouseDown: onResizeMouseDown } = useResizable({
    initialWidth: 380,
    min: 280,
    max: 800,
    direction: "left",
  });

  const filteredPages = usePageFilter(pages, state.pageFilter);

  if (pagesLoading) {
    return (
      <div className="h-screen bg-bg flex items-center justify-center text-muted text-[13px]">
        connecting to floatty&hellip;
      </div>
    );
  }

  if (pagesError) {
    return (
      <div className="h-screen bg-bg flex items-center justify-center text-coral text-[13px]">
        {pagesError}
      </div>
    );
  }

  return (
    <div className="h-screen bg-bg text-text flex flex-col overflow-hidden">
      <Header
        blockCount={blockCount}
        selectedCount={state.selectedIds.size}
        aiOpen={state.aiOpen}
        onToggleAi={state.openAi}
      />

      <div className="flex flex-1 overflow-hidden">
        <div className="flex-1 flex flex-col overflow-hidden min-w-0">
          <SidebarTabs
            view={state.view}
            onViewChange={state.setView}
            pageCount={pages.length}
            ctxCount={ctxCount}
          />

          {state.pageResolve && (
            <div className="border-b border-border bg-surface px-2.5 py-2">
              <div className="flex items-start gap-2">
                <AlertTriangle
                  size={12}
                  className={
                    state.pageResolve.type === "ambiguous"
                      ? "text-amber mt-0.5 shrink-0"
                      : "text-coral mt-0.5 shrink-0"
                  }
                />
                <div className="min-w-0 flex-1">
                  {state.pageResolve.type === "ambiguous" ? (
                    <>
                      <div className="text-[11px] text-text">
                        Multiple pages match{" "}
                        <span className="text-cyan font-mono">
                          {state.pageResolve.title}
                        </span>
                        .
                      </div>
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {state.pageResolve.candidates.map((candidate) => (
                          <button
                            key={`${candidate.name}:${candidate.blockId ?? "stub"}`}
                            onClick={() =>
                              state.choosePageResolveCandidate(candidate)
                            }
                            className="rounded border border-border bg-bg px-1.5 py-0.5 text-[10px] text-text transition-colors hover:border-cyan hover:text-cyan"
                          >
                            {candidate.name}
                            {!candidate.blockId && (
                              <span className="ml-1 text-dim">(stub)</span>
                            )}
                          </button>
                        ))}
                      </div>
                    </>
                  ) : (
                    <div className="text-[11px] text-coral">
                      {state.pageResolve.message}
                    </div>
                  )}
                </div>
                <button
                  onClick={state.dismissPageResolve}
                  className="bg-transparent border-none text-dim transition-colors hover:text-text"
                >
                  <X size={12} />
                </button>
              </div>
            </div>
          )}

          <ViewErrorBoundary>
            <div className="flex-1 overflow-y-auto">
              {state.focusBlockId ? (
                <BlockFocus
                  blockId={state.focusBlockId}
                  selectedIds={state.selectedIds}
                  onBack={() => state.setFocusBlockId(null)}
                  onAnalyze={state.analyzeAi}
                  onToggleSelect={state.toggleSelect}
                  onNavigate={state.navigateTo}
                  onNavigateToPage={state.navigateToPageByTitle}
                />
              ) : state.view === "pages" ? (
                <div>
                  <div className="p-1.5 border-b border-border">
                    <input
                      value={state.pageFilter}
                      onChange={(e) => state.setPageFilter(e.target.value)}
                      placeholder="filter pages\u2026"
                      className="w-full px-2 py-1 bg-bg border border-border text-text text-[11px] rounded outline-none focus:border-cyan transition-colors"
                    />
                  </div>
                  <PagesView
                    pages={filteredPages}
                    selectedIds={state.selectedIds}
                    onToggleSelect={state.toggleSelect}
                    onAnalyze={state.analyzeAi}
                    onNavigateToPage={state.navigateToPageByTitle}
                  />
                </div>
              ) : state.view === "search" ? (
                <SearchView
                  selectedIds={state.selectedIds}
                  onToggleSelect={state.toggleSelect}
                  onNavigate={state.navigateTo}
                />
              ) : state.view === "timeline" ? (
                <TimelineView
                  selectedIds={state.selectedIds}
                  onToggleSelect={state.toggleSelect}
                  onNavigate={state.navigateTo}
                />
              ) : null}
            </div>
          </ViewErrorBoundary>
        </div>

        {state.aiOpen && (
          <div
            className="shrink-0 border-l border-border flex flex-col relative"
            style={{ width: aiWidth }}
          >
            <div
              className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-cyan/20 active:bg-cyan/30 transition-colors z-10"
              onMouseDown={onResizeMouseDown}
            />
            <AiPanel
              key={state.pageContextId || [...state.selectedIds].join(",")}
              selectedIds={[...state.selectedIds]}
              pageContextId={state.pageContextId}
              onClose={state.closeAi}
              onNavigateToPage={state.navigateToPageByTitle}
            />
          </div>
        )}
      </div>
    </div>
  );
}
