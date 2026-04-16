import { FileText, Sparkles, Compass, Brain, Zap } from "lucide-react";

export interface AiAction {
  id: string;
  icon: typeof FileText;
  label: string;
  colorToken: string;
  skillName: string;
  taskInstruction: string;
}

export function buildActionPrompt(skillName: string, taskInstruction: string): string {
  return `First call load_skill("${skillName}") to get the component reference. ${taskInstruction}`;
}

export const AI_ACTIONS: AiAction[] = [
  {
    id: "summarize",
    icon: FileText,
    label: "Summarize",
    colorToken: "cyan",
    skillName: "spec-summarize",
    taskInstruction:
      "Then summarize this subtree. What is it? What state? What decisions? How does it connect to the rest of the graph?",
  },
  {
    id: "patterns",
    icon: Sparkles,
    label: "Patterns",
    colorToken: "magenta",
    skillName: "spec-patterns",
    taskInstruction:
      "Then find recurring patterns, themes, and implicit connections. Cite specific content. Look at [[wikilinks]] for graph-level patterns.",
  },
  {
    id: "bridge",
    icon: Compass,
    label: "Bridge Walk",
    colorToken: "purple",
    skillName: "spec-bridge-walk",
    taskInstruction:
      "You are a bridge walker. Surface 3-5 unexpected observations. Don't summarize — find the surprising. What's adjacent but not linked? What question is raised but not answered? What would you walk toward next?",
  },
  {
    id: "coldstart",
    icon: Brain,
    label: "Cold-Start",
    colorToken: "green",
    skillName: "spec-cold-start",
    taskInstruction:
      "Then emit a ```spec block using the loaded cold-start components: Heading(1, 'COLD-START BRIEFING'), Chips for project/date metadata, StatusLines for key status categories (URGENT/SHIPPED/DOCTRINE/HELD), BulletList for pending items, BlockRefs for key links. Cover: what this is, current state, key decisions, pending items. Then call suggest_walks.",
  },
  {
    id: "gaps",
    icon: Zap,
    label: "Gaps",
    colorToken: "coral",
    skillName: "spec-gaps",
    taskInstruction:
      "Then audit for gaps: empty stubs, unanswered questions, orphan wikilinks, TODOs without follow-through, asymmetric links, ctx:: entries without corresponding content.",
  },
];
