# Float Loop Extension for pi

A pi-native implementation of the float-loop work tracking methodology, replacing the ad-hoc Claude Code command system with integrated extension capabilities.

## Core Philosophy

> "Multiplayer isn't human + human, multiplayer is human + executor."

The float-loop is a **work orchestration pattern** that externalizes state, enables zero-context restart, and validates at each phase boundary. Unlike Claude Code's implicit todo system, float-loop makes work visible, verifiable, and resumable.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  PI TUI LAYER (UI Integration)                                  │
├─────────────────────────────────────────────────────────────────┤
│  Status Bar: "🔥 search-work │ Unit 2.1 │ 5/7 complete"         │
│  Widget: Active unit context + entry checklist                  │
│  Commands: /track, /unit, /handoff, /sweep, /gate               │
│  Overlay: Track selector, unit progress, handoff viewer         │
└─────────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────────┐
│  FLOAT LOOP CORE (Extension State Machine)                      │
├─────────────────────────────────────────────────────────────────┤
│  TrackRegistry: Map<trackName, Track>                           │
│  ├─ Track: { state, units, handoffs, config }                   │
│  ├─ Unit: { id, status, entry, implementation, exit }           │
│  └─ Handoff: { unit, status, findings, decisions, nextStart }   │
│                                                                 │
│  SessionPersistence: pi.appendEntry() for state                 │
│  FilePersistence: .float/work/<track>/*.md                      │
└─────────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────────┐
│  VALIDATION LAYER (Event Hooks)                                 │
├─────────────────────────────────────────────────────────────────┤
│  tool_call: Block if no active handoff on write                 │
│  agent_end: Prompt for handoff if unit work done                │
│  before_agent_start: Inject unit context                        │
│  session_start: Restore active track from session               │
└─────────────────────────────────────────────────────────────────┘
```

## Commands

### `/track <name>` - Enter or bootstrap a work track
```
/track search-work

If track exists:
  → Read STATE.md, show current position
  → Display unit index in widget
  → Offer: "Continue current unit" / "Start next unit" / "Review handoffs"

If track new:
  → Prompt: "Track size? (small/medium/large)"
  → Bootstrap: STATE.md, WORK_UNITS.md, handoffs/
  → For medium/large: ARCHITECTURE.md, AGENT_PROMPT.md
  → Open editor for initial context
```

### `/unit` - Unit operations
```
/unit next          # Start next incomplete unit
/unit current       # Show current unit details
/unit list          # Show all units
/unit handoff       # Write handoff for current unit
/unit gap "desc"    # Document discovered gap
```

### `/handoff` - View and write handoffs
```
/handoff                    # List handoffs for current track
/handoff read <unit>        # Read specific handoff
/handoff write              # Create handoff from template
```

### `/sweep` - Bug pattern validation
```
/sweep              # Run on current changed files
/sweep all          # Run on entire codebase
/sweep <path>       # Run on specific path

Uses: .claude/rules/ bug patterns (adapted to pi)
```

### `/gate` - Phase gate checklist
```
/gate               # Run full gate checklist before PR

Validates:
- Tests pass
- No lint errors
- Runtime behavior verified (not just unit tests)
- Decisions documented
- Handoff complete
```

### `/classify` - Feature classification
```
/classify "terminal multiplexer"
→ Suggests: Handler/Hook/Projection/Renderer
→ Based on PHILOSOPHY.md patterns
```

## UI Components

### Status Bar Integration
```typescript
// Always visible when track active
ctx.ui.setStatus("float-loop", theme.fg("accent", "🔥 search-work │ Unit 2.1 │ 5/7"));
```

### Active Unit Widget (above editor)
```
┌─ Unit 2.1: Enumeration Endpoints ─────────────────────────────┐
│ Status: In Progress                                           │
│                                                               │
│ Entry Checklist:                                              │
│  ☑ Read previous handoff                                      │
│  ☑ Verify preconditions                                       │
│  ☐ Run /classify                                              │
│                                                               │
│ Exit Checklist (before marking done):                         │
│  ☐ Tests pass                                                 │
│  ☐ Runtime verified                                           │
│  ☐ Run /sweep                                                 │
│  ☐ Handoff written                                            │
└───────────────────────────────────────────────────────────────┘
```

### Track Selector Overlay
```typescript
await ctx.ui.custom((tui, theme, kb, done) => {
  // List all tracks from .float/work/*/
  // Show: track name, current unit, last activity
  // Actions: select, archive, new track
}, { overlay: true });
```

### Handoff Viewer
Custom message renderer for handoff documents:
```typescript
pi.registerMessageRenderer("float-loop-handoff", (message, opts, theme) => {
  // Render handoff with syntax highlighting
  // Collapsible sections for findings/decisions
  // Links to related files
});
```

## Event Hooks

### `session_start` - Restore track state
```typescript
pi.on("session_start", async (_event, ctx) => {
  // Check for active track in session entries
  const activeTrack = findActiveTrack(ctx.sessionManager);
  if (activeTrack) {
    // Restore UI state
    updateStatusBar(activeTrack);
    showUnitWidget(activeTrack.currentUnit);
    
    // Check for drift (git log vs STATE.md)
    const drift = await detectDrift(activeTrack);
    if (drift) {
      ctx.ui.notify(`Drift detected: ${drift.description}`, "warning");
    }
  }
});
```

### `before_agent_start` - Inject unit context
```typescript
pi.on("before_agent_start", async (event, ctx) => {
  const track = getActiveTrack();
  if (!track) return;
  
  const unit = track.currentUnit;
  return {
    message: {
      customType: "float-loop-context",
      content: buildUnitPrompt(unit, track),
      display: false, // Hidden from user, sent to LLM
    },
  };
});
```

### `tool_call` - Validate before destructive operations
```typescript
pi.on("tool_call", async (event, ctx) => {
  const track = getActiveTrack();
  if (!track) return;
  
  // If about to write code without active unit context
  if (isWriteTool(event) && !track.currentUnit?.entryComplete) {
    const ok = await ctx.ui.confirm(
      "No active unit entry",
      "You haven't completed the entry checklist. Continue anyway?"
    );
    if (!ok) return { block: true, reason: "Entry checklist incomplete" };
  }
});
```

### `agent_end` - Prompt for handoff
```typescript
pi.on("agent_end", async (event, ctx) => {
  const track = getActiveTrack();
  if (!track) return;
  
  // If unit work was done (write/edit tools used)
  if (track.currentUnit?.hasWork && !track.currentUnit?.handoffWritten) {
    const choice = await ctx.ui.select("Unit work complete. Next?", [
      "Write handoff and commit",
      "Continue working",
      "Pause - write partial handoff",
    ]);
    
    if (choice?.includes("handoff")) {
      await createHandoff(track.currentUnit);
    }
  }
});
```

## Custom Tools

### `float_loop_bootstrap`
Creates a new track with appropriate scaffolding based on size assessment.

```typescript
pi.registerTool({
  name: "float_loop_bootstrap",
  description: "Bootstrap a new work track",
  parameters: Type.Object({
    trackName: Type.String(),
    size: StringEnum(["small", "medium", "large"] as const),
    goal: Type.String(),
  }),
  async execute(id, params, signal, onUpdate, ctx) {
    // Create .float/work/<track>/ structure
    // Generate STATE.md, WORK_UNITS.md
    // For medium/large: ARCHITECTURE.md, AGENT_PROMPT.md
    return { content: [{ type: "text", text: "Track bootstrapped" }] };
  },
});
```

### `float_loop_sweep`
Runs bug pattern detection on changed files.

```typescript
pi.registerTool({
  name: "float_loop_sweep",
  description: "Check code for bug patterns",
  parameters: Type.Object({
    scope: StringEnum(["changed", "all", "path"] as const),
    path: Type.Optional(Type.String()),
  }),
  async execute(id, params, signal, onUpdate, ctx) {
    // Read .claude/rules/ patterns
    // Apply to target files
    // Return findings with severity
  },
});
```

### `float_loop_gap`
Documents a discovered gap and assesses impact on work units.

```typescript
pi.registerTool({
  name: "float_loop_gap",
  description: "Document a discovered gap",
  parameters: Type.Object({
    description: Type.String(),
    impact: StringEnum(["low", "medium", "high", "blocking"] as const),
    affectedUnits: Type.Optional(Type.Array(Type.String())),
  }),
  async execute(id, params, signal, onUpdate, ctx) {
    // Add to WORK_UNITS.md Discovered Gaps section
    // Update affected unit scopes
    // Notify if blocking
  },
});
```

## Session Persistence

State survives session restart via `pi.appendEntry()`:

```typescript
// On state change
pi.appendEntry("float-loop", {
  track: "search-work",
  unit: "2.1",
  status: "in_progress",
  entryChecklist: { preconditions: true, classify: false },
  handoffPending: false,
});

