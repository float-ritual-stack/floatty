# Float Loop Extension for pi

Work track orchestration with zero-context restart. A pi-native implementation of the float-loop methodology.

## Installation

```bash
# Extension is auto-discovered from .pi/extensions/
# No installation needed - just ensure the directory exists

# Or load manually for testing:
cd /Users/evan/projects/_float/float-substrate/floatty
pi -e .pi/extensions/float-loop/index.ts
```

## Commands

| Command | Description |
|---------|-------------|
| `/fl-track [name]` | Enter track (with arg) or browse (no arg) |
| `/fl-tracks` | Show all tracks with status |
| `/fl-unit [current\|list]` | Show current unit or list all units |
| `/fl-handoff [list]` | Create or list handoffs |
| `/fl-sweep` | Run bug pattern sweep |
| `/fl-track-clear` | Clear active track |
| `/fl-demo [pattern]` | UI kitchen sink demo (dialogs, widgets, overlays) |

## Quick Start

### 1. Browse or create tracks:
```
/fl-tracks
→ Shows all tracks with status and current unit

/fl-track
→ Interactive selector showing all tracks
→ Select existing or create new

/fl-track search-refactor
→ Enter existing or bootstrap new
→ "Track size?" [small/medium/large]
→ "What's the goal?"
→ Creates .float/work/search-refactor/ with STATE.md, WORK_UNITS.md
```

### 2. Work session:
```
/fl-track search-refactor
→ Status bar: "🔥 search-refactor │ planning"
→ Widget shows current context
→ AGENT_PROMPT.md auto-injected into LLM context
```

### 3. Write handoff:
```
/fl-handoff
→ Creates .float/work/search-refactor/handoffs/unit-{X.Y}-{date}.md
```

### 4. Resume later:
```
/fl-track search-refactor
→ Restores from session state
→ Shows where you left off
```

### 5. UI Demo (Kitchen Sink):
```
/fl-demo
→ Runs through all UI patterns:
  - Notifications (info/warning/error)
  - Widgets (above/below editor)
  - Dialogs (select/confirm/input/editor)
  - Custom components (select/settings)
  - Overlays (center/right/top-left)
  - Theme colors showcase

/fl-demo dialogs
→ Just the dialog patterns

/fl-demo widgets
→ Just the widget patterns
```

## File Structure

```
.float/work/<track-name>/
├── STATE.md              # Current position, session log
├── WORK_UNITS.md         # Unit definitions
├── ARCHITECTURE.md       # Context (medium/large tracks)
├── AGENT_PROMPT.md       # Session protocol
└── handoffs/
    └── unit-{X.Y}-{status}.md
```

## Session Persistence

State survives restart via `pi.appendEntry()`:
- Active track
- Current unit
- Track registry

No need to re-explain context on new sessions.

## Features

### Tab Completion
Type `/fl-track sea<TAB>` to auto-complete track names from existing tracks.

### Track Browser
Run `/fl-track` without arguments (or `/fl-tracks`) to see all tracks with their current status and unit.

### Auto-Triggers
- **Sweep**: Auto-runs when code changes on `agent_end`
- **Context**: Auto-injects track context on every turn
- **Nudges**: Classify/arch-review prompts when writing new files

## vs Claude Code Float-Loop

| Feature | Claude Code | Pi Extension |
|---------|-------------|--------------|
| Command | `/floatty:float-loop <track>` | `/fl-track <track>` |
| Status | None | Status bar + widget |
| Context | Manual read | Auto-injected |
| Persistence | Files only | Files + session |
| Validation | Manual | Event hooks |
| Track Browser | None | `/fl-tracks` or `/fl-track` |

## Roadmap

- [x] Track bootstrap
- [x] Session persistence
- [x] Status bar integration
- [x] Context injection
- [x] Auto-sweep on agent_end
- [x] Classify/arch-review nudges
- [x] LLM tools (gap, classify)
- [ ] `/fl-unit next` with auto-progression
- [ ] Entry/exit checklist widget
- [ ] `/fl-gate` phase validation
- [ ] Drift detection (git vs STATE.md)
- [ ] Handoff viewer with custom renderer
- [ ] Track selector overlay
