"use client";

import { Component, type ReactNode } from "react";
import { useJsonRenderMessage } from "@json-render/react";
import { isToolUIPart, getToolName } from "ai";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";
import { ExplorerRenderer } from "@/lib/catalog/explorer-renderer";
import { StepCard } from "./step-card";
import type { ExplorerUIMessage } from "@/lib/agents/explorer-agent";

const streamdownPlugins = { code };

class SpecErrorBoundary extends Component<
  { children: ReactNode; fallback?: string },
  { error: Error | null }
> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div className="text-coral text-[10px] font-mono p-2 bg-surface rounded">
          <div className="font-bold mb-1">spec render error</div>
          <pre className="text-dim whitespace-pre-wrap">{this.state.error.message}</pre>
          {this.props.fallback && (
            <pre className="text-text mt-2 whitespace-pre-wrap">{this.props.fallback}</pre>
          )}
        </div>
      );
    }
    return this.props.children;
  }
}

interface MessageBubbleProps {
  message: ExplorerUIMessage;
  onNavigateToPage?: (title: string) => void | Promise<unknown>;
  isStreaming?: boolean;
  streamSpec?: boolean;
}

export function MessageBubble({ message, onNavigateToPage, isStreaming, streamSpec }: MessageBubbleProps) {
  // Extract spec and text from message parts
  const { spec, text, hasSpec } = useJsonRenderMessage(
    message.parts as Parameters<typeof useJsonRenderMessage>[0]
  );

  return (
    <div className="mb-4">
      {/* Tool call parts (step cards) */}
      {message.parts.map((part, i: number) => {
        if (isToolUIPart(part)) {
          const toolName = getToolName(part);
          if (toolName === "suggest_walks") return null;
          return (
            <StepCard
              key={part.toolCallId ?? i}
              toolName={toolName}
              state={part.state}
              input={
                part.state === "input-available" ||
                part.state === "output-available"
                  ? (part.input as Record<string, unknown>)
                  : undefined
              }
              output={
                part.state === "output-available" ? part.output : undefined
              }
            />
          );
        }
        return null;
      })}

      {/* Text content (after spec extraction — only the non-spec text remains) */}
      {text && (
        <div className="ai-prose">
          <Streamdown
            plugins={streamdownPlugins}
            isAnimating={isStreaming}
          >
            {text}
          </Streamdown>
        </div>
      )}

      {/* Rendered spec (if the AI emitted one) */}
      {hasSpec && spec && (
        <div
          className="mt-2"
          onClick={(e) => {
            if (!onNavigateToPage) return;
            const el = e.target as HTMLElement;
            const walk = el.closest<HTMLElement>("[data-walk-page]");
            if (walk?.dataset.walkPage) { onNavigateToPage(walk.dataset.walkPage); return; }
            const wikilink = el.closest<HTMLElement>("[data-wikilink-target]");
            if (wikilink?.dataset.wikilinkTarget) { onNavigateToPage(wikilink.dataset.wikilinkTarget); return; }
            const page = el.closest<HTMLElement>("[data-page]");
            if (page?.dataset.page) { onNavigateToPage(page.dataset.page); return; }
          }}
        >
          {isStreaming && !streamSpec ? (
            <div className="text-dim text-[10px] font-mono py-2 animate-pulse">
              rendering structured output&hellip;
            </div>
          ) : (
            <SpecErrorBoundary fallback={text ?? undefined}>
              <ExplorerRenderer spec={spec} />
            </SpecErrorBoundary>
          )}
        </div>
      )}
    </div>
  );
}