// On session_start, restore from entries
const state = ctx.sessionManager
  .getEntries()
  .filter(e => e.type === "custom" && e.customType === "float-loop")
  .pop()?.data;
```

## File Structure

```
.pi/extensions/float-loop/
├── index.ts              # Main extension entry
├── track.ts              # Track data structures
├── unit.ts               # Unit lifecycle management
├── handoff.ts            # Handoff creation/rendering
├── sweep.ts              # Bug pattern detection
├── ui/
│   ├── status.ts         # Status bar integration
│   ├── widget.ts         # Unit progress widget
│   ├── track-selector.ts # Track selection overlay
│   └── handoff-viewer.ts # Handoff message renderer
├── persistence/
│   ├── session.ts        # Session entry management
│   └── files.ts          # .float/work/ file operations
└── templates/
    ├── STATE.md          # Track state template
    ├── WORK_UNITS.md     # Work units template
    ├── ARCHITECTURE.md   # Architecture template
    ├── AGENT_PROMPT.md   # Agent prompt template
    └── handoff.md        # Handoff template
```

## Migration from Claude Code

### What changes:

| Claude Code | Pi Extension |
|-------------|--------------|
| `/floatty:float-loop <track>` | `/track <track>` |
| Manual STATE.md reading | Auto-injected into context |
| File-based handoffs | File + custom message renderer |
| Ad-hoc sweep/gate | Integrated tools with UI feedback |
| No visual progress | Status bar + widget |
| Session loss on restart | `pi.appendEntry()` persistence |

### What stays:

- `.float/work/<track>/` directory structure
- Markdown-based STATE.md, WORK_UNITS.md
- Handoff document format
- Unit entry/exit protocols
- Validation checklists

## Usage Flow

### Starting a new track:
```
user: /track search-refactor
pi: New track "search-refactor". Size? (small/medium/large)
user: medium
pi: Bootstrapped. What's the goal?
user: Refactor search to use new indexing pipeline
pi: [creates files, opens editor for ARCHITECTURE.md]
```

### Daily work session:
```
user: /track search-refactor
pi: [restores state, shows widget]
   🔥 search-refactor │ Unit 2.1 │ Entry incomplete

