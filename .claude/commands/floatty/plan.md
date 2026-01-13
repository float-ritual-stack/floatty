---
description: Plan a new feature with Floatty's architecture in mind
argument-hint: <feature description or ticket reference>
---

# Floatty Feature Planning: $ARGUMENTS

Before writing any code, work through this checklist to identify risks and design decisions.

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

## Step 3: Data Flow Diagram

Sketch the data flow (use ASCII or describe):
```
User action → [?] → [?] → [?] → UI update
```

Identify:
- Where can this fail?
- Where does data cross async boundaries?
- Where does data cross process boundaries (IPC)?

## Step 4: Test Strategy

What's the minimum test coverage?
- [ ] Unit test for pure logic
- [ ] Integration test for Y.Doc mutations
- [ ] Manual test script for UI flows

## Step 5: Risks & Open Questions

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
