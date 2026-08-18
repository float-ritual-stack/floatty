# Pi SDK Integration — float-box Agent Runtime

**Created**: 2026-08-18
**Status**: EXPLORATION — design mapping, not yet implemented. Update this banner with what ships.
**Decision (2026-08-18)**: the pi agent runtime runs **co-located on float-box** (Hetzner GEX44), not on client machines.
**Review lineage (2026-08-18)**: written by the deepseek harness (flash tier); fact-checked against the repo by claude (one fabrication fixed, §5.2); coherence blockers resolved per GPT review; independently re-reviewed by GPT-5.6-in-pi. Where this doc and the later review rounds diverge (ACP-at-P1 vs internal-protocol-first, hash-only vs BASE snapshots, precondition endpoints), the current word lives in the [[FLO-905]] comment trail + [[FLO-907]]/[[FLO-909]]/[[FLO-910]]. The `garden::` prefix collision it flagged was resolved by deletion ([[PR #395]]).

## Why float-box

- floatty is used across **two Macs** (desktop + laptop) in FLO-762 remote-authority mode, and things are triggered from **claude.ai on a phone** via the floatty-backend skill.
- A co-located runtime means **one agent brain**, reachable by every client over the existing tailnet + API-key path — the same shape as `floatty-server` today.
- The agent process sits **next to Ollama** (localhost `:11434`): zero WAN latency on model calls. Clients only ship thin JSON-RPC; agent writes flow into the shared outline via floatty-server, so every machine and the phone see results through normal CRDT sync.
- Long-running jobs (garden sweeps, merges) are **decoupled from any client** — they survive your laptop closing.

---

## 1. Current state

### 1.1 The three-layer stack (from CLAUDE.md)

```text
SolidJS (local Y.Doc) → Tauri IPC → Rust (floatty-server) → Axum (Y.Doc authority, SQLite)
```

### 1.2 What float-box runs today (from `REMOTE_DEPLOYMENT.md` + `~/.floatty-dev/config.toml`)

| Service | Detail |
|---|---|
| floatty-server (Axum) | Y.Doc authority, SQLite + Tantivy; binds tailnet IP `100.78.124.84:8765`; systemd unit (`/etc/systemd/system/floatty-server.service`); deploy checkout `/opt/float/floatty-deploy`, data dir `/opt/float/floatty-data` |
| Ollama | `http://float-box:11434`; `qwen2.5:7b` (ctx:: parsing), `mistral-small:24b` (send_model) — **24B Q4 already proven on the 20 GB card** |
| OTLP collector | `http://float-box:3101/otlp/v1/logs` — app traces already land here |
| Tailscale | tailnet is the fabric; **G5 gotcha: bind tailnet IP, never `0.0.0.0`** (float-box has a public IP) |

### 1.3 Clients

- Desktop + laptop: thin clients, `remote_server_url = "http://100.78.124.84:8765"` in `config.toml`, **no local server spawned** (`connect_remote_server`, split-brain guarded).
- Phone: claude.ai with the `floatty-backend` skill/plugin — its scripts resolve `FLOATTY_URL` to the remote authority and read the matching key from the same config.

### 1.4 The render agent today (what we replace)

`packages/render-door/src/render.tsx::generateSpecViaAgent` shells out from the **client webview**:

```text
cd ~/.floatty/doors/render/agent && claude -p --json-schema <bbsCatalog schema> --output-format json ...
```

via Tauri `execute_shell_command`. Config lives in `[plugins.render]` (`model`, `agent_binary`, `agent_cwd`) → `ctx.settings` (doorLoader `getPluginSettings`). Schema/prompt contract pinned in `.claude/rules/render-door-agent.md` (`bbsCatalog.jsonSchema()`, `catalog.prompt()`, `[title:: …]` atomic-title discipline).

### 1.5 Agent-role vision already specced

`docs/architecture/agentic-runtime/` (ASPIRATIONAL, unbuilt): Clerk / Librarian / **Gardener** / Renderer roles; work-log attribution; "no durable artifact without a backlink". ADR-003/004 formalize outline-native vs external-execution agents. `dispatch::` is a reserved-but-unimplemented block prefix ("spawns agents").

---

## 2. pi SDK facts (pi.dev/docs/latest/sdk)

- Package: `@earendil-works/pi-coding-agent` (v0.84.x at time of writing), **Node ≥ 22.19**, `pi` CLI (print `-p`, `--mode rpc`, `--mode json` JSONL).
- `createAgentSession()` — the active loop: events (`message_update`, `tool_execution_*`, `turn_end`), `prompt()`/`steer()`/`followUp()`, `abort()`, `compact()`. **`AgentSessionRuntime` owns session replacement** (new/switch/fork/import) — the bridge keeps one `AgentSessionRuntime` per durable floatty run (see §4.3 RunManager).
- `defineTool()` custom tools (TypeBox params) — the mechanism for typed floatty tools.
- `ModelRuntime` — provider abstraction incl. **custom providers / models.json → Ollama and OpenAI-compatible endpoints**; auth via env / auth.json / runtime overrides.
- `SessionManager` — persistent tree sessions, `fork`/`branch`/labels; `SettingsManager`; `DefaultResourceLoader` (AGENTS.md, skills, prompts).
- Structured output: core has structured-output support upstream; the `@nqbao/pi-json-schema` extension (tool `json_output` + `--json-schema --json-output`) is the headless-validation pattern. **For render specs we do better: validate in-bridge** (§4.4).

---

## 3. Target architecture

```text
                    float-box (Hetzner GEX44 — Ubuntu 24.04, tailnet)
 ┌──────────────────────────────────────────────────────────────────────┐
 │  floatty-server (Axum) :8765         — Y.Doc authority, SQLite       │
 │    └─ NEW: /api/v1/agent/* proxy routes → pi-agent (localhost)       │
 │  Ollama :11434                      — qwen2.5:7b ctx, 14b/24b agent  │
 │  OTLP collector :3101               — agent traces here too          │
 │  pi-agent (Node bridge) — child of floatty-server, ACP stdio     │    
 │    createAgentSession + floatty custom tools                         │
 │    → Ollama over localhost (zero WAN model latency)                  │
 │    → writes blocks via floatty-server (localhost:8765 REST, API key) │
 └───────────────────────────────┬──────────────────────────────────────┘
                           tailnet (CRDT WS + REST, Bearer key)
        ┌───────────────────┼───────────────────────┐
   ┌────┴─────┐       ┌─────┴────┐            ┌─────┴───────────┐
   │ desktop  │       │  laptop  │            │ claude.ai phone │
   │ float-pty│       │ float-pty│            │ floatty-backend │
   └──────────┘       └──────────┘            │ skill → agent   │
                                              │ dispatch script │
                                              └─────────────────┘
```

Key properties:

- **One agent runtime** on float-box; every trigger (door on either Mac, phone skill script) reaches the same sessions/models.
- **Agent writes go through floatty-server** (REST, shared API key) — so origin tagging, hooks (outlinks/markers/output-summary), seq numbers, and WS broadcast to all clients all work with zero new machinery. The agent never touches the Y.Doc directly.
- **Clients talk to ONE port** (8765) via the proxy — no second tailnet port, no new CORS/ATS surface (G1), and the phone skill already knows `$FLOATTY_URL`.

---

## 4. The pi-agent service on float-box

### 4.1 Process shape — custom bridge (recommended) vs pi-server

| Option | Pros | Cons |
|---|---|---|
| **Custom pi-bridge** (Node, SDK) — recommended | We own the tool surface (security scoping), in-bridge catalog validation (§4.4), session storage under `/opt/float/floatty-data`, hooks into the OTLP logger | We build/maintain it (small — one service, ~1-2 files of glue + tools) |
| pi-server (upstream pi-mono "Multi-Agent Orchestration Server") | SQLite session storage, remote connectivity, multi-agent orchestration built in | Upstream + experimental ("Session Server… (Experimental)" in docs); custom-tool and catalog-validation story weaker; harder to scope |

**Decision: custom pi-bridge first**, shaped as an **ACP v2 Agent** (see §4.2), **owned as a child process of floatty-server** (see §4.3 — one supervision tree, not a separate systemd unit). Revisit pi-server only if multi-agent orchestration needs grow beyond one-agent-per-request.

### 4.2 Wire protocol — ACP (Agent Client Protocol)

Use **ACP v2 semantics** (agentclientprotocol.com) as the agent-service contract — session lifecycle (`session/new|resume|list|close`), prompt turns (`session/prompt` → `session/update` notifications for message chunks, tool calls, plans), a **permission gate** (`session/request_permission`), **elicitation** (agent → user structured forms, JSON-Schema driven), cancellation (`session/cancel`). First-party SDKs exist in both floatty languages: Rust (`agent-client-protocol` crate — powers Zed) and TypeScript (`@agentclientprotocol/sdk`).

**Sequencing — ACP-shaped semantics now, ACP wire protocol later.** P1 does NOT depend on ACP: pi has no native ACP, so the wire protocol would add a Rust ACP client + TS ACP agent wrapper + a lifecycle mapping + protocol/versioning surface. Instead:
- **v1 (P1): small internal JSONL/localhost-HTTP protocol** between floatty-server and the bridge, carrying the ACP-shaped semantics (session lifecycle, update stream, permission requests, cancel) with floatty-owned names.
- **v2 (later): swap the transport to ACP wire protocol** without touching floatty-owned contracts — the contracts that must be transport-independent are `run_id`, the preconditioned verbs (§4.5), and role → capabilities (§4.5). This is exactly GPT's "ACP is the replaceable agent seam; floatty tools are the capability seam": the seam exists from day one, the wire format is swappable.

**Topology — stdio inside the box, REST at the edge** (sidesteps ACP's immature remote transport entirely):

```text
clients (webview REST / phone script)
   │  POST/WS /api/v1/agent/*   (Bearer key, as before)
   ▼
floatty-server (Rust) ── ACP Client (agent-client-protocol crate) ──stdio──▶ pi-agent bridge (Node)
                                                                                ACP Agent (@agentclientprotocol/sdk)
                                                                                createAgentSession + floatty tools
                                                                                → Ollama localhost
```

- **floatty-server holds the ACP *client*** and spawns the bridge over **stdio** — ACP's one stable, mandated transport. The remote-transport weakness of ACP (Streamable HTTP is draft; Transports WG formed 2026-04) never matters because the ACP hop is box-local.
- **The bridge implements the ACP *Agent*** via `@agentclientprotocol/sdk` in the same Node process — same effort as a bespoke JSON-RPC server, but standard-shaped and **agent-swappable**: pi today, `pi-acp`-adapter or claude-code-acp tomorrow, any ACP agent later, with zero floatty-client changes.
- **Keep ACP narrow**: ACP owns *session lifecycle, prompt/update stream, cancel, permissions, elicitation* — nothing more. Floatty tools are **application capabilities inside the bridge**, not ACP wire types: the bridge exposes them as typed `defineTool()` tools (pi SDK) and maps them onto ACP tool calls with custom kinds (`_floatty/*`) purely for client display. Do NOT treat `_floatty/*` as part of Floatty's fundamental API contract — a different ACP agent gets a different adapter while floatty's internal intents stay stable.

```text
floatty-server ⇅ ACP ⇅ pi bridge ⇅ typed custom tools ⇅ floatty REST
```
- **Permission gate**: `session/request_permission` replaces the `--dangerously-skip-permissions` footgun — floatty shows a confirm (like `render:: agent` gating), allow-once/allow-always cached per tool per session (pi-acp adapters already do this).
- **Elicitation = merge conflict UX**: the agent asks "keep yours or theirs" as a structured form rendered in the outline.
- **`_meta` trace context**: ACP reserves W3C `traceparent`/baggage in `_meta` — bridge runs correlate with OTLP on float-box:3101 for free.
- **Auth**: unchanged — existing Bearer key at the REST edge; the stdio hop is unauthenticated localhost (same trust as floatty-server ↔ bridge).

### 4.3 Process ownership & lifecycle — floatty-server owns the bridge child

**Ownership: Option A (server-owned), not a separate systemd unit.** systemd owns `floatty-server.service`; `floatty-server` owns the bridge child. One supervision tree, one ACP connection, no orphan state, and ACP's stable stdio transport stays box-local. (The earlier separate `pi-agent.service` draft would have forced a second transport — resolved in favor of A.)

```text
floatty-server.service (systemd)
  └─ AgentBridgeSupervisor            (in floatty-server)
       ├─ spawn node /opt/float/floatty-deploy/pi-agent/index.js
       ├─ ACP stdio (agent-client-protocol crate)
       ├─ restart child on crash
       └─ health/version handshake (echoed in /api/v1/agent/status)
```

- Node ≥ 22.19 on float-box (`nvm`/apt) or a bun-compiled single-file binary if we want zero Node-on-box dependency.
- Sessions stored under `/opt/float/floatty-data/pi-sessions` (survives reboots; not in `backups/*.ydoc` — treat as disposable; the outline keeps the durable records via run_id backlinks, below).
- Bridge crash → supervisor restarts it; in-flight runs are lost (their run_id stays in the work log with status `interrupted`); no half-applied mutation is left behind because every mutation goes through floatty-server's preconditioned verbs (§4.5).

**Kill semantics — resolved explicitly (replaces the contradictory earlier draft):**

| Event | Behavior |
|---|---|
| Triggering block deleted | cancel run |
| Explicit user cancel (`session/cancel`, ⌘. on the door) | cancel run |
| Client disconnect (laptop closed, phone closed, WS dropped) | **DO NOT cancel** — run detaches, continues on float-box, result still writes to the outline |
| Bridge crash / server restart | run interrupted, work-log entry with status `interrupted`, rerunnable from run_id |

Detached jobs are the whole point of putting the runtime on float-box — the client is a trigger and a viewer, never the execution host.

**Run identity — establish now, before any code.** Four distinct identities, one floatty-owned:

| ID | Owner | Purpose |
|---|---|---|
| `run_id` (`run_...`) | **floatty** (durable execution identity) | work-log key, rerun/resume target, the thing the outline backlinks |
| `acp_session_id` | ACP protocol | the ACP connection/session for the run |
| `pi_session_id` | pi harness | pi's `SessionManager` entry (history, fork/resume) |
| `trigger_block_id` | outline | the door block that started the run |

```json
{ "run_id": "run_...", "trigger_block_id": "...", "role": "gardener",
  "status": "running", "agent": "pi", "model": "local_fast",
  "acp_session_id": "...", "pi_session_id": "..." }
```

`run_id` is the vocabulary that survives pi: when the agent is swapped, the work-log and backlinks don't change. Bridge-side, one `RunManager` holds an `AgentSessionRuntime` per durable run (pi SDK: `AgentSessionRuntime` owns new/switch/fork/import; `AgentSession` is the active loop) — that is the seam where ACP resume/fork semantics map later:

```text
RunManager
├─ run_123 → AgentSessionRuntime → current AgentSession
├─ run_456 → AgentSessionRuntime → current AgentSession
└─ ...
```

### 4.4 The render_spec tool — structured output, done properly

The bridge imports `bbsCatalog` / `jsonSchema()` / `catalog.prompt()` / `validateSpec` from `@json-render/core` + `render-catalog` (Node-importable — no DOM). Instead of CLI `--json-schema` (which per render-door-agent.md does **not** validate per-element shape in strict mode), the agent gets a custom tool:

```text
render_spec({ spec })  → validates against bbsCatalog.jsonSchema(), returns normalized spec or error
```

Agent builds the spec → bridge validates deterministically → retry on failure. The bridge also sets `data.title` directly, preserving the `[title:: …]` atomic-title discipline for free.

### 4.5 Tool surface — small preconditioned verbs, not a mutation bag

No `apply_edits` blob. Mutations are **small verbs with preconditions** — better validation, better auditability, and optimistic concurrency almost for free:

| Verb | Preconditions |
|---|---|
| `create_block(parentId, afterId?, content)` | parent exists; afterId is a child of parent |
| `update_block(blockId, expectedHash, content)` | block exists; hash(block.content) == expectedHash |
| `move_block(blockId, newParentId, afterId?, expectedParentId)` | block exists; parent chain valid; block is currently under expectedParentId |
| `delete_block(blockId, expectedHash)` | block exists; hash matches (deleting what the agent actually saw) |

A higher-level `apply_edits` exists only as a **bridge-side deterministic transaction coordinator** that takes these ops, validates every precondition, and rejects the batch on the first stale one. Every mutation then goes through floatty-server (Y.Doc transaction, hooks, broadcast) with the expected-hash guard:

```text
agent reads block A (hash=123) → ... → proposes update A expectedHash=123
current A hash=456 (user edited on laptop 30s ago)
→ reject stale edit → agent must reread and re-reason
```

Y.Doc guarantees convergence; it cannot tell you the agent just overwrote a paragraph written elsewhere. expectedHash is that semantic guard.

Read tools stay `render_spec` (catalog-validated), `read_subtree`, `get_block`, `search`, `presence`; `merge_conflicts` remains the Tier-2 entry point (§5.2).

**Role → capabilities is a contract, not a first-implementation property:**

| Role | Capabilities |
|---|---|
| renderer | `read_subtree`, `search`, `render_spec`, notebook write |
| librarian | **global read** (`get_block`, `read_subtree`, `search`, `backlinks`, `recent`, `resolve_path`) + **notebook-subtree write only** — no mutations elsewhere |
| gardener | librarian + block mutations scoped to target subtree (preview → apply) |
| merger | `merge_conflicts`, scoped `read_subtree`, scoped mutations |
| dispatch/execution | explicitly configured external capabilities |

"No blanket shell" is structural: a role simply does not have capabilities outside its row. Authorization = user intent gate (permission requests) on top.

**Read scope is not the security boundary (personal tool).** The Librarian reads the whole library; budgets (`maxBlocksRead`, `maxExpansions`, token/runtime caps) are **attention controls, not ACLs** — they stop a local model drowning in 817 blocks or looping the graph. The real privacy boundary is **model routing**: local Ollama on float-box may receive the whole outline; a frontier/cloud fallback sends personal content off-box → explicit confirm/policy (§5.6, §6).

**Bridge environment isolation (pi-harness review, 2026-08-18)** — `DefaultResourceLoader` discovers ambient extensions/skills/prompts from `~/.pi/agent`, project `.pi/`, and AGENTS.md walking up the cwd. The production bridge must NOT inherit the operator's normal pi environment: use an **isolated `agentDir`** (under `/opt/float/floatty-data/pi-agent`), a **non-repository `cwd`**, `noTools: "builtin"` or a strict tool allowlist, explicit custom tools only, an explicit system prompt, and **no `bash`/`edit`/`write`/filesystem tools for outline-native roles**. Pi is the reasoning loop, not the authorization layer.

### 4.6 Observability

Bridge logs structured JSONL → OTLP at `float-box:3101` (app already ships there). Instrument per-run: model, tokens, latency, tool calls, spec validation pass/fail — makes "is the open model good enough for X" a measured question.

### 4.7 ACP roadmap — drafts to watch (do not build on yet)

- **MCP-over-ACP** (RFD, nikomatsakis): clients inject MCP servers through the ACP channel (`"type": "acp"`) — floatty's block API becomes MCP-over-ACP tools in the session, no separate MCP process/port. Would replace the custom tool layer entirely. Draft.
- **ACP proxies / proxy-chains** (RFD): components between client and agent that intercept/transform messages — context injection (outline presence/ancestors/backlinks), **tool filtering (subtree scoping = security)**, response transformation (**render-spec validation as a proxy**), multi-agent routing (claude fallback). This is the standard-shaped version of the bridge tool surface. Draft.
- **session/fork** (RFD, José Valim): fork sessions without polluting history — merge/garden "summarize then apply" flows.
- **Remote transports**: Streamable HTTP draft + Transports Working Group (2026-04). When stable, the stdio hop could move to WS and clients could talk ACP directly, dropping the REST proxy. Until then the §4.2 topology stands.

### 4.8 Ownership boundary (crystallized)

```text
                    FLOATTY OWNS
                    ───────────
        outline truth · run identity · authorization
        scope · mutation validation · work log · agent projections
        │
        │ ACP (session lifecycle · prompt/update · cancel · permissions · elicitation)
        ▼
                    AGENT BRIDGE OWNS
                    ─────────────────
        pi lifecycle · model routing · session history
        prompt/runtime · tool composition
        │
        │ typed capability calls (preconditioned verbs)
        ▼
                    FLOATTY SERVER
                    ──────────────
        reads · validated mutations · Y.Doc transactions
        hooks · broadcast
```

**ACP is the replaceable agent seam. Floatty tools are the capability seam. Y.Doc remains the truth.** None of this requires pi to become permanent architecture — "define protocols, don't embed implementations."

---

## 5. Use cases

### 5.1 render:: agent — swap backend

1. **Stopgap (quality validation)**: point `render:: agent` at Ollama on float-box (`mistral-small:24b`) — via pi `-p` or direct Ollama — from one Mac. Keep `claude` as fallback via `agent_backend = "claude" | "pi"` in `[plugins.render]`.
2. **Real path**: client render door calls `agent_run` → server proxy → bridge `render_spec`. `claude` remains the fallback backend until open-model spec quality is proven on real prompts.

### 5.2 Smart merge — two tiers

**Tier 1 — dumb merge (client-side pure logic, no agent).** Extends today's `linear::`/`floatty-pr::` pattern (`fetch → parseMarkdownToOps → addNewChildrenTree`, which is content-keyed append-only and stateless):

- Doors emit a **`key` per source node** (e.g. `FLO-305/status`). **[fact-check 2026-08-18]**: `addNewChildrenTree` does NOT accept a `key` today — actual signature is `{content, children?}` with dedupe by trimmed content (`doorStdlib.ts:218`). Key emission is NEW stdlib work, not existing capability.
- On fetch, store **snapshot hashes** in block metadata: `metadata.external_sync = { source, ref, fetchedAt, nodeHashes: {key → sha1(content)} }` (hashes, not full dumps; `updatedAt` alone is unreliable across writers — quirk audit).
- New pure lib `mergeEngine.ts` (unit-testable like `determineKeyAction`):
  - key in source+outline, hash == snapshot → untouched → apply source change **in place** (ID-based, surgical `insertChildId`/`removeChildId`, never delete-all-then-push)
  - key in source, missing in outline → **insert at `afterId`** from snapshot
  - key in outline, not in source → user-added → **keep**
  - key in both, hash ≠ snapshot → **conflict → escalate to Tier 2**
- UX: `merge::` door (or `--merge` flag on existing doors) with a diff-preview block ("3 updated, 1 new, 2 conflicts") before applying.

**Tier 2 — agent merge (pi).** When conflicts exist (or explicit `merge:: agent`): the door ships a **constrained conflict packet** — not the whole subtree:

```text
BASE    fragments only for conflicted keys (snapshot hashes)
LOCAL   fragments for conflicted keys + relevant ancestors/children
REMOTE  source fragments for conflicted keys
structural context (parent chain, sibling order)
allowed edit scope (subtree root, roles → capabilities)
```

Agent has `merge_conflicts` + `read_subtree` (fetch more only if needed) + scoped mutation verbs, and instructions: *preserve user edits, apply source changes, restructure/nest as needed* (Gardener role, verbatim from agentic-runtime). Result lands via projection contract (`content` = semantic, `output.data` = envelope) + preconditioned writes; work-log entry (run_id) + session backlink. **Re-diff before apply is structural** — the expectedHash preconditions reject any edit that raced a concurrent writer; the agent must reread and re-reason. The model never decides *what changed* (that's the deterministic Tier-1 classification); it only decides *what an ambiguous change means*.

### 5.3 garden:: / dispatch:: doors

**Prefix conflict resolved (2026-08-18, pi-harness review + Evan):** `garden::` is currently owned by the session-garden **view** door (`doors/session-garden/door.json` → `prefixes: ["garden::"]`) — a deterministic block→json-render presentation door (demo / block / showcase / rangle routes), **not** a mutation loop. Decision: **retire session-garden**, extract only the reusable pieces (block-tree → entry/spec transformation, distinct catalog components, showcase fixtures → `apps/render-reference`), and **reserve `garden::` for the Gardener role** (outline mutation):

- `garden:: <scope>` — metadata inference (`[project::X]`, `[type::Y]`, `external_ref`), sibling dedupe, heading normalization, compaction, reformat (the floatty-backend skill's render-hygiene Layer 2 rules are a ready-made style guide to inject).
- **Preview by default, explicit apply** — `garden:: preview <scope>` proposes, `garden:: apply <run-id>` performs (mirrors the agent-merge authorization gate).
- **The session-garden projection value moves to `render::`** (deterministic, no model): `render:: block [[id]]`, `render:: subtree [[id]]`, `render:: layout article|timeline|weekly [[id]]`, `render:: showcase` — reads the subtree, maps structure into a known json-render layout, validates, projects. Doubles as the **fallback when `render:: agent` is unavailable**.
- `dispatch:: <prompt>` — the reserved prefix implemented as a generic pi door with role parameterized by prompt + tool scope.

Boundary (matches agentic-runtime roles): `render::` = structure → projection (never mutates outline truth); `garden::` = structure → better structure (proposes or performs mutations).

### 5.4 claude.ai phone triggers

`floatty-backend` skill gains a `floatty-agent.sh` script → `POST $FLOATTY_URL/api/v1/agent/runs` (proxy, existing Bearer key). Agents write into the shared outline → results appear on both Macs via CRDT sync. Same path any future webhook/automation uses.

### 5.5 Agent context — deterministic structural projection (LOD)

Truncation is the same epistemic problem as a bad RAG chunk: absence from context reads as absence from reality. The fix is not a clever summarizer — the content is already authored with a latent information hierarchy — it is **deterministic structural projection** that preserves navigation + high-signal blocks and states what it omitted. "Give the model the subway map first, not satellite imagery for all of Ontario."

Three levels, pure read-time shaping in the **Rust projections layer** (`floatty_core::projections`):

| Level | What | ~size (817-block subtree) |
|---|---|---|
| `skeleton` | headings + ancestry only | ~232 |
| `index` | skeleton + markers + semantic-envelope children + bounded log tail + executable pointers | ~250–300 — **default agent context** |
| `full` | entire subtree | 817 |

Rules are semantic, not purely syntactic:
1. preserve structural headings
2. preserve a small number of semantic-envelope children
3. collapse materialized executable-pointer descendants (prefix is role disclosure, not an absolute guarantee — collapse when the node *acts as* a pointer)
4. sample homogeneous streams instead of replaying them
5. **bold-led is a structural hint, not an inclusion guarantee**: bold-led + direct child of a retained structural block → keep; bold-led + deeply nested → omit unless another rule selects it (otherwise the index turns back into the document)
6. emit omission counts + expansion addresses

Wire shape — full UUIDs even when text displays short IDs; `generatedAtSeq` states which outline snapshot the projection describes:

```json
{ "projection": { "kind": "index", "sourceBlockId": "a4022f0e-...", "totalBlocks": 817,
    "shownBlocks": 53, "omittedBlocks": 764, "generatedAtSeq": 12345 }, "nodes": [] }
```

Per-node omission is machine-legible in the block text too: `[projection::structural] [source::[[a4022f0e]]] [shown::265] [total::817] [omitted::552]`, with `expand` addresses.

The system prompt for a projected context is tiny and explicit about the epistemic contract:

> You have been given a structural projection. It preserves navigation and high-signal blocks, but intentionally omits detail. Do not infer that omitted information does not exist. Before making a claim that requires omitted detail, expand the relevant block by its ID.

Fits the existing filesystem-thinking split (incremental navigation vs batch JSON export): the same principle, now applied to context construction. Naming: `projection`, not `view` — `view` already means UI/door rendering.

### 5.6 Librarian — resource + curiosity → cited augmentation (the first agent)

Two primitives compose: the deterministic projection (§5.5) plus a **read-mostly Librarian** that walks outward from a resource and returns *cited* augmentation. This is the ideal first Pi-backed agent: read-only, exercises tool-calling, progressive disclosure, and context selection, and cannot damage the outline.

**Deterministic retrieval stays separate from agent interpretation.** Never put prompts on a query string (`?prompt=`) — logging/escaping/caching/length limits, and GET stops being boring and deterministic. Use an explicit async operation:

```json
POST /api/v1/agent/runs
{ "role": "librarian",
  "resource": { "kind": "block", "id": "a4022f0e-...", "projection": "index" },
  "question": "What else should I know about the Pi harness?",
  "budget": { "maxBlocksRead": 500, "maxExpansions": 20, "maxRuntimeSeconds": 120 } }
→ 202 { "runId": "run_...", "status": "queued" }
```

Completed result keeps `resource` vs `augmentation` split; `submit_augmentation` requires **typed citations** (no uncited prose):

```json
{ "resource": { "projection": { "…": "unchanged deterministic result" } },
  "augmentation": { "answer": "…",
    "findings": [ { "claim": "ACP was deferred to a later transport seam.",
                    "citations": [ { "blockId": "…", "excerpt": "…" } ] } ],
    "expandedBlockIds": ["…"], "searchQueries": ["ACP pi harness"] } }
```

Librarian tool surface is read-only: `get_block`, `read_subtree`, `search`, `backlinks`, `recent`, `resolve_path`, `submit_augmentation` — no mutations, shell, filesystem, coding tools, or ambient extensions. Pi remains the reasoning loop; HTTP determines what you may retrieve, the prompt determines what you're curious about.

**Agent notebooks — working memory that happens to be legible to you** (not telemetry; telemetry stays in OTLP/Pi history). Each role owns a writable notebook subtree — a boring primitive, no magic:

```text
agents::
  # librarian
    ## current            (ephemeral run projection)
    ## recent activity    (compact receipts)
    ## working knowledge  (promoted durable breadcrumbs)
```

- **read**: entire outline · **write**: own notebook subtree only · **edit**: nowhere else. Scoped-mutation machinery in its lowest-risk form.
- Live scratch (`status::running`, `currently::`, `found-so-far::`) → durable completion entry (`status::complete`, `asked::`, `looked-at::`, `found::`, **`relevant-because::`**, `uncertain::`, `result::`). No raw chain-of-thought — operational rationale only.
- `relevant-because::` is the inspectable middle ground between retrieval provenance and hidden reasoning: it gives continuity (next run seeds with the last N entries via `recent_agent_activity(role, limit)` — the anti-"50 First Dates" property) and turns a weird answer into a debuggable one — you can distinguish **retrieval vs ranking vs interpretation vs tooling vs model failure**.
- Promotion lifecycle: `## current` → `## recent activity` → agent proposes `remember:: …` → you accept → `## working knowledge`. Any entry can escape the enclosure by being `[[linked]]` into the ordinary graph.
- This is the **first agent with write permission** — exercising sessions, model routing, progressive retrieval, typed tools, search, provenance, run IDs, and a constrained write, with essentially zero ability to hurt anything important.

**Role convergence — all four roles share one Pi runtime, only two need mutation-adjacent authorization:**

```text
Renderer   resource → projection
Librarian  resource + curiosity → cited context
Merger     base + local + remote → resolution proposal
Gardener   structure → mutation proposal
```

---

## 6. float-box specifics (GEX44)

- **Runtime model classes, not pinned models** — the architecture references `local_fast` / `local_reasoning` / `frontier_fallback`; today's mappings live in config, not the architecture (pi sessions select/change models at runtime):

```toml
[agents.models]          # ops note, not architecture
fast = "qwen3:14b"       # interactive render/merge — tool-calling speed
reasoning = "mistral-small:24b"   # heavy garden/merge batch
fallback = "anthropic/..."        # frontier when open model is not good enough
```

Pi-side Ollama provider registration (pi SDK, read from installed 0.84.2 docs):

```json
{ "providers": { "ollama": {
    "baseUrl": "http://localhost:11434/v1", "api": "openai-completions", "apiKey": "ollama",
    "compat": { "supportsDeveloperRole": false, "supportsReasoningEffort": false },
    "models": [ { "id": "qwen3:14b" }, { "id": "mistral-small:24b" } ] } } }
```

- **Hardware sizing (20 GB GDDR6 ECC, for the config mapping)**: `qwen3:14b` Q4 ~9 GB fits; `mistral-small:24b` Q4 ~14 GB fits; `qwen3:30b-a3b` Q4 ~18 GB is tight with KV cache; 32B+ Q4 does not fit comfortably. Ollama swaps models in VRAM — don't run two big ones concurrently; keep ctx:: on `qwen2.5:7b`. **Caveat (calibration 2026-08-18)**: the earlier "24B proven" impression dates from the CPU-fallback window — performance is unproven on the live GPU until P0 re-measures it.
- **Bind tailnet IP, not `0.0.0.0`** (G5) — float-box has a public IP. Note G5 also means floatty-server binds **only** the tailnet IP, not loopback: the bridge on-box must write to `http://100.78.124.84:8765` (works from the box itself) or floatty-server gains a loopback bind for local calls.
- **ATS/TLS**: current builds ship the ATS exception for plain-HTTP tailnet IPs (G1); long-term path is `tailscale serve` → `https://float-box.<tailnet>.ts.net` — the agent proxy inherits whichever is in place.

---

## 7. Considerations / risks

1. **Node on float-box** — SDK needs Node ≥ 22.19; pin the version (nvm/apt) or compile the bridge to a single bun binary to avoid a Node dependency on the box.
2. **Proxy coupling** — routing agent calls through floatty-server adds a thin API layer (`api/agent.rs`) and couples bridge lifecycle to server; alternative is a direct tailnet port (open question).
3. **Structured output** — in-bridge `render_spec` validation replaces CLI `--json-schema`; do not reintroduce fenced-block extraction heuristics.
4. **Origin/hook discipline** — agent writes via API land as origin `api`/`remote`; hooks fire (outlinks, markers, output-summary); keep origin filtering to avoid sync loops; don't let the bridge write metadata the marker hooks own.
5. **Merge correctness** — ID-based lookups, surgical Y.Doc mutations, snapshot hashes that survive server LWW (quirk audit: `updatedAt` not trustworthy across writers); **re-diff is structural**: every agent mutation carries expectedHash / expectedParentId preconditions (§4.5) so a stale edit is rejected, not merged.
6. **Concurrency** — two Macs + phone can edit while an agent runs; CRDT handles the bytes; the expectedHash guard rejects semantic overwrites (the agent must reread and re-reason); deterministic Tier-1 classification decides what changed, the agent only interprets ambiguous changes.
7. **Session hygiene** — trigger-block delete and explicit cancel abort the run; **client disconnect does NOT** (detached jobs continue on float-box, §4.3); sessions are disposable, run_id backlinked into the outline.
8. **Security** — **role → capabilities is a structural contract** (§4.5): a role cannot call capabilities outside its row; subtree scoping + explicit user authorization for writes; no danger-mode equivalent; shared API key only, bind tailnet.
9. **Version skew** — client↔server already warns (FLO-762); add a bridge protocol version to the proxy.
10. **Fallback** — keep `claude` as `agent_backend` until pi+open-model quality is proven; config already supports the swap shape.
11. **Testing** — merge engine is pure logic (store-first, like `determineKeyAction`); add `__fixtures__/merge-scenarios.json` (shared corpus like `path-grammar.json`); mock the bridge (`MockAgentBridge` returning canned edits) so door tests run without pi; staging harness on float-box.
12. **Cost** — GEX44 already paid; the marginal cost is model pulls + electricity. 14B/24B fit the card (see §6 sizing); quality on the live GPU is unproven until P0 measures it.
13. **ACP maturity** — v2 session/permission/elicitation semantics are locked and safe; the high-fit parts (MCP-over-ACP, proxy-chains, remote transports) are RFDs/drafts — do not build the core path on them. Pin the ACP SDK version and treat the Rust client as the stable seam.
14. **Agent-swap risk** — pi has no native ACP; community `pi-acp` adapters exist but are young. Building our own thin ACP Agent wrapper around the SDK (same cost as bespoke JSON-RPC) keeps control; adopting a community adapter is the fallback if the wrapper proves heavy.
15. **Bridge ownership** — resolved: floatty-server owns the bridge child (AgentBridgeSupervisor); one supervision tree, no orphan state, no second transport (§4.3). A separate systemd unit is explicitly rejected.
16. **Run identity** — `run_id` is floatty-owned durable identity; work-log vocabulary survives any agent swap (§4.3). Establish the four-ID mapping (run_id / acp_session_id / pi_session_id / trigger_block_id) before P1.
17. **Bridge environment isolation** — the pi bridge must not inherit ambient pi extensions/skills/prompts (DefaultResourceLoader discovery): isolated agentDir, non-repo cwd, noTools/"builtin", explicit tools + system prompt, no shell/fs tools for outline-native roles (§4.5).

---

## 8. Rollout phases

1. **P0 — model harness, not a feature** (`render:: agent` is the ideal first consumer: bounded input, deterministic schema, deterministic validator, current claude baseline, visible quality difference, no graph mutation). Build a small corpus:
   - 50 representative render prompts (daily note, hub stack, kanban, meeting notes, standup, table, …)
   - for each: claude baseline, local_fast, local_reasoning
   - measure: **schema pass first try, retries, semantic completeness, catalog misuse, title correctness, latency, tokens, peak VRAM, human preference**
   - Output: routing-tier evidence (which class is good enough for which role) *before* garden:: gets write access.
   Keep claude fallback throughout.
2. **P1 — pi-agent on float-box**: `AgentBridgeSupervisor` in floatty-server spawns the Node bridge (server-owned child, §4.3) over the v1 internal transport (§4.2); `api/agent.rs` proxy + run_id registry; role → capabilities + notebook write. **Integration-branch + ADR territory**: new API surface, new service, new storage — do not land on main.
3. **P1.5 — deterministic structural projection** (Rust projections layer, §5.5): `projection=skeleton|index|full` with omission counts + expansion addresses. No AI — pure read-time shaping, unit-tested against a subtree fixture.
4. **P2 — Librarian (first agent)**: global read + `submit_augmentation` + notebook-subtree write (§5.6) — the read-mostly runtime shakedown that exercises sessions, model routing, progressive retrieval, typed tools, search, provenance, run IDs, and a constrained write before anything mutation-adjacent.
5. **P3 — render:: agent swap** (bounded, schema-validated, claude baseline): `render_spec` tool; `agent_backend = "pi"`, claude retained.
6. **P4 — dumb merge**: door `key` emission, `external_sync` metadata, `mergeEngine.ts`, `merge::` door with diff preview.
7. **P5 — agent merge + gardener doors**: `merge:: --agent`, `garden::` (preview → apply), `dispatch::` on the bridge; work-log + session backlinks.
8. **P6 — phone dispatch**: `floatty-agent.sh` in the floatty-backend skill → `$FLOATTY_URL/api/v1/agent/runs`.

**Sequence principle (from the review):** structural index → Librarian global read → Librarian notebook narrow write → cited augmentation → render agent → smart-merge proposals → Gardener proposals. Deterministic Tier-1 merge (§5.2) proceeds independently and in parallel throughout.

---

## 9. Open questions

- **pi-server (upstream) vs custom bridge** — revisit only if multi-agent orchestration needs grow (resolved: custom bridge, server-owned).
- **Node version pin vs bun-compiled binary** on float-box.
- **Runtime-class model mappings** (`local_fast` / `local_reasoning` / `frontier_fallback`) — decide from P0 harness evidence, not before.
- **P0 mechanics**: pi `-p` with json-schema extension vs direct Ollama for the harness.
- **ACP wire protocol timing**: decided — v1 internal JSONL/localhost-HTTP with ACP-shaped semantics (P1); ACP wire protocol swap deferred until the floatty-owned contracts (run_id, verbs, roles) are proven (§4.2).
- **ACP client home (when the wire swap lands)**: Rust client in floatty-server (crate `agent-client-protocol`) vs TS client in the webview — Rust-in-server is recommended (stdio hop to the bridge, no webview JSON-RPC plumbing).
- **Own ACP Agent wrapper vs community `pi-acp` adapter** on the bridge — effort vs maintenance tradeoff.
- **session-garden retirement** — decided: retire the door, extract reusable block→spec projection + fixtures into `render::`/render-reference, reclaim `garden::` for the Gardener role (§5.3).
- **Notebook promotion UX** — `remember::` acceptance flow (§5.6): where the user approves a `current` → `working knowledge` promotion (door route? command palette? inline confirm?).
- **Projection level default** — confirm `index` is the right default agent context vs `skeleton` for cost-sensitive local models (P1.5 fixture + P0 measurements settle it).
- **Block ops as ACP tool kinds**: custom `_floatty/*` kinds vs mapping to `read`/`search`/`fetch`/`execute` — display-only concern now, tool-filtering concern if proxy-chains lands.
- **Detached-job visibility**: how a disconnected client discovers a finished run (poll run_id status vs push via WS reconnection).

---

## References

- `docs/REMOTE_DEPLOYMENT.md` — float-box authority + thin clients runbook (FLO-762)
- `.claude/rules/render-door-agent.md` — render:: agent source-first discipline, `[title:: …]` contract
- `docs/architecture/AGENT_CREATED_DOOR_BLOCKS.md` — projection contract (content vs output.data)
- `docs/architecture/agentic-runtime/` — Clerk/Librarian/Gardener/Renderer roles, work-log, provenance
- `docs/adrs/ADR-003-agent-role-boundaries.md`, `ADR-004-execution-agents-vs-outline-agents.md`
- `plugins/floatty-backend/` — skill/scripts that honor `remote_server_url` (phone path)
- pi.dev SDK docs: https://pi.dev/docs/latest/sdk
- Agent Client Protocol: https://agentclientprotocol.com — v2 protocol, Rust crate (`agent-client-protocol`), TS SDK (`@agentclientprotocol/sdk`), RFDs (MCP-over-ACP, proxy-chains, session-fork)
