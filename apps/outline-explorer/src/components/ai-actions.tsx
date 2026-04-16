"use client";

import { AI_ACTIONS, buildActionPrompt, type AiAction } from "@/lib/ai-actions";

// Re-export AiAction type and a prompt-bearing variant for consumers
export type { AiAction };

export interface AiActionWithPrompt extends AiAction {
  prompt: string;
}

export function getAiActionWithPrompt(action: AiAction): AiActionWithPrompt {
  return { ...action, prompt: buildActionPrompt(action.skillName, action.taskInstruction) };
}

interface AiActionsProps {
  activeAction: string | null;
  disabled: boolean;
  onAction: (action: AiActionWithPrompt) => void;
}

export function AiActions({ activeAction, disabled, onAction }: AiActionsProps) {
  return (
    <div className="flex gap-1 flex-wrap p-2 border-b border-border/60 shrink-0">
      {AI_ACTIONS.map((a) => {
        const Icon = a.icon;
        const isActive = activeAction === a.id;
        const action = getAiActionWithPrompt(a);
        return (
          <button
            key={a.id}
            disabled={disabled}
            onClick={() => onAction(action)}
            className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] border cursor-pointer transition-colors disabled:opacity-40 disabled:cursor-default"
            style={{
              // Use CSS custom properties so color comes from the single source of truth in globals.css
              color: `var(--color-${a.colorToken})`,
              borderColor: isActive ? `var(--color-${a.colorToken})` : "var(--color-border)",
              background: isActive ? `color-mix(in srgb, var(--color-${a.colorToken}) 10%, transparent)` : "transparent",
            }}
          >
            <Icon size={10} />
            {a.label}
          </button>
        );
      })}
    </div>
  );
}
