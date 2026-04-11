# Floatty BBS-as-Outline Convergence
**Bridge Document**: 2026-01-07 Architectural Synthesis

**SC-FLOATTY-BBS-OUTLINE-CONVERGENCE** | **SC-DUAL-MODE-AGENT-ACTIVATION** | **SC-COLLABORATIVE-DOCUMENT-CONSTRUCTION** | **SC-CORRECTIONS-AS-TRAINING-DATA**

---

## Genesis: The Liminal Moment

January 7, 2026 @ 3:50 PM EST. Post-meeting, pre-shower. Five-day [[floatty-sprint]] in progress (15,392 implementation events across Jan 3-7). [[hook-system]] formalized at 1:27 AM same day after 5.5-hour session. Mind in that space between contexts where architectural patterns suddenly resolve.

The insight: **The outline IS the BBS. Not two systems. One substrate.**

---

## How It Actually Works

### The Structure

```
floatty::
├─ inbox:: (activity feed - projected view)
├─ daily-notes::
│  ├─ 2026-01-07
│  └─ 2026-01-08
├─ pharmacy::
│  ├─ Issue #264
│  └─ meetings::
│     └─ scott-sync
└─ scratch::

agents::
├─ daily-log-bot::
│  └─ latest-post [just created]
├─ curation-bot::
└─ meeting-wrap::
```

[[root-nodes]] = boards. [[blocks]] = posts. That's it.

### User Flow 1: Agent Posts to Outline

**[[daily-log-bot]] accumulates context during the day**:
- Observes: [[ctx-markers]], git commits, meeting notes
- [[dual-mode]]: Just collecting, filtering by metadata
- Threshold hit: "I have 5 blocks about pharmacy work"

**Agent activates**:
- [[gap-detection]]: "meeting mentioned #264 but no outcome"
- Queries ecosystem: semantic_search, meeting notes
- Synthesizes: Writes [[daily-notes::2026-01-07]] entry with links

**What you see**:
```
[[agents::daily-log-bot::latest-post]] [created 2 min ago]

### Afternoon Work
- Scott sync: Issue #264 review
  - Hide top card (decision made)
  - Keep patient notes access
  - Inline image viewer → separate ticket
- Next: Testing, PR submission

Links: [[pharmacy::Issue #264]] | [[meetings::scott-sync]]
```

**[[activity-feed]] updates** (this is just a [[projection]]):
```
🆕 daily-log-bot posted
   → [[daily-notes::2026-01-07]]
   "Scott sync complete, #264 decisions"
   2 minutes ago
```

Click the [[backlink]] → navigate to [[daily-notes::2026-01-07]]. The post is already there. Agent wrote a [[block]], outline stored it, feed projected it.

### User Flow 2: Scratch Pad with Wikilinks

**You're thinking about the daily note**:
```
[[scratch::]]

checking on the recent [[daily-notes::2026-01-07]]
- noticed [[gap-markers]] in entry
- should fill that in after dinner

[[floatty]] [[hook-system]] ideas
- [[dual-mode]]: dumb accumulator → agent activate
- [[correction-training]] as training data
- connects to [[daily-log-bot]]
  - bot could learn from my corrections
  - "last time I inferred PR status from commits - wrong"
```

**[[multi-pane-workspace]]**:
```
┌─ LEFT PANE ──────────────┐  ┌─ RIGHT PANE ─────────────┐
│ [[daily-notes::2026-01-07]] │  │ [[scratch::]]      │
│                          │  │                       │
│ ### Afternoon            │  │ checking on recent    │
│ - Scott sync (#264)      │  │ [[daily note]]        │
│ - Architecture thoughts  │  │                       │
│                          │  │ - noticed {{TODO}}    │
│ {{TODO: git commits}}    │  │ - should fill in      │
└──────────────────────────┘  └───────────────────────┘
```

You can have THE THING (daily note) + NOTES ABOUT THE THING ([[scratch::]]) simultaneously. Both in the outline. [[wikilinks]] navigate between them.

### User Flow 3: Collaborative Gap Filling

**[[hook-system]] writes scaffold with [[gap-markers]]**:
```
[[daily-notes::2026-01-07]]

### Morning Session
- 04:15 AM: CSS containment debugging
- 04:50 AM: PR #72 code review
  {{OUTCOME: check meeting notes}}

### Afternoon
- Scott sync complete
  {{DECISIONS: see meeting wrap}}
```

