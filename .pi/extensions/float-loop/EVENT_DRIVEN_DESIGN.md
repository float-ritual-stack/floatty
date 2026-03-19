# Float Loop: Event-Driven Command Invocation

## The Core Insight

> "Don't make Evan remember. Make the workflow trigger at the right moment."

This document maps every float-loop command to specific pi extension events, transforming manual invocation into automatic workflow enforcement.

---

## Trigger Map

| Command | Current | Event Trigger | Detection Logic | Action |
|---------|---------|---------------|-----------------|--------|
| **classify** | Manual `/classify` | `tool_call` on write to new file path | File doesn't exist in git index OR path matches `src/lib/handlers/`, `hooks/`, `projections/` | **NUDGE**: "New file detected. Classify this feature?" + inject Five Questions into context |
| **arch-review** | Manual `/arch-review` | `tool_call` on write to architecture paths | Path matches: `src/lib/handlers/`, `src/lib/hooks/`, `src/lib/projections/`, `src-tauri/*/src/*.rs` | **NUDGE**: Light check - inject "Does this align with PHILOSOPHY.md patterns?" |
| **sweep** | Manual `/sweep` | `agent_end` after code changes | `edit` or `write` tools used in session | **AUTO-RUN**: Execute sweep on changed files, report findings. Fast enough to not block. |
| **gate** | Manual `/gate` | Part of `/handoff` flow | When handoff is initiated | **BLOCK**: Gate runs first. Handoff blocked until pass or explicit override. |
| **gap** | Manual `/gap` | LLM tool call | Agent discovers gap, calls `float_loop_gap` tool | **SILENT**: Tool writes to WORK_UNITS.md, notifies user, continues. No break in flow. |
| **pr-check** | Manual `/pr-check` | Explicit command | User runs `/pr-check` | **BLOCK**: Pre-flight validation. Must pass or override before PR. |
| **bug** | Manual `/bug` | Explicit command | User runs `/bug` | **NUDGE**: Structured investigation guide. |

---

## Context Injection Spec (`before_agent_start`)

When a track is active, inject ~200 tokens of context automatically:

```typescript
pi.on("before_agent_start", async (event, ctx) => {
  const track = getActiveTrack();
  if (!track) return;

  // Read minimal state
  const state = await readTrackState(track.name); // STATE.md
  const lastHandoff = await readLastHandoff(track.name);
  const gaps = await readDiscoveredGaps(track.name);
  
  // Build context block (~200 tokens)
  const contextBlock = buildContextBlock({
    track: track.name,
    currentUnit: state.currentUnit,
    unitStatus: state.unitStatus, // entry/implementation/exit
    lastHandoffSummary: lastHandoff?.whatWasDone?.slice(0, 100),
    activeGaps: gaps.filter(g => g.status === 'blocking').map(g => g.title),
    failureModes: await readRelevantFailureModes(track.name, state.currentUnit),
  });

  return {
    message: {
      customType: "float-loop-context",
      content: contextBlock,
      display: false, // Hidden from user
    },
  };
});
```

### Context Block Format

```markdown
[FLOAT LOOP: search-work | Unit 2.1 | In Progress]

Current: Enumeration endpoints (API design)
Last: Fixed metadata round-trip, parser coverage (Unit 0.1-0.3)
Blocking gaps: None
Failure modes to watch: API design consistency

Protocol: Entry checklist ☐→ Implementation → Exit checklist → Handoff
```

### What's NOT Injected (Token Budget)

- ❌ Full ARCHITECTURE.md (too long)
- ❌ Full WORK_UNITS.md (too long)
- ❌ Historical handoffs (only latest)
- ❌ Full FAILURE_MODES.md (only relevant ones)

### What IS Injected

- ✅ Current unit name + scope + status
- ✅ Last handoff summary (3-4 lines max)
- ✅ Active blocking gaps (titles only)
- ✅ Relevant failure modes (filtered by unit type)

---

## LLM-Callable Tools

Register these as tools the agent can invoke during work:

### `float_loop_classify`

```typescript
pi.registerTool({
  name: "float_loop_classify",
  description: "Classify a feature using the Five Questions framework",
  parameters: Type.Object({
    featureDescription: Type.String(),
    whoInitiates: StringEnum(["user", "system"] as const),
    ownsBlock: Type.Boolean(),
    whenRuns: StringEnum(["explicit", "pipeline", "observer"] as const),
    criticalPath: Type.Boolean(),
    needsOtherHooks: Type.Boolean(),
  }),
  async execute(id, params, signal, onUpdate, ctx) {
    // Apply Five Questions logic
    const classification = classifyFeature(params);
    
    // Return with guidance
    return {
      content: [{ 
        type: "text", 
        text: `${classification.type}: ${classification.rationale}\n\nNext: ${classification.nextSteps}` 
      }],
      details: { classification },
    };
  },
});
```

**When agent calls this:**
- Planning to implement a new feature
- Unsure where to place code
- Wants validation of approach

