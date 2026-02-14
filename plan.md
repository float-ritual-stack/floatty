# Hierarchical Content Metadata + Agent Enrichment System

## Design Summary

Three interconnected subsystems built on floatty's existing event-driven architecture:

1. **Inherited metadata selector** — A pure function that walks the ancestor chain and merges parent metadata into child blocks additively. Not stored in Y.Doc (derived state, recomputed on access). Exposed as `getEffectiveMetadata(blockId)` in the block store. This is a Redux-selector-style computation, not a ProjectionScheduler projection.

2. **Metadata enrichment agent** — A background ProjectionScheduler projection that batches block changes, sends content to Ollama for analysis, and writes enriched metadata back via `updateBlockMetadata()` with `Origin.Agent`. Detects ambiguous references (marks with `ambiguous-ref` marker), auto-links issue numbers (`#123` → `issue` marker), and adds semantic tags. Maintains its own internal FIFO queue for rate-limited processing across flush cycles.

3. **Agent activity log** — An append-only log recording every agent action (block ID, action type, markers added, timestamp). Stored in **SQLite via Tauri commands** (not Y.Doc — audit data should not create unbounded CRDT tombstones). Rendered in a collapsible sidebar section. Frontend reads via polling (same pattern as ctx:: sidebar).

## Step 0: Classification

| Component | Mental Model | floatty Pattern |
|-----------|-------------|-----------------|
| Inherited metadata | Redux selector / Excel formula | **Selector** (pure function, computed on demand) |
| LLM enrichment | Redux middleware with async side effect | **Projection** (ProjectionScheduler, async batched) |
| Activity log | Audit trail / event sourcing | **Service** (SQLite persistence via Tauri commands) |

## Step 1: Architectural Impact

### Frontend (SolidJS)
- [x] **State**: New `agentStatus` signal + polling-based activity log signal. `getEffectiveMetadata()` is a pure function (no signal/store).
- [x] **Reactivity**: Agent writes metadata via `updateBlockMetadata()` — uses `Origin.Agent`. Existing hooks (`ctxRouterHook`, `outlinksHook`) process creates/updates regardless of origin (except `Origin.Hook`). Agent-written metadata changes only touch the `metadata` field, not `content` — hooks that extract from content will see no content change and skip (no-op). No loop risk.
- [x] **Async**: Agent LLM calls are within ProjectionScheduler (already has error isolation per projection). Individual block enrichment wrapped in try/catch.
- [x] **HMR**: Agent projection and internal queue cleaned up via `import.meta.hot.dispose()`

### Y.Doc / CRDT
- [x] **Schema change**: None. Uses existing `metadata.markers` with new marker type strings (`ambiguous-ref`, `issue`). No new Y.Doc maps or arrays.
- [x] **Origin tagging**: All agent writes use `'agent'` origin string. Must also filter OUT `Origin.Agent` in the enrichment projection to prevent self-loop.
- [x] **Observer**: No new observers. Uses existing EventBus → ProjectionScheduler pipeline.

### Rust Backend
- [x] **New Tauri commands**: `get_agent_log`, `clear_agent_log` (thin wrappers around SQLite service)
- [x] **New service**: `src-tauri/src/services/agent_log.rs` — SQLite table for activity log
- [x] **Origin.Agent already exists** in Rust (`src-tauri/floatty-core/src/origin.rs:47`) with proper `triggers_metadata_hooks()` returning true

### Terminal / PTY
- Not affected

## Step 2: Six Patterns Checklist

| Pattern | Applies? | Mitigation |
|---------|----------|------------|
| 1. State transitions (flags) | Yes — agent `isProcessing` flag | Use try/finally in process loop |
| 2. TypedArray/Buffer | No | — |
| 3. Unbounded collections | Yes — activity log grows, agent internal queue | SQLite log: auto-prune entries >72h old (matches ctx:: `max_age_hours`). Queue: cap at 100 pending block IDs, FIFO eviction. |
| 4. Fire-and-forget async | Yes — LLM calls in ProjectionScheduler | ProjectionScheduler already has error isolation + logging. Individual enrichment calls wrapped in try/catch. |
| 5. Silent degradation | Yes — Ollama offline = no enrichment | Log warning, set `agentStatus` signal to 'offline', continue without enrichment. Resume on next successful call. |
| 6. HMR singletons | Yes — agent projection registration, internal queue | Dispose via `import.meta.hot.dispose()` — unregister projection, clear queue. |