pi: Unit 2.1: "Index schema migration"
   Entry checklist:
   ☐ Read handoff from Unit 2.0
   ☐ Verify migration scripts exist

user: [does work]
pi: [on agent_end] Unit work complete. Write handoff?
user: Yes
pi: [opens handoff editor with template]
```

### Zero-context restart:
```
[new session, no context]
user: /track search-refactor
pi: [reads session entries, restores state]
   🔥 search-refactor │ Unit 2.1 │ In Progress
   
   Resuming: Schema migration in progress.
   Last: Verified migration scripts exist.
   
   Read handoff? [Y/n]
```

## Open Questions

1. **Branch awareness**: Should the extension track git branch per track?
2. **Multi-track**: Should multiple tracks be active simultaneously?
3. **Team sharing**: How to share handoffs in team environments?
4. **Linear integration**: Connect work units to Linear issues?
5. **AI-assisted planning**: Use LLM to suggest work unit breakdown?

## Next Steps

1. Create minimal viable extension with:
   - `/track` command
   - Status bar integration
   - Session persistence
   - File bootstrap

2. Add unit lifecycle:
   - `/unit` commands
   - Entry/exit checklists
   - Widget display

3. Add validation:
   - `/sweep` tool
   - `/gate` command
   - Event hook validations

4. Polish:
   - Handoff viewer
   - Track selector overlay
   - Drift detection