**UI feedback:** Brief notification, no blocking

---

### `float_loop_gap`

```typescript
pi.registerTool({
  name: "float_loop_gap",
  description: "Document a discovered gap in architecture or requirements",
  parameters: Type.Object({
    description: Type.String(),
    impact: StringEnum(["low", "medium", "high", "blocking"] as const),
    discoveredDuring: Type.String(), // Unit X.Y or "exploration"
    suggestedResolution: Type.Optional(Type.String()),
  }),
  async execute(id, params, signal, onUpdate, ctx) {
    const track = getActiveTrack();
    if (!track) {
      throw new Error("No active track. Use /track <name> first.");
    }

    // Write to WORK_UNITS.md Discovered Gaps section
    await appendGapToWorkUnits(track.name, params);
    
    // Notify user (non-blocking)
    ctx.ui.notify(
      `Gap documented: ${params.description.slice(0, 50)}... (${params.impact})`,
      params.impact === 'blocking' ? 'warning' : 'info'
    );

    return {
      content: [{ type: "text", text: `Gap documented in ${track.name}/WORK_UNITS.md` }],
      details: { track: track.name, gap: params },
    };
  },
});
```

**When agent calls this:**
- Discovers missing functionality mid-implementation
- Finds that current approach won't work
- Identifies prerequisite work

**UI feedback:** Notification only, workflow continues

---

### `float_loop_arch_check`

```typescript
pi.registerTool({
  name: "float_loop_arch_check",
  description: "Validate approach against PHILOSOPHY.md patterns",
  parameters: Type.Object({
    approach: Type.String(),
    filesInvolved: Type.Array(Type.String()),
  }),
  async execute(id, params, signal, onUpdate, ctx) {
    // Check against known patterns
    const concerns = await checkArchitectureAlignment(params);
    
    if (concerns.length === 0) {
      return {
        content: [{ type: "text", text: "✓ Approach aligns with established patterns" }],
        details: { aligned: true },
      };
    }

    return {
      content: [{ 
        type: "text", 
        text: `⚠ Potential concerns:\n${concerns.map(c => `- ${c}`).join('\n')}\n\nContinue or adjust?` 
      }],
      details: { aligned: false, concerns },
    };
  },
});
```

**When agent calls this:**
- Before creating new handler/hook/projection
- Wants validation of architectural approach
- About to diverge from existing patterns

---

## Session Tracking Spec

Track per session for validation:

```typescript
interface SessionWorkLog {
  trackName: string | null;
  unitId: string | null;
  
  // Activity tracking
  filesRead: Set<string>;
  filesWritten: Set<string>;
  filesEdited: Set<string>;
  bashCommands: { command: string; timestamp: number }[];
  
  // Protocol tracking
  entryChecklistComplete: boolean;
  sweepRun: boolean;
  testsRun: boolean;
  handoffWritten: boolean;
  gatePassed: boolean;
  
  // Derived
  hasCodeChanges: boolean; // write or edit used
  sessionType: 'planning' | 'exploration' | 'unit_work' | 'mixed';
}

// Track in extension state
let sessionLog: SessionWorkLog = {
  trackName: null,
  unitId: null,
  filesRead: new Set(),
  filesWritten: new Set(),
  filesEdited: new Set(),
  bashCommands: [],
  entryChecklistComplete: false,
  sweepRun: false,
  testsRun: false,
  handoffWritten: false,
  gatePassed: false,
  hasCodeChanges: false,
  sessionType: 'planning',
};
```

### Event Tracking

```typescript
// Track file operations
pi.on("tool_call", async (event, ctx) => {
  if (event.toolName === 'read') {
    sessionLog.filesRead.add(event.input.path);
  } else if (event.toolName === 'write') {
    sessionLog.filesWritten.add(event.input.path);
    sessionLog.hasCodeChanges = true;
    
    // Trigger classify nudge for new files
    if (isNewFile(event.input.path)) {
      await nudgeClassify(ctx, event.input.path);
    }
  } else if (event.toolName === 'edit') {
    sessionLog.filesEdited.add(event.input.path);
    sessionLog.hasCodeChanges = true;
  } else if (event.toolName === 'bash') {
    sessionLog.bashCommands.push({
      command: event.input.command,
      timestamp: Date.now(),
    });
    
    // Detect test runs
    if (isTestCommand(event.input.command)) {
      sessionLog.testsRun = true;
    }
  }
});

// Auto-run sweep on agent_end if code changed
pi.on("agent_end", async (event, ctx) => {
  if (sessionLog.hasCodeChanges && !sessionLog.sweepRun) {
    const findings = await runSweep([...sessionLog.filesWritten, ...sessionLog.filesEdited]);
    if (findings.length > 0) {
      ctx.ui.notify(`Sweep found ${findings.length} issues. Run /sweep for details.`, 'warning');
    }
    sessionLog.sweepRun = true;
  }
});
```

---

## Notification Hierarchy

### BLOCK (Require Acknowledgment)