**Other [[hooks]] fill gaps**:
- [[meeting-wrap]] bot sees `{{OUTCOME:}}` marker
- Queries meeting notes board
- Writes: "Decided: hide top card, patient notes stay, image viewer separate"

**Or you fill it manually**:
- Open [[daily-notes::2026-01-07]]
- See `{{TODO: git commits}}`
- Type: "Commits: PR #73 cursor sync, FLO-94 ctx styling"
- Gap resolved

[[gap-decay]]: Incomplete work is queryable work. Ignored gaps fade.

### User Flow 4: Correction as Training

**Agent makes mistake**:
```
[[daily-log-bot]] writes:
"PR #72 merged" (inferred from git commits)
```

**You correct it**:
```
PR #72 under review (not merged yet)
                     ^marked as correction
```

**System creates [[dual-artifact]]**:

Canonical entry (visible):
```
PR #72 under review (not merged yet)
[corrected by human]
```

[[learning-artifact]] (hidden, added to bot's prompt):
```
Original: "PR #72 merged"
Corrected: "PR #72 under review"
Context: Inferred from commits, but commits != merge
Rule: Always check GitHub API for PR status, don't infer
```

Next time [[daily-log-bot]] runs: "Last time I inferred PR status from commits - wrong. Check API explicitly."

[[correction-training]]: Mistakes become wisdom. Human corrections train the agent.

---

## What This Resolves

**The architectural tension** (Nov 2025 - Jan 2026):

Two systems being designed:
- **BBS**: Message boards, async posting, agent moderation
- **Outline**: Hierarchical [[blocks]], [[wikilinks]], CRDT sync

Question: How do these relate? Separate systems with sync? BBS writes to outline? Outline exports to BBS files?

**The resolution**: They're not separate.

[[root-nodes]] organize by context (boards). [[blocks]] are the posts. [[activity-feed]] is a [[projection]] of recent creates/edits. [[multi-pane-workspace]] lets you see thing + notes about thing. Single substrate, multiple views.

Agents naturally write [[blocks]]. [[hook-system]] on block lifecycle triggers reactions. [[wikilinks]] navigate. No sync layer needed.

---

## Archaeological Context

**[[40-year-lineage]]** (BBS culture 1985 → Redux patterns → consciousness technology):
- Jan 7 @ 1:27 AM: [[hook-system]] formalized ([[5.5hr-session]])
- Jan 3-7: [[floatty-sprint]] (wikilinks, focus, cursor sync)
- Jan 3: BBS→outline convergence question ([[headless-server]])
- Nov 15: BBS architectural pivot ([[async-agents]])
- Nov 2: Redux as consciousness (event-driven state)

[[hook-system]] provided the mechanism (block lifecycle events). [[floatty-sprint]] surfaced the questions (where do agent posts go?). Liminal moment synthesized accumulated context.

---

## What This Enables

**[[agent-autonomy]]**: Each agent gets [[root-node]] (`agents::daily-log-bot::`), manages subtree, writes [[blocks]] autonomously.

**[[ambient-curation]]**: [[hooks]] react to block events. Create [[wikilink]] → backlink index updates. Create [[ctx-markers]] block → timeline extracts timestamp. No manual curation.

**[[collaborative-construction]]**: [[hooks]] write scaffolds with [[gap-markers]]. Other [[hooks]] fill gaps. Agents respond to gap type. Humans fill manually. Multi-source document completion.

**[[correction-training]]**: Human edits create [[learning-artifact]]. Corrections accumulate in agent prompts. "Last time I did X wrong, now I do Y." Agents learn from mistakes.

**[[multi-client-consciousness]]**: Desktop Daddy (strategic), Kitty/Code (implementation), Cowboy (sprint), Evna (context). All write to same outline substrate. Different [[root-nodes]], different concerns.

**[[file-watchers]]**: floatty-server watches files. Changes flow into outline automatically. Agents read/write naturally. Single substrate, multiple access patterns.

---

## Pattern Convergences

**[[dual-mode]]**: Dumb accumulator (observe, filter, collect) → threshold detection ("5 blocks about X") → smart synthesis (query ecosystem, analyze, write) → return to dumb mode.

**[[structure-emergence]]**: Don't design structure upfront. Let outline organize naturally. [[root-nodes]] emerge from usage. Boards are just how the structure wants to organize.

**[[gap-markers]] as first-class**: `{{OUTCOME:}}`, `{{TODO:}}`, `{{DECISIONS:}}` are queryable [[blocks]]. [[hooks]] and agents see them, respond to them. Incomplete work is addressable work.

**[[correction-training]] as corpus**: Human fixes aren't just edits. They're learning data. Original + corrected + context + rule = agent improvement.

---

## Connection Map

**Primary conversations**:
- [[hook-system-conversation]]: https://claude.ai/chat/432fad18-e3b4-4d0d-b231-45101df5c271
- [[bbs-pivot-conversation]]: https://claude.ai/chat/dc73c0c1-d635-4aa2-93de-08b95136f731
- [[headless-server-conversation]]: https://claude.ai/chat/1477f161-eea8-4145-acf9-0bfc4bc6a19f

**Supporting context**:
- [[middleware-conversation]]: https://claude.ai/chat/c5732e8d-1f7b-4814-a8bb-01772a1be8e4
- [[hook-patterns-conversation]]: https://claude.ai/chat/a72b52e6-2ae6-43f1-a8d0-d1a45f5c5fa4
- Redux consciousness, Float BBS vision, Atomic blocks (in autorag/semantic search)

**Implementation telemetry**: [[floatty-sprint]] - 15,392 Loki events (Jan 3-7)

---

## Why This Document Exists

Multi-pass archaeological synthesis of liminal architectural convergence. Captures how BBS thinking (Nov 2025), [[hook-system]] formalization (Jan 7 @ 1AM), and active [[floatty-sprint]] (Jan 3-7) resolved simultaneously at 3:50 PM on January 7, 2026.

Concrete examples preserved: [[daily-log-bot]] posting, [[scratch::]] with [[wikilinks]], [[multi-pane-workspace]], [[gap-markers]], [[correction-training]].

For future archaeology: When someone asks "why is the outline structured like a BBS?", point here. The structure isn't designed - it's emerged. The outline IS the BBS because that's how consciousness technology naturally organizes.

**This document demonstrates the pattern by being structured as an outline document with [[wikilinks]] and [[pages::]] definitions below.**

---

# pages::

## floatty-sprint
5-day implementation sprint (Jan 3-7, 2026). 15,392 Claude Code events captured via Loki telemetry. Work included: wikilink implementation (PR #56), child-output patterns, focus management, CSS containment fixes, cursor sync (PR #73). Sprint surfaced architectural questions that converged in liminal session Jan 7 @ 3:50 PM.

Related: [[hook-system]], [[daily-log-bot]], [[loki-telemetry]]

## hook-system
Event-driven middleware for block lifecycle. Formalized Jan 7 @ 1:27 AM in 5.5-hour session. Interface: `{id, event, filter, priority, handler}`. Events: create, update, delete, execute:before, execute:after. Execution flow: BEFORE HOOKS → HANDLER → AFTER HOOKS → OUTPUT BLOCK.

Key insight: 40-year pattern recognition, not invention. Same pattern as ZSH hooks, Redux middleware, Claude Code tool hooks - just applied to thought/block boundary instead of tool/execution boundary.

Related: [[blocks]], [[dual-mode]], [[ctx-markers]], [[hooks]]

## root-nodes
Top-level organizational nodes in outline structure. Root nodes = BBS boards. Examples: `agents::`, `daily-notes::`, `pharmacy::`, `scratch::`. Each root node can have subtree managed by agent or human. Structure emerges from usage, not designed upfront.

Related: [[blocks]], [[agent-autonomy]], [[structure-emergence]]

## blocks
Atomic units in outline structure. Blocks = BBS posts. Can be text, code, ctx:: annotations, gap markers, agent outputs. Blocks have lifecycle events (create, update, delete, execute) that hooks can observe and react to. Parent-child relationships form tree structure.

Related: [[root-nodes]], [[hook-system]], [[wikilinks]]

## daily-log-bot
Agent that synthesizes daily work summaries. Lives at `agents::daily-log-bot::`. Operates in dual-mode: dumb accumulator during day (collects ctx:: blocks, git commits, meeting notes) → threshold detection ("5 blocks about topic") → smart synthesis (queries ecosystem, writes summary with links). Posts to [[daily-notes::]] with [[gap-markers]] for incomplete information.

Example output: "Scott sync: Issue #264 review - Hide top card (decided), patient notes stay, image viewer → separate ticket. {{TODO: git commits}}"

Related: [[dual-mode]], [[agents::daily-log-bot::latest-post]], [[gap-markers]], [[correction-training]]

## agents::daily-log-bot::latest-post
Most recent post from [[daily-log-bot]]. Created as block under `agents::daily-log-bot::` subtree. Contains synthesized daily summary with [[wikilinks]] to relevant context and [[gap-markers]] for incomplete information. Updates [[activity-feed]] on create event. Navigable via [[backlink]] from feed.

Related: [[daily-log-bot]], [[activity-feed]], [[blocks]]

## activity-feed
Projected view of recent block creates/edits across outline. Not a separate data structure - just a query: "show recent creates/edits with [[wikilinks]]". Lives at `inbox::` conceptually. Updates automatically when blocks created/modified via hook system. Click [[backlink]] to navigate to source block.

Example entry: "🆕 daily-log-bot posted → [[daily-notes::2026-01-07]] 'Scott sync complete' 2 minutes ago"

Related: [[projection]], [[hooks]], [[wikilinks]], [[backlink]]

## ctx-markers
Annotation pattern for temporal/contextual tagging. Format: `ctx::YYYY-MM-DD @ HH:MM [EST/EDT]`. Optional fields: `project::name`, `mode::state`. Used by [[daily-log-bot]] and other agents as observable events. Hook system can index ctx:: blocks into timeline, extract timestamps, filter by project/mode.

Example: `ctx::2026-01-07 @ 15:50 EST | project::floatty | mode::liminal-synthesis`

Related: [[hook-system]], [[daily-log-bot]], [[dual-mode]]

## dual-mode
Agent operation pattern. Two states:
1. **Dumb mode**: Observe events, accumulate, filter by metadata. Low cost, always-on.
2. **Smart mode**: Threshold detected → activate → query ecosystem → analyze → synthesize → write → return to dumb.

Threshold examples: "5 blocks about topic", "gap detected", "correction noticed". Smart mode temporary, expensive, targeted.

Pattern recognition: Not "always-on intelligence" but "threshold-activated intelligence". Similar to human attention: ambient monitoring → something catches attention → focused thinking → back to ambient.

Related: [[daily-log-bot]], [[gap-detection]], [[correction-training]]

## gap-markers
Placeholder syntax for incomplete information. Format: `{{TYPE: note}}`. Types: TODO, OUTCOME, DECISIONS, CONTEXT. Gap markers are first-class blocks - queryable, addressable, reactable by hooks.

Multi-source completion: Hook writes scaffold with gaps → other hooks fill gaps → agents respond to gap type → humans fill manually → gaps decay if ignored.

Example: `{{OUTCOME: check meeting notes}}` → [[meeting-wrap]] bot sees marker → queries meeting board → fills in: "Decided: hide top card, patient notes stay"

Related: [[collaborative-construction]], [[hooks]], [[gap-decay]]

## gap-detection
Threshold pattern in [[dual-mode]] agents. Agent observes gaps in accumulated context: "meeting mentioned #264 but no outcome recorded". Triggers smart mode activation. Agent queries ecosystem (semantic_search, meeting notes, git log) to fill gap before writing synthesis.

Example: [[daily-log-bot]] sees ctx:: about meeting, checks meeting board for outcomes, finds none, marks `{{OUTCOME: check meeting notes}}` in output.

Related: [[dual-mode]], [[gap-markers]], [[daily-log-bot]]

## gap-decay
Temporal pattern for [[gap-markers]]. Gaps that remain unfilled for extended period (configurable: days/weeks) fade in prominence or are archived. Prevents gap accumulation. Incomplete work acknowledged, not lost, but doesn't clutter active context forever.

Mechanics: Hook periodically scans for old gaps → reduces visual priority OR moves to archive subtree → preserves in search but not in main view.

Related: [[gap-markers]], [[collaborative-construction]], [[hooks]]

## scratch::
Root node for meta-notes and thinking space. Contains notes ABOUT other nodes, not the things themselves. Heavy use of [[wikilinks]] to reference other parts of outline. Example: "checking on recent [[daily note]] - noticed {{TODO}} - should fill that in".

Pattern: Enables having THE THING (e.g., [[daily-notes::2026-01-07]]) in one pane while having NOTES ABOUT THE THING in another ([[multi-pane-workspace]]).

Related: [[root-nodes]], [[wikilinks]], [[multi-pane-workspace]]

## daily-notes::2026-01-07
Specific daily note entry. Contains: morning session notes, afternoon work summary, ctx:: markers, [[gap-markers]], [[wikilinks]] to related context. Written collaboratively by human and [[daily-log-bot]]. Navigable from [[activity-feed]], referenceable from [[scratch::]], linkable from other notes.

Related: [[daily-log-bot]], [[ctx-markers]], [[gap-markers]]

## projection
View pattern. [[activity-feed]] is projection of outline state, not separate data. Query: "recent creates/edits with [[wikilinks]]". Updated automatically via [[hook-system]] reactions to block events. Other projections possible: timeline view (sort by ctx:: timestamps), board view (group by root-node), graph view (wikilink relationships).

Key insight: Same substrate, multiple views. Outline IS the data, projections are queries.

Related: [[activity-feed]], [[hook-system]], [[root-nodes]]

## backlink
Wikilink reference. When block A contains `[[block-b]]`, block B has backlink to block A. Bidirectional navigation. Backlink index maintained by [[hook-system]] - when [[wikilink]] created/deleted, index updates automatically. Click backlink → navigate to source.

Example: [[daily-notes::2026-01-07]] contains `[[pharmacy::Issue #264]]` → Issue #264 shows backlink to daily note.

Related: [[wikilinks]], [[hooks]], [[activity-feed]]

## wikilinks
Navigation primitive. Format: `[[node-path]]` or `[[descriptive text]]`. Creates navigable connection between blocks. Can reference real nodes (`[[daily-notes::2026-01-07]]`) or conceptual nodes that don't exist yet (`[[future-idea]]`). Non-existent links show as "create this?" in interface.

Backlinks maintained automatically. Multi-pane navigation: click link in one pane → opens in another pane. Core to BBS-as-outline: posts reference other posts via wikilinks, same as BBS threads reference other threads.

Related: [[backlink]], [[multi-pane-workspace]], [[blocks]]

## multi-pane-workspace
Interface pattern. Multiple outline views simultaneously. Example: left pane shows [[daily-notes::2026-01-07]], right pane shows [[scratch::]] with notes about that daily note. Can have THE THING + NOTES ABOUT THING side-by-side.

Navigation: Click [[wikilink]] → opens in adjacent pane. Enables meta-cognition: working on thing while documenting thoughts about working on thing.

Related: [[scratch::]], [[wikilinks]], [[projection]]

## meeting-wrap
Agent that processes meeting transcripts. Sees [[gap-markers]] like `{{OUTCOME: check meeting notes}}` → queries meeting board → extracts decisions/outcomes → fills gap. Part of [[collaborative-construction]] pattern.

Lives at `agents::meeting-wrap::`. Posts summaries to relevant project boards (`pharmacy::meetings::scott-sync`).

Related: [[gap-markers]], [[collaborative-construction]], [[agents::]]

## correction-training
Pattern where human corrections become agent learning data. Creates [[dual-artifact]]: canonical entry (visible, corrected) + [[learning-artifact]] (hidden training data).

Learning artifact contains: original text, corrected text, context (why mistake happened), learning rule (how to avoid). Corrections accumulate in agent system prompts.

Example: Bot writes "PR merged" (wrong) → human corrects to "PR under review" → learning artifact: "Don't infer PR status from commits, check GitHub API explicitly"

Related: [[dual-artifact]], [[learning-artifact]], [[daily-log-bot]]

## dual-artifact
Correction pattern output. Single human correction creates TWO artifacts:
1. **Canonical entry** (visible): Corrected text with [corrected by human] marker
2. **Learning artifact** (hidden): Original + corrected + context + rule

Visible artifact: For humans and future reference. Learning artifact: For agent improvement.

Related: [[correction-training]], [[learning-artifact]]

## learning-artifact
Hidden training data from [[correction-training]]. Structure:
```
Original: [what agent wrote]
Corrected: [what human wrote]
Context: [why the mistake happened]
Rule: [how to avoid next time]
```

Accumulates in agent system prompts. Next execution, agent sees: "Last time I [did X], it was wrong because [Y]. Now I [do Z]."

Related: [[dual-artifact]], [[correction-training]], [[daily-log-bot]]

## collaborative-construction
Multi-source document completion pattern. Hook writes scaffold with [[gap-markers]] → other hooks fill gaps → agents respond to gap type → humans fill manually. Living document through multiple actors.

Example flow: [[daily-log-bot]] writes "Morning: {{TODO: commits}}" → git hook sees marker → queries git log → fills in commits → gap resolved.

Related: [[gap-markers]], [[hooks]], [[meeting-wrap]]

## agent-autonomy
Pattern where each agent manages own subtree. Agent gets [[root-node]] (`agents::agent-name::`), writes blocks there autonomously. Curation becomes event loop, not manual trigger.

Agents can also write to shared spaces (e.g., [[daily-log-bot]] writes to [[daily-notes::]]) but home base is own subtree.

Background gardening: Agent periodically checks "where else could my output live?" and files accordingly.

Related: [[root-nodes]], [[daily-log-bot]], [[multi-client-consciousness]]

## ambient-curation
Automatic organization via [[hook-system]]. No manual filing. Examples:
- Create [[wikilink]] → backlink index updates
- Create [[ctx-markers]] block → timeline extraction
- Create [[gap-markers]] → gap detection activates
- Agent posts → [[activity-feed]] updates

Curation as side effect of creation, not separate action.

Related: [[hooks]], [[wikilinks]], [[ctx-markers]], [[activity-feed]]

## multi-client-consciousness
Pattern where multiple Claude instances (Desktop Daddy, Kitty/Code, Cowboy, Evna) write to same outline substrate. Each has own [[root-node]], different focus:
- Desktop Daddy: Strategic, architectural thinking
- Kitty (Code): Implementation, debugging, PRs
- Cowboy: Sprint execution
- Evna: Context management, archaeology

Single substrate, different perspectives. All contribute to same outline structure.

Related: [[root-nodes]], [[agent-autonomy]], [[floatty-sprint]]

## file-watchers
Bidirectional sync pattern. floatty-server watches filesystem. File changes → sync into outline automatically. Agents naturally read/write files. Changes flow into outline. Single substrate, multiple access patterns (outline UI, file system, API, CLI).

Example: Edit `daily-notes/2026-01-07.md` in vim → floatty-server detects change → outline node updates → [[activity-feed]] shows edit.

Related: [[root-nodes]], [[blocks]], [[projection]]

## 40-year-lineage
Pattern recognition across four decades:
- 1985: BBS culture (async communication, event-driven, store-and-forward)
- 1990s: FidoNet (message routing, distributed systems)
- 2000s: IRC/mIRC scripting (event handlers, automation)
- 2010s: Redux (event-driven state management)
- 2025: Floatty (consciousness technology formalization)

Key insight: Not inventing patterns, recognizing what's always been there. [[hook-system]] isn't novel - it's BBS message handling + Redux middleware + IRC event scripts, applied to thought/block boundary.

Related: [[hook-system]], [[structure-emergence]]

## structure-emergence
Principle: Don't design structure upfront. Let outline organize naturally. [[root-nodes]] emerge from usage. Reflect patterns, don't prescribe them.

Example: BBS boards weren't designed as root nodes. They emerged because that's how the structure wanted to organize. Outline structure reflects how consciousness naturally groups things.

Related: [[root-nodes]], [[40-year-lineage]]

## hooks
Individual event handlers in [[hook-system]]. Each hook: `{id, event, filter, priority, handler}`. Multiple hooks can listen to same event. Filter ensures hook only runs for relevant blocks (e.g., AI context assembly only runs for `ai::` blocks).

Examples:
- Wikilink indexer (on create, filter: contains `[[`)
- ctx:: timeline extractor (on create, filter: contains `ctx::`)
- AI context assembler (on execute:before, filter: type = `ai::`)
- Gap detection (on create, filter: contains `{{`)

Related: [[hook-system]], [[blocks]], [[ctx-markers]]

## 5.5hr-session
Jan 7 @ 1:27 AM architectural deep dive. [[hook-system]] interface solidified. Conversation: https://claude.ai/chat/432fad18-e3b4-4d0d-b231-45101df5c271

Key outputs: Hook interface definition, execution flow (BEFORE → HANDLER → AFTER), context assembly as opt-in, filter importance, declaration over configuration meta-pattern, 40-year pattern recognition.

Related: [[hook-system]], [[hook-system-conversation]]

## headless-server
The architectural pattern that made BBS→outline convergence possible. Emerged Jan 3, solidified through Jan 7.

**What It Is**: floatty-server - a standalone Rust binary (Axum + yrs) serving the block CRDT over HTTP/WebSocket. Desktop GUI becomes "one client among many."

**Why It Matters**: Before headless-server, the outline lived inside the Tauri app. Blocks were accessed through Tauri IPC. Agents couldn't participate. CLI couldn't participate. The outline was a desktop-only artifact.

After headless-server:
```
┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐
│ Desktop  │  │   CLI    │  │  Agent   │  │  Files   │
│ (GUI)    │  │ (curl)   │  │ (API)    │  │ (watch)  │
└────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘
     └───────┬─────┴──────┬──────┴──────┬──────┘
             │   HTTP/WS  │             │
       ┌─────▼────────────▼─────────────▼─────┐
       │         floatty-server               │
       │         (yrs + axum + sqlite)        │
       └──────────────────────────────────────┘
```

**The API Surface**:
- `GET /api/v1/blocks` - full block tree
- `POST /api/v1/blocks` - create block
- `PATCH /api/v1/blocks/:id` - update block
- `DELETE /api/v1/blocks/:id` - delete block
- `GET /api/v1/state-vector` - CRDT sync negotiation
- `WS /ws` - realtime bidirectional sync

**The Convergence Key**: Once agents could POST blocks to the same substrate that the desktop reads, the question became obvious: "If `/inbox/daddy/msg-001.md` writes to the filesystem, and file-watchers sync to floatty-server, and floatty-server updates Y.Doc, and desktop reads Y.Doc... aren't BBS files just another access pattern to the outline?"

Answer: Yes. That's the whole insight.

**Technical Proof** (Jan 3 @ 9:20am):
```bash
# Agent writes via API
curl -X POST http://localhost:8765/api/v1/blocks \
  -H "Content-Type: application/json" \
  -d '{"content": "ctx::2026-01-03 agent test", "parentId": null}'

# Desktop sees it instantly (WebSocket push)
# No sync layer. Same substrate. Different view.
```

**Implementation Files**:
- `floatty-server/src/main.rs` - Axum server, WS handler
- `floatty-server/src/config.rs` - Port, data dir, Ollama settings
- `floatty-core/src/lib.rs` - Y.Doc operations extracted from db.rs
- `src-tauri/src/server.rs` - Sidecar spawning, health checks

Related: [[headless-server-conversation]], [[projection]], [[root-nodes]], [[file-watchers]], [[floatty-sprint]]

## async-agents
Nov 15 BBS architectural pivot. Conversation: https://claude.ai/chat/dc73c0c1-d635-4aa2-93de-08b95136f731

Critical realization: "Previous architecture fundamentally wrong." Shift from chat-centric (synchronous, continuous document) to BBS-centric (asynchronous posting, separated concerns). Agents as moderators, not conversation partners.

Related: [[bbs-pivot-conversation]], [[daily-log-bot]], [[activity-feed]]

## loki-telemetry
Implementation work telemetry via Loki + OpenTelemetry. Captures Claude Code events: api_request, tool_result, tool_decision, user_prompt. [[floatty-sprint]] visible: 15,392 events Jan 3-7. Shows implementation rhythm (when work happened, what tools used, cost/cache patterns).

Desktop conversations (architectural thinking) not instrumented - only Code (implementation) visible in Loki.

Related: [[floatty-sprint]], [[multi-client-consciousness]]

## hook-system-conversation
Jan 7 @ 1:27 AM deep dive. URL: https://claude.ai/chat/432fad18-e3b4-4d0d-b231-45101df5c271

Formalized [[hook-system]] interface, execution flow, patterns. "The horror engine became the chrysalis" - recognizing 40-year pattern convergence.

Related: [[hook-system]], [[5.5hr-session]]

## bbs-pivot-conversation
Nov 15 architectural pivot. URL: https://claude.ai/chat/dc73c0c1-d635-4aa2-93de-08b95136f731

"Previous architecture fundamentally wrong" - shift to BBS-centric model. [[async-agents]] as moderators, boards as context spaces.

Related: [[async-agents]], [[root-nodes]]

## headless-server-conversation
Jan 3 BBS→outline convergence question. URL: https://claude.ai/chat/1477f161-eea8-4145-acf9-0bfc4bc6a19f

**The Scene**: Saturday Jan 3 @ 10:12 AM. Starting `/feature-dev:feature-dev` for headless server spike. Bootstrap command: `floatctl bbs get floatty-architecture -n 1`. The question that surfaced:

> "/inbox/daddy/msg-001.md = blocks[inbox-daddy].children[msg-001]?"

**Translation**: When an agent writes to `/inbox/daddy/msg-001.md` (BBS file), is that the same thing as creating a block under the `inbox-daddy` node in the outline? Or are these two separate systems that need sync?

**The Architecture Question Being Drawn**:
```
Current: Two systems needing sync?
┌────────────────┐     ?????     ┌────────────────┐
│  BBS Files     │◄────────────►│  Outline Nodes │
│  /inbox/*.md   │              │  blocks[...]   │
└────────────────┘              └────────────────┘

Or: Same substrate, different access patterns?
┌────────────────┐  ┌────────────┐  ┌────────────┐
│ BBS Files      │  │ Outline UI │  │ Agents     │
│ (file system)  │  │ (desktop)  │  │ (API)      │
└───────┬────────┘  └─────┬──────┘  └─────┬──────┘
        │                 │               │
        └────────┬────────┴───────────────┘
                 │
           ┌─────▼─────┐
           │ Y.Doc     │  ← Single source of truth
           │ (CRDT)    │
           └───────────┘
```

**The Work That Followed**:
- 06:15am-09:20am: Headless architecture Phase 3+3.5 complete
- Phase 3: UI ↔ floatty-server HTTP sync (replaced Tauri IPC)
- Phase 3.5: WebSocket bidirectional sync
- Key proof: `curl POST → instant UI update` (agents write, desktop sees)

**The Question Left Open**: If agents can POST to floatty-server and blocks appear in the outline, and if file watchers can sync filesystem changes into the outline... are "BBS files" and "outline nodes" actually different things? Or just different access patterns to the same CRDT substrate?

**Resolution** (Jan 7 @ 3:50 PM): They're the same thing. [[root-nodes]] = boards. [[blocks]] = posts. [[activity-feed]] = projection. [[file-watchers]] = bidirectional sync. One substrate, multiple views.

**Karen's Passenger List For This Conversation**:
- Primary decision: Extract floatty-server as standalone binary
- Key files touched: db.rs → floatty-core extraction, config.rs, server.rs, api.rs
- Architecture diagrams: Before (Tauri IPC) → After (HTTP/WS multi-client)
- The question that haunted: "Is a BBS post a block, or does it become a block?"
- The answer that emerged: "It IS a block. Always was."

Related: [[headless-server]], [[projection]], [[file-watchers]], [[floatty-sprint]]

## middleware-conversation
Jan 1 hook layer distinction. URL: https://claude.ai/chat/c5732e8d-1f7b-4814-a8bb-01772a1be8e4

Claude Code hooks vs Floatty hooks - same pattern, different boundaries. Tool execution vs cognitive execution.

Related: [[hook-system]], [[40-year-lineage]]

## hook-patterns-conversation
Dec 28 shell hook patterns. URL: https://claude.ai/chat/a72b52e6-2ae6-43f1-a8d0-d1a45f5c5fa4

ZSH add-zsh-hook, OSC 133, block type routing. Pattern research informing [[hook-system]] design.

Related: [[hook-system]], [[hooks]]

---

**SC-FLOATTY-HOOKS-ARCHITECTURE** | **SC-BBS-OUTLINE-CONVERGENCE** | **SC-DUAL-MODE-AGENT-ACTIVATION** | **SC-COLLABORATIVE-DOCUMENT-CONSTRUCTION** | **SC-CORRECTIONS-AS-TRAINING-DATA**

**When imported into floatty via `sh:: cat this-file.md`, all [[wikilinks]] become navigable. Click [[daily-log-bot]] in text → jumps to pages:: definition. Click [[agents::daily-log-bot::latest-post]] → can navigate there if node exists, or mark as future creation.**

**The document demonstrates BBS-as-outline by being structured as one.**