## Step 3: Symmetry / Drift Audit

| Pattern being changed | Sibling locations | Included in plan? |
|-----------------------|-------------------|-------------------|
| Origin constants (adding `Agent` to TS) | `src/lib/events/types.ts:27-46` — all origins defined here | Yes — single location, add `Agent: 'agent'` |
| Hook origin filtering | `ctxRouterHook.ts:75`, `outlinksHook.ts:53` — both check `=== Origin.Hook` | Safe — these hooks skip only `Origin.Hook`. Agent writes with `Origin.Agent` but only touches `metadata` field. The hooks only extract from `content` field and compare markers/outlinks before writing — if content unchanged, no-op. No loop. |
| `updateBlockMetadata()` callers | `ctxRouterHook.ts:99`, `outlinksHook.ts:77` — both use `'hook'` origin | Agent uses `'agent'` origin — different path, no conflict |
| ProjectionScheduler registrations | `blockProjectionScheduler` singleton, no registered projections in production code yet | Adding first production projection. Pattern is established in tests. |
| SQLite table creation | `db.rs` has `init_db()` with `ctx_markers` and `file_positions` tables | Adding `agent_activity_log` table in same pattern. Must add migration to `init_db()`. |
| Tauri command patterns | `commands/ctx.rs` for `get_ctx_markers` polling pattern | Agent log commands follow identical pattern. |

## Step 4: Data Flow

```
Block created/updated (User origin)
    │
    ├──► EventBus (sync) ──► ctxRouterHook (extracts markers from content)
    │                    ──► outlinksHook (extracts outlinks from content)
    │
    └──► ProjectionScheduler (async, 2s batch)
              │
              ▼
         agentEnrichmentProjection
              │
              ├── 1. Filter: creates/updates only, NOT from Origin.Hook or Origin.Agent
              ├── 2. Add block IDs to internal queue (dedup by ID, cap 100)
              ├── 3. Splice up to 5 blocks from queue front
              ├── 4. For each block:
              │     ├── getBlock() — skip if undefined (deleted)
              │     ├── computeEffectiveMetadata() — get inherited context
              │     ├── buildEnrichmentPrompt(content, effectiveMetadata)
              │     ├── invoke('execute_ai_conversation', {messages, system})
              │     ├── parseAgentResponse(llmOutput) — extract markers
              │     ├── Deduplicate vs existing markers — skip if no new markers
              │     ├── updateBlockMetadata(id, {markers: merged}, 'agent')
              │     └── Log activity entry via invoke('log_agent_activity', {...})
              │
              └── 5. Update agentStatus signal (active/offline/idle)
```

**Failure points:**
- Ollama offline → catch error, set status to 'offline', skip entire batch, queue preserved for next cycle
- LLM returns invalid JSON → catch parse error, log as 'error' activity, skip block
- Block deleted between queue and process → `getBlock()` returns undefined, skip
- Queue overflow (>100 pending) → oldest entries evicted (FIFO)

**Async boundaries:**
- EventBus → ProjectionScheduler (queue, 2s flush interval)
- ProjectionScheduler → Tauri invoke (IPC, async)
- Tauri → Ollama (HTTP, async)

## Step 5: Test Strategy

- [x] **Unit: `computeEffectiveMetadata()`** — Pure function. Tests: (a) single block with markers, (b) parent→child inheritance, (c) 3-level chain with additive merge, (d) dedup by type+value, (e) outlinks NOT inherited, (f) empty metadata, (g) missing ancestor blocks
- [x] **Unit: `buildEnrichmentPrompt()`** — Pure function. Tests: prompt includes content, includes inherited markers context, handles empty metadata
- [x] **Unit: `parseAgentResponse()`** — Pure function. Tests: valid JSON, malformed JSON, empty markers, extra fields ignored, missing fields default
- [x] **Unit: `deduplicateMarkers()`** — Pure function. Tests: existing markers preserved, new markers added, duplicates skipped
- [x] **Integration: Agent origin filtering** — Verify agent-written metadata doesn't trigger the enrichment projection again (filtered by `Origin.Agent`)
- [x] **Rust: Agent log CRUD** — Test insert, query, auto-prune
- [x] **Manual: End-to-end** — Create blocks with `#123` references and ambiguous "the server" mentions, verify agent adds `issue` and `ambiguous-ref` markers after ~4s (2s batch + LLM latency)