User must interact to proceed:

| Trigger | Condition | UI |
|---------|-----------|-----|
| `/handoff` initiated | Gate check fails | Overlay with checklist, "Override?" button |
| `/pr-check` | Tests fail or sweep finds critical | Confirm dialog with details |
| `write` to new file | Entry checklist incomplete | Confirm: "Entry incomplete. Continue?" |

### NUDGE (Visible but Non-Blocking)

Notification only, user can ignore:

| Trigger | Condition | UI |
|---------|-----------|-----|
| New file created | File in handlers/hooks/projections | Status bar: "Classify? (Ctrl+C)" |
| Architecture path write | First write to pattern-heavy code | Notification: "Aligns with PHILOSOPHY?" |
| Agent_end with code changes | Sweep not yet run | Notification: "Sweep recommended" |
| Unit work complete | No handoff written | Notification: "Write handoff? (/handoff)" |

### SILENT (Inject Context, No UI)

User doesn't see it happening:

| Trigger | Action |
|---------|--------|
| `before_agent_start` | Inject track context block |
| `session_start` | Restore active track state |
| `float_loop_gap` tool called | Write to WORK_UNITS.md, brief notification |
| `float_loop_classify` tool called | Return classification, no notification |

---

## Implementation Priority

### Phase 1: Foundation (MVP)

- [x] `/track` command with bootstrap
- [x] Status bar integration
- [x] Session persistence
- [ ] `before_agent_start` context injection
- [ ] Basic session tracking (files, changes)

### Phase 2: Auto-Triggers

- [ ] `agent_end` → auto-sweep if code changed
- [ ] `tool_call` on new file → classify nudge
- [ ] `tool_call` on arch paths → arch-review nudge
- [ ] `/handoff` → gate block

### Phase 3: LLM Tools

- [ ] `float_loop_gap` tool
- [ ] `float_loop_classify` tool
- [ ] `float_loop_arch_check` tool

### Phase 4: Advanced Validation

- [ ] Drift detection (git vs STATE.md)
- [ ] Entry checklist enforcement
- [ ] Exit validation prompts
- [ ] Smart nudges (don't nudge if already done)

---

## Migration from Claude Code

### What Changes

| Aspect | Claude Code | Pi Extension |
|--------|-------------|--------------|
| **Invocation** | Evan remembers to type `/classify` | Triggered on new file write |
| **Context** | Manual STATE.md reads | Auto-injected on every turn |
| **Sweep** | Manual `/sweep` | Auto-runs on agent_end if code changed |
| **Gap** | Manual `/gap` | LLM tool call during work |
| **Gate** | Manual `/gate` | Auto-runs on handoff initiation |
| **Persistence** | Files only | Files + session + event tracking |

### What Stays Identical

- **Content**: Five Questions, bug patterns, gate checklist — all reusable
- **File structure**: `.float/work/track/*.md` unchanged
- **Handoff format**: Same template, same location
- **Philosophy**: Externalized state, zero-context restart

### Lift and Shift

From existing commands:
- `sweep.md` → Pattern definitions (keep verbatim)
- `classify.md` → Five Questions (keep verbatim)
- `gate.md` → Checklist items (keep verbatim)
- `gap.md` → Gap documentation format (keep verbatim)

Change: **Delivery mechanism**, not content.

---

## Claude Code Limitations (For Comparison)

Claude Code lacks pi's extension surface. Best-effort approximations:

| Pi Trigger | Claude Code Approximation | Reliability |
|------------|---------------------------|-------------|
| `before_agent_start` | CLAUDE.md instruction to read STATE.md | Medium (agent may forget) |
| `tool_call` hooks | Custom instructions in commands | Low (only when command runs) |
| `agent_end` prompts | Stop hooks (only on explicit stop) | Low (misses implicit ends) |
| Session persistence | Files only | Medium (no runtime state) |
| Auto-sweep | Manual reminder in CLAUDE.md | Low |

**Verdict**: Claude Code can approximate ~40% of this design via prompt engineering. Pi's event hooks enable 100%.

---

## Configuration

User preferences (stored in `.pi/extensions/float-loop/config.json`):

```json
{
  "autoSweep": true,
  "sweepOnAgentEnd": true,
  "classifyNudge": true,
  "archReviewNudge": true,
  "gateEnforcement": "block", // "block" | "warn" | "off"
  "contextInjection": true,
  "maxContextTokens": 200,
  "entryChecklistEnforcement": "warn" // "block" | "warn" | "off"
}
```

Commands to adjust:
- `/float-config auto-sweep on/off`
- `/float-config gate-enforcement block/warn/off`
- `/float-config show` (display current)

---

## Next Steps

1. Implement context injection (`before_agent_start`)
2. Add session tracking (file operations, code changes)
3. Implement auto-sweep on `agent_end`
4. Add classify nudge on new file write
5. Register `float_loop_gap` tool
6. Add gate integration to `/handoff`

The goal: **Evan focuses on the work, the system handles the protocol.**
