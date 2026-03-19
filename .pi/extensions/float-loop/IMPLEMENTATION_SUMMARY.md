# Float Loop Extension: Implementation Summary

## What This Is

An event-driven work tracking system for pi that eliminates the "remember to run the command" problem. Instead of Evan manually invoking `/sweep`, `/classify`, etc., the system triggers them at workflow boundaries.

## Current State: MVP with Event Triggers

### ✅ Implemented

| Feature | How It Works |
|---------|---------------|
| `/track <name>` | Enter existing track or bootstrap new (small/medium/large) |
| Status bar | `🔥 track-name │ unit-id` always visible |
| Widget | Track context above editor |
| Context injection | Auto-injects on `before_agent_start` (~200 tokens) |
| Session persistence | Survives restart via `pi.appendEntry()` |
| **Auto-sweep** | Runs on `agent_end` if code changed |
| **Classify nudge** | Notification when writing new files |
| **Arch-review nudge** | Notification when writing to handlers/hooks/projections |
| **Gate integration** | Runs before `/handoff` if code changed |
| **Gap tool** | LLM-callable: `float_loop_gap` |
| **Classify tool** | LLM-callable: `float_loop_classify` |

### 🔄 Event Triggers (Automatic)

```
session_start
  └── Restore active track, update UI

before_agent_start  
  └── Inject track context block (hidden from user)

tool_call (write)
  ├── Track file in session log
  ├── If new file → nudge classify
  └── If arch path → nudge arch-review

tool_call (edit)
  └── Track file in session log

tool_call (bash)
  └── If test command → mark testsRun

agent_end
  ├── If code changed and !sweepRun → auto-sweep
  └── If code changed and !handoffWritten → nudge handoff
```

## Usage

### Start a Track
```
/track search-refactor
→ "Track size?" [select]
→ "What's the goal?" [input]
→ Bootstraps files, shows status bar
```

### Work Session
```
# Context auto-injected every turn:
[FLOAT LOOP: search-refactor | Unit 2.1 | In Progress]
Current: Enumeration endpoints
Last: Fixed metadata round-trip
Protocol: Entry → Implementation → Exit → Handoff

# Write a new file:
→ Notification: "New file: src/lib/handlers/search.ts. Classify this feature?"

# Agent discovers a gap:
→ Calls float_loop_gap tool
→ Gap auto-documented in WORK_UNITS.md
→ Notification appears, work continues

# End session with code changes:
→ Auto-sweep runs
→ If findings: "Sweep found 3 issues. Run /sweep for details."
→ Notification: "Code changed. Write handoff when ready: /handoff"
```

### Write Handoff
```
/handoff
→ If code changed and gate not run → "Run quick check?"
→ Creates handoffs/unit-{X.Y}-{date}.md from template
```

### LLM Tools

The agent can invoke these during work:

```typescript
// Document a discovered gap
float_loop_gap({
  description: "YDocStore lacks block-level mutation methods",
  impact: "blocking",
  discoveredDuring: "Unit 2.1",
  suggestedResolution: "Add insert_block, delete_block methods"
})

// Classify a feature
float_loop_classify({
  featureDescription: "Terminal command execution",
  whoInitiates: "user",
  ownsBlock: true,
  whenRuns: "explicit",
  criticalPath: true,
  needsOtherHooks: false
})
// Returns: "HANDLER: User-initiated, owns block transformation"
```

## File Structure

```
.pi/extensions/float-loop/
├── index.ts                    # Main extension (functional)
├── DESIGN.md                   # Architecture spec
├── EVENT_DRIVEN_DESIGN.md      # Trigger mapping
├── IMPLEMENTATION_SUMMARY.md   # This file
├── README.md                   # Usage guide
└── ui/
    └── unit-selector.ts        # Future: interactive checklist
```

## Configuration

Future: Add `.pi/extensions/float-loop/config.json`:

```json
{
  "autoSweep": true,
  "classifyNudge": true,
  "archReviewNudge": true,
  "gateEnforcement": "warn",
  "maxContextTokens": 200
}
```

## Comparison: Claude Code vs Pi Extension

| Aspect | Claude Code | Pi Extension |
|--------|-------------|--------------|
| **Enter track** | `/floatty:float-loop track` | `/track track` |
| **Context load** | Manual STATE.md reads | Auto-injected every turn |
| **Sweep** | Remember to run `/sweep` | Auto-runs on agent_end |
| **Classify** | Remember to run `/classify` | Nudges on new file write |
| **Gap capture** | Stop work, run `/gap` | Tool call during work |
| **Visual state** | None | Status bar + widget |
| **Persistence** | Files only | Files + session |

## Testing

```bash
cd /Users/evan/projects/_float/float-substrate/floatty

# Load extension manually:
pi -e .pi/extensions/float-loop/index.ts

# Test flow:
/track test-event-driven
→ small
→ "Test the event-driven triggers"

# Write a new file in pi:
→ Should see classify nudge

# Write to src/lib/handlers/foo.ts:
→ Should see arch-review nudge

# Make code changes, then stop:
→ Should see auto-sweep run
→ Should see handoff nudge
```

## Next Steps

### Phase 2: Enhanced Validation
- [ ] Entry checklist enforcement (block/warn on write if incomplete)
- [ ] Exit checklist widget with interactive checkboxes
- [ ] Drift detection (git log vs STATE.md session log)
- [ ] `/gate` full implementation with all checks

### Phase 3: Advanced Tools
- [ ] `float_loop_arch_check` tool
- [ ] Pattern matcher for sweep (not just grep)
- [ ] Smart nudges (don't nudge if already done this session)

### Phase 4: UI Polish
- [ ] Track selector overlay
- [ ] Unit progress visualization
- [ ] Handoff viewer with collapsible sections

## Key Design Decisions

1. **SILENT context injection**: User doesn't see it, but LLM gets track context every turn
2. **NUDGE for classify/arch-review**: Notification only, doesn't block flow
3. **AUTO-RUN for sweep**: Fast enough to not block, reports findings
4. **BLOCK for gate**: Handoff requires gate pass (or explicit override)
5. **LLM tools for gap/classify**: Agent invokes during work, no context switch

## The AuADHD Factor

The entire design assumes:
- Working memory is unreliable → System remembers state
- Context switching is expensive → Triggers happen at natural boundaries
- Visual reminders help → Status bar always visible
- Momentum matters → No mandatory stops mid-flow

Result: Evan focuses on the work. The system handles the protocol.