## Step 6: Risks & Open Questions

1. **LLM latency** — Ollama calls take 1-5s per block. With 5 blocks/cycle, worst case is 25s processing time blocking the projection flush. **Mitigation**: Process blocks sequentially within a cycle (not parallel) to avoid overloading Ollama. Queue ensures no blocks are lost.
2. **LLM output reliability** — JSON parsing from LLM output can fail. **Mitigation**: Strict schema validation with fallback to empty markers. Log parse failures as activity errors.
3. **Inherited metadata staleness** — `getEffectiveMetadata()` walks ancestors on every call. For deep trees (10+ levels), this could be slow in hot paths. **Mitigation**: Only called in agent enrichment context (not render path). Memoization deferred to Phase 2 optimization if profiling shows need.

---

## Implementation Plan

### Phase 1: Origin.Agent in TypeScript + Effective Metadata Selector

**Files to modify:**
- `src/lib/events/types.ts` — Add `Agent: 'agent'` to Origin const

**New files:**
- `src/lib/metadataInheritance.ts` — Pure function `computeEffectiveMetadata(blockId, getBlock)` that walks ancestors and merges markers additively
- `src/lib/metadataInheritance.test.ts` — Unit tests for inheritance logic

**Logic for `computeEffectiveMetadata`:**
```typescript
import type { Block } from './blockTypes';
import type { BlockMetadata } from '../generated/BlockMetadata';
import type { Marker } from '../generated/Marker';

/**
 * Compute effective metadata for a block by walking its ancestor chain
 * and merging markers additively. Markers are deduped by type+value.
 *
 * Outlinks, isStub, and extractedAt are NOT inherited (block-local only).
 */
export function computeEffectiveMetadata(
  blockId: string,
  getBlock: (id: string) => Block | undefined
): BlockMetadata {
  // Walk ancestor chain: [root, ..., parent, self]
  const chain: Block[] = [];
  let current = getBlock(blockId);
  while (current) {
    chain.unshift(current);
    current = current.parentId ? getBlock(current.parentId) : undefined;
  }

  // Merge markers additively — dedup by markerType::value
  const seen = new Map<string, Marker>();
  for (const block of chain) {
    for (const marker of block.metadata?.markers ?? []) {
      const key = `${marker.markerType}::${marker.value ?? ''}`;
      seen.set(key, marker);
    }
  }

  // Block-local fields from self only
  const self = getBlock(blockId);
  return {
    markers: Array.from(seen.values()),
    outlinks: self?.metadata?.outlinks ?? [],
    isStub: self?.metadata?.isStub ?? false,
    extractedAt: self?.metadata?.extractedAt ?? null,
  };
}
```

### Phase 2: Agent Enrichment Projection

**New files:**
- `src/lib/agent/agentTypes.ts` — Type definitions for agent config, activity log entries, enrichment results
- `src/lib/agent/agentEnrichmentProjection.ts` — ProjectionScheduler registration, internal queue, LLM prompt building, response parsing, metadata writing
- `src/lib/agent/agentEnrichmentProjection.test.ts` — Unit tests for `buildEnrichmentPrompt()`, `parseAgentResponse()`, deduplication logic
- `src/lib/agent/index.ts` — Re-export registration function

**Files to modify:**
- `src/lib/handlers/index.ts` — Import and call `registerAgentEnrichment()` in `registerHandlers()`

**Key design decisions:**

1. **Prompt structure** — System prompt instructs LLM to analyze block content and return JSON:
```
You are a metadata enrichment agent for an outliner application.
Analyze the block content and its inherited context. Return a JSON object
with markers to add. Available marker types:
- "issue": value is the issue number (e.g., "123" for #123, "PROJ-456" for PROJ-456)
- "ambiguous-ref": value is the ambiguous phrase (e.g., "the server", "that bug")

Only add markers for things you're confident about. Return empty markers array if nothing to add.
Respond with ONLY valid JSON, no markdown fencing.
```

