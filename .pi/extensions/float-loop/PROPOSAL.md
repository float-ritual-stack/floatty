# Float Loop Extension - Design Proposal

## Summary

A pi-native implementation of your float-loop work methodology that addresses the key pain points with the Claude Code version:

1. **Visual Integration**: Status bar + widget showing current track/unit
2. **Context Injection**: Auto-injects track context into LLM prompts
3. **Session Persistence**: Survives restarts via `pi.appendEntry()`
4. **Validation Hooks**: Event-based validation before destructive operations
5. **Zero-Context Restart**: Clear entry points with `/track` command

## Key Differences from Claude Code

### What's Better

| Aspect | Claude Code | Pi Extension |
|--------|-------------|--------------|
| **Discovery** | Hidden in `.claude/commands/` | Auto-discovered, commands in help |
| **Visual State** | None | Status bar: "🔥 track │ Unit 2.1" |
| **Context Loading** | Manual STATE.md reads | Auto-injected via `before_agent_start` |
| **Persistence** | Files only | Files + session entries |
| **Validation** | Stop hooks only | Multiple event hooks |
| **UI Feedback** | Text only | Widgets, overlays, notifications |

### What Stays the Same

- Directory structure (`.float/work/<track>/`)
- File formats (STATE.md, WORK_UNITS.md, handoffs/)
- Unit entry/exit protocols
- Handoff document structure
- Philosophy of externalized state

## Usage Comparison

### Bootstrapping a Track

**Claude Code:**
```
/floatty:float-loop search-work
→ "Track size?" 
→ "What's the goal?"
→ Creates files
```

**Pi Extension:**
```
/track search-work
→ "Track size?" [overlay select]
→ "What's the goal?" [input dialog]
→ Creates files + status update
→ Widget appears showing track context
```

### Daily Work Session

**Claude Code:**
```
/floatty:float-loop search-work
→ "Reading STATE.md..."
→ "Last session was..."
→ Manual context reconstruction
```

**Pi Extension:**
```
/track search-work
→ Status bar: "🔥 search-work │ Unit 2.1"
→ Widget: Current unit + commands
→ Auto-injected: AGENT_PROMPT.md + current unit
→ If drift detected: "⚠️ Git shows commits not in STATE.md"
```

### Writing Handoffs

**Claude Code:**
```
Write handoff to .float/work/.../handoffs/unit-X.Y.md
[manually create file from template]
```

**Pi Extension:**
```
/handoff
→ Creates file with template
→ Opens in notification
→ Optionally: custom message renderer for viewing
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  USER INTERFACE LAYER                                       │
├─────────────────────────────────────────────────────────────┤
│  Status Bar    │ "🔥 track │ Unit X.Y │ 5/7"               │
│  Widget        │ Current unit, checklist, commands          │
│  Overlay       │ Track selector, unit detail, handoff view  │
│  Commands      │ /track, /unit, /handoff, /sweep, /gate     │
└─────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────┐
│  EXTENSION CORE                                             │
├─────────────────────────────────────────────────────────────┤
│  State Machine                                              │
│  ├─ TrackRegistry: Map of all tracks                        │
│  ├─ ActiveTrack: Currently loaded track                     │
│  └─ CurrentUnit: Unit in progress                           │
│                                                             │
│  Persistence                                                │
│  ├─ File: .float/work/<track>/*.md                          │
│  └─ Session: pi.appendEntry() for runtime state             │
└─────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────┐
│  EVENT HOOKS                                                │
├─────────────────────────────────────────────────────────────┤
│  session_start       │ Restore active track, check drift    │
│  before_agent_start  │ Inject AGENT_PROMPT + unit context   │
│  tool_call           │ Block writes without entry checklist │
│  agent_end           │ Prompt for handoff if work done      │
│  session_shutdown    │ Save state, commit reminder          │
└─────────────────────────────────────────────────────────────┘
```

## Files Created

```
.pi/extensions/float-loop/
├── index.ts              # MVP implementation
├── DESIGN.md             # Full design spec
├── README.md             # Usage docs
├── PROPOSAL.md           # This file
└── ui/
    └── unit-selector.ts  # Example advanced UI
```

## Testing the MVP

```bash
cd /Users/evan/projects/_float/float-substrate/floatty

# Test with manual extension load:
pi -e .pi/extensions/float-loop/index.ts

# Then in pi:
/track test-feature
# → Select "small"
# → Enter "Test the float loop extension"
# → Check status bar shows "🔥 test-feature │ planning"
# → Check .float/work/test-feature/ exists with STATE.md, WORK_UNITS.md

/track-clear
# → Status bar clears

# In new session (to test persistence):
/track test-feature
# → Should restore state from previous session
```

## Future Enhancements

### Phase 2: Unit Lifecycle
- `/unit next` - Auto-advance to next incomplete unit
- Entry/exit checklist widget with interactive checkboxes
- Progress tracking (% complete across all units)
- Unit dependency validation

### Phase 3: Validation
- `/sweep` with pattern detection from `.claude/rules/`
- `/gate` phase gate checklist
- Drift detection: compare git log with STATE.md session log
- Pre-commit validation hooks

### Phase 4: Advanced UI
- Track selector overlay (similar to `/tree`)
- Handoff viewer with collapsible sections
- Unit timeline visualization
- Decision log browser

### Phase 5: Integrations
- Linear issue linking (`/track FLO-123`)
- Git branch per track
- PR checklist generation
- Team handoff sharing

## Why This Works Better

1. **Visibility**: Status bar means you always know what track you're on
2. **Context**: Auto-injection means no "what were we doing?" moments
3. **Validation**: Event hooks catch protocol violations before they happen
4. **Resumability**: Session + files means you can restart anywhere
5. **Discoverability**: Commands are just there, no need to know about `.claude/commands/`

## Open Questions

1. Should `/track` auto-create if not exists, or require explicit bootstrap?
2. Should we track git branch per track?
3. How aggressive should validation be? (block vs warn)
4. Should handoffs be auto-committed?
5. Integration with pi's task-board tickets?

## Next Steps

1. Test the MVP implementation
2. Add validation hooks (`tool_call` blocking)
3. Implement `/sweep` with actual pattern detection
4. Add entry/exit checklist widget
5. Drift detection

The MVP is functional now - give it a try with `pi -e .pi/extensions/float-loop/index.ts`!
