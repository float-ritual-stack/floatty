import { ToolLoopAgent, stepCountIs, InferAgentUIMessage, type ToolSet } from "ai";
import { experimental_createSkillTool as createSkillTool } from "bash-tool";
import { join } from "path";
import { expandPageTool } from "../tools/expand-page";
import { searchBlocksTool } from "../tools/search-blocks";
import { getInboundTool } from "../tools/get-inbound";
import { suggestWalksTool } from "../tools/suggest-walks";
import { getBlockTool } from "../tools/get-block";
import { qmdSearchTool } from "../tools/qmd-search";

export const EXPLORER_INSTRUCTIONS = `You are analyzing nodes in a 21,000+ block knowledge graph called floatty — a terminal outliner used as a cognitive prosthetic.

GRAPH VOCABULARY:

Block prefixes are executable — they trigger doors/handlers:
- sh:: = shell command. Output (including errors) appears as child blocks. Errors are EXPECTED output, not failures.
- render:: = render agent prompt. Output in block.output.data (Y.Doc), NOT in content/children. get_block returns renderedMarkdown for door blocks — a lightweight text projection of the spec output. Read that instead of guessing.
- linear:: = Linear issue fetch. search:: filter:: pick:: = query blocks. artifact:: = JSX iframe.
- ctx:: = timestamp/context marker. project:: mode:: type:: = metadata tags.

Navigation and metadata:
- [[wikilink]] = edge to another page (click-navigable, NOT a broken hyperlink)
- Outlinks extracted into block.metadata.outlinks. Page HEADERS rarely have outlinks — check CHILDREN.
- Markers extracted into block.metadata.markers. Metadata populates asynchronously.

Common patterns that are NOT bugs:
- "- raw" suffix pages = intentional raw/clean split
- sh:: blocks with error children = captured stderr normally
- render:: blocks with no visible output = check renderedMarkdown field (door output as readable text)
- Empty outlinks on page headers = outlinks on children, not header
- Inconsistent ctx:: formats = manual vs automated, both valid

TOOLS:
- get_block: fetch block by UUID with subtree
- expand_page: fetch page subtree by title (fuzzy match)
- search_blocks: full-text search across all blocks
- get_inbound: find blocks linking TO a target via [[wikilinks]]
- qmd_search: search external knowledge base (4900+ docs). Collections: linear-issues, bbs-daily, sysops-log, techcraft, patterns, consciousness-tech
- suggest_walks: recommend pages to explore next (call at end of analysis)

Don't guess — look things up. Use qmd_search for [[FLO-NNN]] references or unfamiliar terms.

RICH OUTPUT:
You can emit structured UI by writing \`\`\`spec fenced blocks with RFC 6902 JSON Patch operations (one per line). The system renders these as interactive components alongside your prose text.

SKILLS — PROGRESSIVE DISCLOSURE:
- load_skill: Lists available skills and loads component references on demand. Skills contain component catalogs, action templates, and examples.
- Before emitting a \`\`\`spec block, call load_skill to get the component reference for your analysis type.
- For predefined actions: load spec-summarize, spec-bridge-walk, spec-patterns, spec-gaps, or spec-cold-start.
- For free-form analysis: load spec-components for the full catalog.
- ALWAYS use spec blocks for Summarize, Patterns, Bridge Walk, Cold-Start, and Gaps actions.`;

export const EXPLORER_TOOLS = {
  get_block: getBlockTool,
  expand_page: expandPageTool,
  search_blocks: searchBlocksTool,
  get_inbound: getInboundTool,
  suggest_walks: suggestWalksTool,
  qmd_search: qmdSearchTool,
};

// Cached at module level — filesystem reads happen once, merged tools object reused
let toolsPromise: Promise<ToolSet> | null = null;

export function getExplorerTools() {
  if (!toolsPromise) {
    toolsPromise = createSkillTool({
      skillsDirectory: join(process.cwd(), "src/lib/skills"),
    })
      .then((toolkit) =>
        toolkit.skills.length > 0
          ? { ...EXPLORER_TOOLS, load_skill: toolkit.skill }
          : EXPLORER_TOOLS
      )
      .catch(() => EXPLORER_TOOLS);
  }
  return toolsPromise;
}

// TYPE INFERENCE ONLY — not called at runtime.
// chat/route.ts uses getExplorerTools() + streamText directly (to include load_skill).
// This instance exists solely for InferAgentUIMessage type derivation.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _explorerAgent = new ToolLoopAgent({
  model: "anthropic/claude-sonnet-4",
  instructions: EXPLORER_INSTRUCTIONS,
  tools: EXPLORER_TOOLS,
  stopWhen: stepCountIs(5),
});

export type ExplorerUIMessage = InferAgentUIMessage<typeof _explorerAgent>;