Response schema:
```json
{ "markers": [{ "markerType": "issue", "value": "123" }] }
```

2. **Internal queue** — Agent maintains its own `blockIdQueue: string[]` that persists across flush cycles. New block IDs from events are appended (deduped). Up to 5 spliced per cycle.

3. **Deduplication before write** — Agent computes set difference between proposed markers and existing `block.metadata.markers`. Only writes if there are genuinely new markers to add.

4. **Origin filtering** — Projection filter excludes both `Origin.Hook` AND `Origin.Agent`:
```typescript
EventFilters.all(
  EventFilters.any(EventFilters.creates(), EventFilters.updates()),
  EventFilters.notFromOrigin(Origin.Hook),
  EventFilters.notFromOrigin(Origin.Agent),
)
```

### Phase 3: Activity Log (SQLite-backed)

**New files (Rust):**
- `src-tauri/src/services/agent_log.rs` — SQLite operations: create table, insert entry, query recent, prune old
- `src-tauri/src/commands/agent_log.rs` — Tauri command wrappers: `get_agent_log`, `clear_agent_log`

**New files (TypeScript):**
- `src/lib/agent/agentActivityLog.ts` — SolidJS signal-based log store, polling via Tauri commands (2s interval, same as ctx:: sidebar pattern)
- `src/lib/agent/agentActivityLog.test.ts` — Tests for log operations

**Files to modify (Rust):**
- `src-tauri/src/commands/mod.rs` — Re-export new commands
- `src-tauri/src/lib.rs` — Register new commands with Tauri, initialize agent_log table in setup
- `src-tauri/src/db.rs` — Add `agent_activity_log` table to `init_db()` migration

**Files to modify (TypeScript):**
- `src/components/ContextSidebar.tsx` — Add collapsible "Agent Activity" section

**Activity log entry shape:**
```typescript
interface AgentActivityEntry {
  id: string;           // UUID
  timestamp: number;    // ms since epoch
  blockId: string;      // Target block
  action: 'enrich' | 'skip' | 'error';
  addedMarkers?: Marker[];    // What was added (for 'enrich')
  reason?: string;            // Why (for 'skip' and 'error')
}
```

**SQLite schema:**
```sql
CREATE TABLE IF NOT EXISTS agent_activity_log (
  id TEXT PRIMARY KEY,
  timestamp INTEGER NOT NULL,
  block_id TEXT NOT NULL,
  action TEXT NOT NULL,
  added_markers TEXT,  -- JSON
  reason TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
);

CREATE INDEX IF NOT EXISTS idx_agent_log_timestamp ON agent_activity_log(timestamp);
```

**Auto-prune**: Delete entries older than 72 hours on each insert (matches `max_age_hours` pattern from ctx:: config).

### Phase 4: Registration & Integration

**Files to modify:**
- `src/lib/handlers/index.ts` — Call `registerAgentEnrichment()` in `registerHandlers()`
- `src/components/ContextSidebar.tsx` — Render agent activity log section with status indicator

**Agent status indicator**: Small dot next to "Agent Activity" section header:
- Green (`--color-ansi-green`): Agent active, last enrichment succeeded
- Yellow (`--color-ansi-yellow`): Ollama offline or last call failed
- Gray (`--color-ansi-bright-black`): Agent idle (no pending blocks)

---

## Suggested Implementation Order

1. **Phase 1** first — Foundation (Origin.Agent + effective metadata selector). No LLM dependency, fully testable with unit tests.
2. **Phase 3 Rust side** next — Agent log SQLite table + Tauri commands. Independent of frontend agent code.
3. **Phase 2** next — Agent enrichment projection. Depends on Phase 1 for Origin and Phase 3 for logging.
4. **Phase 3 TS side + Phase 4** last — Activity log UI + wire everything together.

## Risk Assessment: **Medium**

- Low risk on Phase 1 (pure functions, no side effects)
- Low risk on Phase 3 Rust (follows established ctx:: marker pattern exactly)
- Medium risk on Phase 2 (LLM reliability, async error handling, cross-cycle queue management)
- Low risk on Phase 4 (standard SolidJS patterns, polling-based UI)
