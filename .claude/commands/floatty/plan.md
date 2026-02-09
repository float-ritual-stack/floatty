---
description: Plan a new feature with Floatty's architecture in mind
argument-hint: <feature description or ticket reference>
---

# Floatty Feature Planning: $ARGUMENTS

Before writing any code, work through this checklist to identify risks and design decisions.

## Step 0: Mental Model Classification

First, identify what KIND of thing this is using familiar patterns:

```
Mental model check:
─────────────────────────────────────────────────────────────────
"Is this a Redux action?"              →  Handler
"Is this Redux middleware?"            →  Hook
"Is this a Redux selector?"            →  Projection
"Is this a React component?"           →  Renderer

"Is this an mIRC alias?"               →  Handler
"Is this an mIRC on EVENT?"            →  Hook

"Is this a CQRS command?"              →  Handler (write)
"Is this a CQRS query?"                →  Handler (read) or Projection

"Is this an Excel formula?"            →  filter:: / query::
"Is this an Excel chart?"              →  :::Component
```

**Classification**: ________________

See `docs/architecture/PHILOSOPHY.md` for full mental model mappings.

## Step 1: Architectural Impact Scan

Which layers does this feature touch? For each, note specific concerns:

### Frontend (SolidJS)
- [ ] **State**: New signals/stores? → Will they need HMR cleanup?
- [ ] **Reactivity**: Effects that write to Y.Doc? → Risk of update loops
- [ ] **Async**: New handlers or promises? → Need error boundaries

### Y.Doc / CRDT
- [ ] **Schema change**: New fields in blocks? → Migration story?
- [ ] **Origin tagging**: Transactions need origin for loop prevention
- [ ] **Observer**: New observers? → Track cleanup function

### Rust Backend
- [ ] **New endpoint**: Auth, error handling, response types
- [ ] **Async tasks**: Spawned tasks need join handles for shutdown
- [ ] **Broadcast**: Will this emit to WebSocket? → Capacity concerns

### Terminal / PTY
- [ ] **Lifecycle**: Survives pane re-parenting?
- [ ] **Cleanup**: Process killed on dispose?

## Step 2: The Six Patterns Checklist

For this feature, which patterns might apply?

| Pattern | Applies? | Mitigation |
|---------|----------|------------|
| 1. State transitions (flags) | | Use try/finally |
| 2. TypedArray/Buffer | | Pass array not .buffer |
| 3. Unbounded collections | | Define limit + overflow behavior |
| 4. Fire-and-forget async | | Add .catch() or await |
| 5. Silent degradation | | Fail visibly or trigger recovery |
| 6. HMR singletons | | Add dispose cleanup |

## Step 3: Symmetry / Drift Audit

**For each pattern this feature touches, grep for siblings.**

This is the "FLO-317 check" — when you change HOW something works in one place, find every other place that does the same thing the old way. Those siblings are now latent bugs.

Run the relevant patterns from @.claude/commands/floatty/references/symmetry-check-patterns.md

| Pattern being changed | Sibling locations found | Included in plan? |
|-----------------------|------------------------|-------------------|
| | | |
| | | |

**Rule**: If siblings exist and aren't in your plan, explain why they're safe to leave alone. "It works today" is not sufficient — FLO-317 "worked today" for 6 days.

## Step 4: Data Flow Diagram

Sketch the data flow (use ASCII or describe):
```
User action → [?] → [?] → [?] → UI update
```

Identify:
- Where can this fail?
- Where does data cross async boundaries?
- Where does data cross process boundaries (IPC)?

## Step 5: Test Strategy

What's the minimum test coverage?
- [ ] Unit test for pure logic
- [ ] Integration test for Y.Doc mutations
- [ ] Manual test script for UI flows

## Step 6: Risks & Open Questions

List anything uncertain:
1.
2.
3.

---

## Output

Provide:
1. **Design summary** (2-3 sentences)
2. **Key files** to modify
3. **Risk assessment** (Low/Medium/High)
4. **Suggested implementation order**
5. **Open questions** for human decision
